import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("node:fs/promises");
});

describe("ensurePrivateSessionsDir", () => {
  it("rejects when a managed parent directory is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-parent-link-"));
    try {
      const stateDir = path.join(tempDir, ".openclaw");
      const realAgentDir = path.join(tempDir, "outside-agent");
      const linkedAgentDir = path.join(stateDir, "agents", "main");
      fs.mkdirSync(path.dirname(linkedAgentDir), { recursive: true });
      fs.mkdirSync(realAgentDir, { recursive: true });
      fs.symlinkSync(realAgentDir, linkedAgentDir, "dir");

      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(path.join(linkedAgentDir, "sessions"))).rejects.toThrow(
        /must not traverse a symlink/i,
      );
      expect(fs.existsSync(path.join(realAgentDir, "sessions"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects when the directory identity changes before chmod", async () => {
    if (process.platform === "win32") {
      return;
    }

    const mkdir = vi.fn(async () => undefined);
    const lstat = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        dev: 10,
        ino: 20,
      });
    const chmod = vi.fn(async () => undefined);
    const handleChmod = vi.fn(async () => undefined);
    const handleClose = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({
      stat: async () => ({
        isDirectory: () => true,
        dev: 11,
        ino: 21,
      }),
      chmod: handleChmod,
      close: handleClose,
    }));

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const patched = {
        ...actual,
        mkdir,
        lstat,
        chmod,
        open,
      };
      return { ...patched, default: patched };
    });

    const { ensurePrivateSessionsDir } = await import("./paths.js");

    await expect(ensurePrivateSessionsDir("/tmp/openclaw-race")).rejects.toThrow(
      /changed during permission update/i,
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(chmod).not.toHaveBeenCalled();
    expect(handleChmod).not.toHaveBeenCalled();
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
