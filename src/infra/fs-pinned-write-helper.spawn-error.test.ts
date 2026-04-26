import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const spawnMock = vi.hoisted(() => vi.fn());

type MockChild = EventEmitter & {
  stdout: PassThrough & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: PassThrough & { setEncoding: ReturnType<typeof vi.fn> };
  stdin?: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createSpawnErrorChild(message = "spawn boom"): ChildProcess {
  const child = new EventEmitter() as MockChild;
  child.stdout = Object.assign(new PassThrough(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new PassThrough(), { setEncoding: vi.fn() });
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  process.nextTick(() => {
    child.emit("error", Object.assign(new Error(message), { code: "ENOENT" }));
    child.emit("close", 1, null);
  });
  return child as unknown as ChildProcess;
}

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
  spawnMock.mockReset();
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("fs pinned helper spawn failures", () => {
  let runPinnedWriteHelper: typeof import("./fs-pinned-write-helper.js").runPinnedWriteHelper;
  let runPinnedUnlinkHelper: typeof import("./fs-pinned-write-helper.js").runPinnedUnlinkHelper;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: (...args: Parameters<typeof actual.spawn>) => spawnMock(...args),
      };
    });
    ({ runPinnedWriteHelper, runPinnedUnlinkHelper } = await import("./fs-pinned-write-helper.js"));
  });

  it("fails closed when the pinned write helper cannot be spawned", async () => {
    spawnMock.mockImplementation(() => createSpawnErrorChild());
    const root = await tempDirs.make("openclaw-fs-pinned-root-");

    await expect(
      runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "nested",
        basename: "note.txt",
        mkdir: true,
        mode: 0o600,
        input: {
          kind: "buffer",
          data: "hello",
        },
      }),
    ).rejects.toThrow(/failed to start: spawn boom/i);

    await expect(fs.readFile(path.join(root, "nested", "note.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns a normal error when the pinned unlink helper cannot be spawned", async () => {
    spawnMock.mockImplementation(() => createSpawnErrorChild("python missing"));
    const root = await tempDirs.make("openclaw-fs-pinned-root-");
    const target = path.join(root, "note.txt");
    await fs.writeFile(target, "hello", "utf8");

    await expect(
      runPinnedUnlinkHelper({
        rootPath: root,
        relativeParentPath: "",
        basename: "note.txt",
      }),
    ).rejects.toThrow(/failed to start: python missing/i);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("hello");
  });
});
