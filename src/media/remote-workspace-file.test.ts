import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createBoundedRemoteFileReader } from "./remote-workspace-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
type Execute = Parameters<typeof createBoundedRemoteFileReader>[0]["execute"];
afterEach(() => vi.restoreAllMocks());

function fixture(outputBytesCap = 64 * 1024) {
  const workspaceRoot = tempDirs.make("remote-workspace-file-");
  let active = true;
  const execute = vi.fn<Execute>(async (argv, options) => {
    const result = await execFileAsync(process.execPath, argv.slice(1), {
      maxBuffer: outputBytesCap,
      signal: options.signal,
    });
    return result.stdout;
  });
  const read = createBoundedRemoteFileReader({
    outputBytesCap,
    execute,
    assertCurrent: () => {
      if (!active) {
        throw new Error("Remote owner closed");
      }
    },
  });
  return {
    workspaceRoot,
    execute,
    read,
    revoke: () => {
      active = false;
    },
  };
}

function chunk(bytes: Buffer, size = bytes.length, revision = "same-file") {
  return JSON.stringify({ dataBase64: bytes.toString("base64"), size, revision });
}

describe("bounded remote workspace files", () => {
  it.each([64 * 1024, 1024 * 1024])(
    "transfers exact bytes within the %i-byte transport cap",
    async (cap) => {
      const f = fixture(cap);
      const file = path.join(f.workspaceRoot, "report $(never-execute).bin");
      const expected = Buffer.alloc(cap / 2 + 17, 0x61);
      await fs.writeFile(file, expected);
      expect(
        await f.read({ path: file, workspaceRoot: f.workspaceRoot, maxBytes: expected.length }),
      ).toEqual(expected);
      expect(f.execute.mock.calls.length).toBeGreaterThan(1);
      for (const [argv] of f.execute.mock.calls) {
        expect(argv.slice(0, 2)).toEqual(["node", "-e"]);
      }
    },
  );

  it("rejects oversized remote files before allocating or transferring bytes", async () => {
    const f = fixture();
    const file = path.join(f.workspaceRoot, "oversized.txt");
    await fs.writeFile(file, "too many bytes");
    await expect(f.read({ path: file, maxBytes: 3 })).rejects.toThrow("limit of 3 bytes");
  });

  it.each(["leaf", "parent"] as const)(
    "rejects %s symlinks escaping the workspace",
    async (kind) => {
      const f = fixture();
      const external = tempDirs.make("remote-workspace-outside-");
      const file = path.join(external, "private.txt");
      await fs.writeFile(file, "outside bytes");
      const link = path.join(f.workspaceRoot, "link");
      await fs.symlink(kind === "leaf" ? file : external, link);
      await expect(
        f.read({
          path: kind === "leaf" ? link : path.join(link, "private.txt"),
          workspaceRoot: f.workspaceRoot,
          maxBytes: 64,
        }),
      ).rejects.toThrow(
        kind === "leaf" ? "symbolic links are not allowed" : "file escapes remote workspace",
      );
    },
  );

  it.each([
    { timeoutMs: 500, elapsedMs: 100.25, budgets: [500, 399], expires: false },
    { timeoutMs: 500, elapsedMs: 500.25, budgets: [500], expires: true },
    { timeoutMs: undefined, elapsedMs: 500.25, budgets: [undefined, undefined], expires: false },
  ])("retains the monotonic transfer deadline ($timeoutMs, $elapsedMs)", async (test) => {
    const f = fixture();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const bytes = Buffer.alloc(32 * 1024 + 17, 0x62);
    f.execute.mockImplementation(async (argv) => {
      const offset = Number(argv[6]);
      elapsed = test.elapsedMs;
      return chunk(bytes.subarray(offset, offset + 32 * 1024), bytes.length);
    });
    const transfer = f.read({
      path: "/remote/file",
      maxBytes: bytes.length,
      timeoutMs: test.timeoutMs,
    });
    if (test.expires) {
      await expect(transfer).rejects.toThrow("timed out");
    } else {
      expect(await transfer).toEqual(bytes);
    }
    expect(f.execute.mock.calls.map(([, options]) => options.timeoutMs)).toEqual(test.budgets);
  });

  it.each(["size", "revision"] as const)("rejects changed %s between chunks", async (change) => {
    const f = fixture();
    const bytes = Buffer.alloc(32 * 1024);
    f.execute.mockResolvedValueOnce(chunk(bytes, bytes.length + 1));
    f.execute.mockResolvedValueOnce(
      chunk(
        Buffer.from("x"),
        bytes.length + (change === "size" ? 2 : 1),
        change === "revision" ? "replacement" : "same-file",
      ),
    );
    await expect(f.read({ path: "/remote/file", maxBytes: bytes.length + 2 })).rejects.toThrow(
      "changed during chunked transfer",
    );
  });

  it.each([
    "not JSON",
    JSON.stringify({ dataBase64: "!", size: 1, revision: "file" }),
    JSON.stringify({ dataBase64: "YQ==", size: 2, revision: "file" }),
    JSON.stringify({ dataBase64: "YQ==", size: 100, revision: "file" }),
  ])("rejects malformed or oversized chunk data (%s)", async (stdout) => {
    const f = fixture();
    f.execute.mockResolvedValue(stdout);
    await expect(f.read({ path: "/remote/file", maxBytes: 3 })).rejects.toThrow(
      /invalid|oversized/,
    );
  });

  it("rejects command output exceeding its transport cap", async () => {
    const f = fixture();
    f.execute.mockResolvedValue("x".repeat(64 * 1024 + 1));
    await expect(f.read({ path: "/remote/file", maxBytes: 1 })).rejects.toThrow(
      "command output cap",
    );
  });

  it.each(["before", "during"] as const)(
    "discards bytes when authority closes %s the read",
    async (when) => {
      const f = fixture();
      f.execute.mockImplementation(async () => {
        f.revoke();
        return chunk(Buffer.from("private"));
      });
      if (when === "before") {
        f.revoke();
      }
      await expect(f.read({ path: "/remote/file", maxBytes: 20 })).rejects.toThrow(
        "Remote owner closed",
      );
      expect(f.execute).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    },
  );

  it.each(["before", "during"] as const)("honors cancellation %s the read", async (when) => {
    const f = fixture();
    const abort = new AbortController();
    f.execute.mockImplementation(async () => {
      abort.abort(new Error("Read cancelled"));
      return chunk(Buffer.from("late"));
    });
    if (when === "before") {
      abort.abort(new Error("Read cancelled"));
    }
    await expect(
      f.read({ path: "/remote/file", maxBytes: 20, signal: abort.signal }),
    ).rejects.toThrow("Read cancelled");
    expect(f.execute).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  });
});
