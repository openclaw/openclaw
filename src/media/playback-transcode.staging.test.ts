import "../test-utils/prepare-compiled-subprocesses.js";
import fs, { type FileHandle } from "node:fs/promises";
import type { Root } from "@openclaw/fs-safe";
import type { TempWorkspace, TempWorkspaceOptions } from "@openclaw/fs-safe/temp";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePlaybackFixture,
  settlePlaybackTranscodeJobsForTest as settleJobs,
  waitForPlaybackTranscodeJobsForTest as waitForJobs,
} from "./playback-transcode.test-support.js";

const { runFfmpeg, observeWorkspaceRoot } = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
  observeWorkspaceRoot: vi.fn<(root: Root, workspace: TempWorkspace) => void>(),
}));
vi.mock("@openclaw/fs-safe/temp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/temp")>();
  return {
    ...actual,
    withTempWorkspace: <T>(
      options: TempWorkspaceOptions,
      run: (workspace: TempWorkspace) => Promise<T>,
    ) =>
      actual.withTempWorkspace(options, async (workspace) => {
        const getRoot = workspace.store.root.bind(workspace.store);
        workspace.store.root = async () => {
          const root = await getRoot();
          observeWorkspaceRoot(root, workspace);
          return root;
        };
        return run(workspace);
      }),
  };
});
vi.mock("./ffmpeg-exec.js", () => ({ runFfmpeg }));
vi.mock("./media-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-probe.js")>()),
  probePlaybackMediaFileDescriptor: vi.fn(async () => ({
    durationMs: 1000,
    audioCodec: "pcm_s16le",
    audioStreamIndex: 0,
  })),
}));

const fixture = usePlaybackFixture("openclaw-playback-staging-", [
  "./ffmpeg-exec.js",
  "./media-probe.js",
  "@openclaw/fs-safe/temp",
]);
const { resolveTranscode, resolveMetadata } = fixture;

let quarantine: string | undefined;
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  observeWorkspaceRoot.mockReset();
  await settleJobs();
  if (quarantine) {
    await fs.rm(quarantine, { recursive: true, force: true });
  }
  quarantine = undefined;
});

beforeEach(() => {
  runFfmpeg.mockReset();
});

async function createSource(
  fileName: string,
  contents: Parameters<typeof fixture.createSource>[1] = "stable-source",
) {
  return {
    ...(await fixture.createSource(fileName, contents)),
    mimeType: "audio/x-caf",
    kind: "audio" as const,
  };
}

async function transcode(source: Awaited<ReturnType<typeof createSource>>) {
  expect(await resolveTranscode(source)).toEqual({ kind: "preparing" });
  return await waitForJobs("all");
}

describe("playback input staging", () => {
  it("passes every staged input byte to ffmpeg before publishing the rendition", async () => {
    const contents = Buffer.alloc(1024 * 1024 + 19).map((_, index) => index % 251);
    const source = await createSource("complete-input.caf", contents);
    let inputPath: string | undefined;
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      inputPath = args[args.indexOf("-i") + 1];
      expect(inputPath).toBeDefined();
      expect(await fs.readFile(inputPath!), "complete staged ffmpeg input").toEqual(contents);
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    await transcode(source);
    expect(runFfmpeg).toHaveBeenCalledOnce();
    expect(await resolveTranscode(source)).toMatchObject({
      kind: "transcoded",
      contentType: "audio/mp4",
    });
    await expect(fs.stat(inputPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["grow", "truncate", "rewrite", "replace"] as const)(
    "rejects a source that changes after open via %s before starting ffmpeg",
    async (change) => {
      const source = await createSource(`changed-${change}.caf`);
      await expect(resolveMetadata(source)).resolves.toMatchObject({
        playback: "transcode",
      });
      let changed = false;
      __setFsSafeTestHooksForTest({
        afterOpenedPathIdentityCheck: async (filePath) => {
          if (filePath !== source.sourcePath || changed) {
            return;
          }
          changed = true;
          if (change === "grow") {
            await fs.appendFile(filePath, "growth");
          } else if (change === "truncate") {
            await fs.truncate(filePath, 1);
          } else if (change === "rewrite") {
            const beforeRewrite = await fs.stat(filePath);
            await fs.writeFile(filePath, "edited-source");
            await fs.utimes(
              filePath,
              beforeRewrite.atime,
              new Date(source.sourceStat.mtimeMs + 2000),
            );
            expect((await fs.stat(filePath)).mtimeMs).not.toBe(source.sourceStat.mtimeMs);
          } else {
            await fs.rename(filePath, `${filePath}.old`);
            await fs.writeFile(filePath, "stable-source");
          }
        },
      });
      await expect(transcode(source)).rejects.toThrow(
        change === "grow" ? /exceeds limit/ : /changed|mismatch/,
      );
      expect(changed).toBe(true);
      expect(runFfmpeg).not.toHaveBeenCalled();
      expect(await resolveTranscode(source)).toEqual({ kind: "fallback" });
    },
  );

  it("rejects a moved input that no longer names its staging descriptor", async () => {
    const source = await createSource("replaced-staging.caf");
    let writer: FileHandle | undefined;
    let writerWasOpenAtMove = false;
    let replaced = false;
    observeWorkspaceRoot.mockImplementationOnce((root, workspace) => {
      const openWritable = root.openWritable.bind(root);
      const move = root.move.bind(root);
      root.openWritable = async (...args) => {
        const opened = await openWritable(...args);
        if (args[0] === ".input.caf.stage") {
          writer = opened.handle;
        }
        return opened;
      };
      root.move = async (...args) => {
        if (args[0] !== ".input.caf.stage" || args[1] !== "input.caf") {
          return await move(...args);
        }
        // Observe the producer's handle without opening another one that would pin the inode.
        writerWasOpenAtMove = writer !== undefined && writer.fd >= 0;
        await move(...args);
        const inputPath = workspace.path(args[1]);
        await fs.unlink(inputPath);
        await fs.writeFile(inputPath, "stable-source", { mode: 0o600 });
        replaced = true;
      };
    });
    await expect(transcode(source)).rejects.toMatchObject({
      message: expect.stringMatching(/changed|mismatch/),
    });
    expect([writerWasOpenAtMove, replaced, writer?.fd]).toEqual([true, true, -1]);
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("does not publish a cache entry when workspace cleanup fails", async () => {
    const source = await createSource("cleanup-failed.caf");
    const cleanupError = new Error("synthetic workspace cleanup failure");
    __setFsSafeTestHooksForTest({
      beforeTempWorkspaceNativeRemoval: (target) => {
        quarantine = target;
        throw cleanupError;
      },
    });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    await expect(transcode(source)).rejects.toBe(cleanupError);
    expect(runFfmpeg).toHaveBeenCalledOnce();
    expect(quarantine).toBeDefined();
    expect(await resolveTranscode(source)).toEqual({ kind: "fallback" });
  });
});
