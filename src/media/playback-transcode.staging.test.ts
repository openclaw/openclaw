import "../test-utils/prepare-compiled-subprocesses.js";
import fs, { type FileHandle } from "node:fs/promises";
import type { Root } from "@openclaw/fs-safe";
import type { TempWorkspace, TempWorkspaceOptions } from "@openclaw/fs-safe/temp";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  observePlaybackSourceOpen,
  usePlaybackFixture,
  waitForPlaybackSourceCleanup,
} from "./playback-transcode.test-support.js";

const { runFfmpeg, observeWorkspaceRoot } = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
  observeWorkspaceRoot: vi.fn<(root: Root, workspace: TempWorkspace) => void>(),
}));
vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    openLocalFileSafely: (...args: Parameters<typeof actual.openLocalFileSafely>) =>
      observePlaybackSourceOpen(actual.openLocalFileSafely(...args)),
  };
});

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
  "../infra/fs-safe.js",
]);
const { resolveTranscode, resolveMetadata } = fixture;

let quarantine: string | undefined;
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  observeWorkspaceRoot.mockReset();
  await waitForPlaybackSourceCleanup();
  if (quarantine) {
    await fs.rm(quarantine, { recursive: true, force: true });
  }
  quarantine = undefined;
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
  await waitForPlaybackSourceCleanup();
  return await resolveTranscode(source);
}

it("passes every staged input byte to ffmpeg before publishing the rendition", async () => {
  const contents = Buffer.alloc(1024 * 1024 + 19).map((_, index) => index % 251);
  const source = await createSource("complete-input.caf", contents);
  let inputPath: string | undefined;
  runFfmpeg.mockImplementationOnce(async (args: string[]) => {
    inputPath = args[args.indexOf("-i") + 1];
    expect(inputPath).toBeDefined();
    expect((await fs.readFile(inputPath!)).equals(contents), "complete staged ffmpeg input").toBe(
      true,
    );
    await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
    return "";
  });
  expect(await transcode(source)).toMatchObject({
    kind: "transcoded",
    contentType: "audio/mp4",
  });
  await expect(fs.stat(inputPath!)).rejects.toMatchObject({ code: "ENOENT" });
});

const changes = {
  grow: (file: string) => fs.appendFile(file, "growth"),
  truncate: (file: string) => fs.truncate(file, 1),
  rewrite: async (file: string, mtimeMs: number) => {
    const { atime } = await fs.stat(file);
    await fs.writeFile(file, "edited-source");
    await fs.utimes(file, atime, new Date(mtimeMs + 2000));
    expect((await fs.stat(file)).mtimeMs).not.toBe(mtimeMs);
  },
  replace: async (file: string) => {
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, "stable-source");
  },
};
it.each(Object.entries(changes))(
  "falls back when the source changes after open via %s before starting ffmpeg",
  async (change, mutate) => {
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
        await mutate(filePath, source.sourceStat.mtimeMs);
      },
    });
    await expect(transcode(source)).resolves.toEqual({ kind: "fallback" });
    expect(changed).toBe(true);
    expect(runFfmpeg).not.toHaveBeenCalled();
  },
);

it("falls back when a moved input no longer names its staging descriptor", async () => {
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
  await expect(transcode(source)).resolves.toEqual({ kind: "fallback" });
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
  expect(await transcode(source)).toEqual({ kind: "fallback" });
  expect(runFfmpeg).toHaveBeenCalledOnce();
  expect(quarantine).toBeDefined();
});
