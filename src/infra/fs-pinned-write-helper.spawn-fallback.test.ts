import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();

    setImmediate(() => {
      const error = new Error("spawn python3 ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      error.syscall = "spawn python3";
      error.path = "python3";
      child.emit("error", error);
      child.emit("close", -2, null);
    });

    return child;
  }),
}));

const { runPinnedWriteHelper } = await import("./fs-pinned-write-helper.js");

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe.runIf(process.platform !== "win32")("fs pinned write helper spawn fallback", () => {
  it("falls back to the local writer when python3 cannot spawn", async () => {
    const root = await tempDirs.make("openclaw-fs-pinned-root-");

    const identity = await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested/deeper",
      basename: "note.txt",
      mkdir: true,
      mode: 0o600,
      input: {
        kind: "buffer",
        data: "hello",
      },
    });

    await expect(
      fs.readFile(path.join(root, "nested", "deeper", "note.txt"), "utf8"),
    ).resolves.toBe("hello");
    expect(identity.dev).toBeGreaterThanOrEqual(0);
    expect(identity.ino).toBeGreaterThan(0);
  });

  it("does not consume streams before falling back after a python3 spawn failure", async () => {
    const root = await tempDirs.make("openclaw-fs-pinned-root-");

    await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "",
      basename: "stream.txt",
      mkdir: true,
      mode: 0o600,
      input: {
        kind: "stream",
        stream: Readable.from(["streamed"]),
      },
    });

    await expect(fs.readFile(path.join(root, "stream.txt"), "utf8")).resolves.toBe("streamed");
  });
});
