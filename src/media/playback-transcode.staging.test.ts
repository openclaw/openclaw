import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import type { TempWorkspace, TempWorkspaceOptions } from "@openclaw/fs-safe/temp";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  settlePlaybackTranscodeJobsForTest,
  waitForPlaybackTranscodeJobsForTest,
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
vi.mock("./media-probe.js", () => ({
  probePlaybackMediaFileDescriptor: vi.fn(async () => ({
    durationMs: 1000,
    audioCodec: "pcm_s16le",
    audioStreamIndex: 0,
  })),
}));

let playback: typeof import("./playback-transcode.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  vi.resetModules();
  tempHome = await createTempHomeEnv("openclaw-playback-staging-");
  playback = await import("./playback-transcode.js");
});

afterAll(async () => {
  try {
    await tempHome.restore();
  } finally {
    vi.doUnmock("./ffmpeg-exec.js");
    vi.doUnmock("./media-probe.js");
    vi.doUnmock("@openclaw/fs-safe/temp");
    vi.resetModules();
  }
});

beforeEach(() => {
  runFfmpeg.mockReset();
  observeWorkspaceRoot.mockReset();
});

async function createSource(fileName: string, contents: string | Buffer) {
  const fixturePath = path.join(tempHome.home, fileName);
  await fs.writeFile(fixturePath, contents);
  const sourcePath = await fs.realpath(fixturePath);
  return { sourcePath, sourceStat: await fs.stat(sourcePath) };
}

describe("playback input staging", () => {
  it("passes every staged input byte to ffmpeg before publishing the rendition", async () => {
    const contents = Buffer.alloc(1024 * 1024 + 19);
    for (let index = 0; index < contents.length; index += 1) {
      contents[index] = index % 251;
    }
    const source = await createSource("complete-input.caf", contents);
    let inputPath: string | undefined;
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      inputPath = args[args.indexOf("-i") + 1];
      expect(inputPath).toBeDefined();
      expect(await fs.readFile(inputPath!)).toEqual(contents);
      await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
      return "";
    });
    try {
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
        probe: { durationMs: 1000, audioStreamIndex: 0 },
      };
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
      await waitForPlaybackTranscodeJobsForTest("all");
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(await playback.resolvePlaybackTranscode(params)).toMatchObject({
        kind: "transcoded",
        contentType: "audio/mp4",
      });
      await expect(fs.stat(inputPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it.each(["grow", "truncate", "rewrite", "replace"] as const)(
    "rejects a source that changes after open via %s before starting ffmpeg",
    async (change) => {
      const source = await createSource(`changed-${change}.caf`, "stable-source");
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
            await fs.writeFile(filePath, "edited-source");
            await fs.utimes(
              filePath,
              source.sourceStat.atime,
              new Date(source.sourceStat.mtimeMs + 2000),
            );
            expect((await fs.stat(filePath)).mtimeMs).not.toBe(source.sourceStat.mtimeMs);
          } else {
            await fs.rename(filePath, `${filePath}.old`);
            await fs.writeFile(filePath, "stable-source");
          }
        },
      });
      try {
        const params = {
          ...source,
          mimeType: "audio/x-caf",
          kind: "audio" as const,
          probe: { durationMs: 1000, audioStreamIndex: 0 },
        };
        expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
        await expect(waitForPlaybackTranscodeJobsForTest("all")).rejects.toThrow(
          change === "grow" ? /exceeds limit/ : /changed|mismatch/,
        );
        expect(changed).toBe(true);
        expect(runFfmpeg).not.toHaveBeenCalled();
        expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "fallback" });
      } finally {
        __setFsSafeTestHooksForTest(undefined);
        await settlePlaybackTranscodeJobsForTest();
      }
    },
  );

  it("rejects a moved input that no longer names its staging descriptor", async () => {
    const source = await createSource("replaced-staging.caf", "stable-source");
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
        if (args[0] === ".input.caf.stage" && args[1] === "input.caf") {
          // Observe the producer's handle without opening another one that would pin the inode.
          writerWasOpenAtMove = writer !== undefined && writer.fd >= 0;
          await move(...args);
          const inputPath = workspace.path(args[1]);
          await fs.unlink(inputPath);
          await fs.writeFile(inputPath, "stable-source", { mode: 0o600 });
          replaced = true;
        } else {
          await move(...args);
        }
      };
    });
    try {
      expect(
        await playback.resolvePlaybackTranscode({
          ...source,
          mimeType: "audio/x-caf",
          kind: "audio",
          probe: { durationMs: 1000, audioStreamIndex: 0 },
        }),
      ).toEqual({ kind: "preparing" });
      const outcome = await waitForPlaybackTranscodeJobsForTest("all").then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(writerWasOpenAtMove).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: expect.objectContaining({ message: expect.stringMatching(/changed|mismatch/) }),
      });
      expect(replaced).toBe(true);
      expect(runFfmpeg).not.toHaveBeenCalled();
      expect(writer?.fd).toBe(-1);
    } finally {
      observeWorkspaceRoot.mockReset();
      await settlePlaybackTranscodeJobsForTest();
    }
  });

  it("does not publish a cache entry when workspace cleanup fails", async () => {
    const source = await createSource("cleanup-failed.caf", "stable-source");
    const cleanupError = new Error("synthetic workspace cleanup failure");
    let quarantine: string | undefined;
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
    try {
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
        probe: { durationMs: 1000, audioStreamIndex: 0 },
      };
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "preparing" });
      await expect(waitForPlaybackTranscodeJobsForTest("all")).rejects.toBe(cleanupError);
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(quarantine).toBeDefined();
      expect(await playback.resolvePlaybackTranscode(params)).toEqual({ kind: "fallback" });
    } finally {
      __setFsSafeTestHooksForTest(undefined);
      await settlePlaybackTranscodeJobsForTest();
      if (quarantine) {
        await fs.rm(quarantine, { recursive: true, force: true });
      }
    }
  });
});
