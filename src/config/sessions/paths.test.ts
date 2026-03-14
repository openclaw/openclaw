import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
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

  it("rejects symlinked agents parents for custom state roots", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-custom-state-parent-link-"));
    try {
      const stateDir = path.join(tempDir, "custom-state");
      const realAgentsDir = path.join(tempDir, "outside-agents");
      const linkedAgentsDir = path.join(stateDir, "agents");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(realAgentsDir, { recursive: true });
      fs.symlinkSync(realAgentsDir, linkedAgentsDir, "dir");

      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(
        ensurePrivateSessionsDir(path.join(linkedAgentsDir, "main", "sessions")),
      ).rejects.toThrow(/must not traverse a symlink/i);
      expect(fs.existsSync(path.join(realAgentsDir, "main", "sessions"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects when the directory identity changes before chmod", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-race-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const realLstat = fsPromises.lstat.bind(fsPromises);
    const realMkdir = fsPromises.mkdir.bind(fsPromises);
    const realOpen = fsPromises.open.bind(fsPromises);
    const handleChmod = vi.fn(async () => undefined);
    const handleClose = vi.fn(async () => undefined);
    let targetLstatCalls = 0;

    vi.spyOn(fsPromises, "mkdir").mockImplementation(
      async (filePath, options) => await realMkdir(filePath, options),
    );
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (filePath) => {
      const resolved = path.resolve(String(filePath));
      if (resolved !== sessionsDir) {
        return await realLstat(filePath);
      }
      targetLstatCalls++;
      if (targetLstatCalls === 1) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (targetLstatCalls === 2) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => true,
          dev: 10,
          ino: 20,
        } as fs.Stats;
      }
      return await realLstat(filePath);
    });
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (filePath, flags) => {
      const resolved = path.resolve(String(filePath));
      if (resolved !== sessionsDir) {
        return await realOpen(filePath, flags);
      }
      return {
        stat: async () =>
          ({
            isDirectory: () => true,
            dev: 11,
            ino: 21,
          }) as fs.Stats,
        chmod: handleChmod,
        close: handleClose,
      } as unknown as fsPromises.FileHandle;
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).rejects.toThrow(
        /changed during permission update/i,
      );
      expect(open).toHaveBeenCalled();
      expect(handleChmod).not.toHaveBeenCalled();
      expect(handleClose).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("isManagedSessionsDir", () => {
  it("treats symlink-alias managed paths as managed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-symlink-alias-"));
    try {
      const realStateDir = path.join(tempDir, "real-state");
      const aliasStateDir = path.join(tempDir, "alias-state");
      const realSessionsDir = path.join(realStateDir, "agents", "main", "sessions");
      fs.mkdirSync(realSessionsDir, { recursive: true });
      fs.symlinkSync(realStateDir, aliasStateDir, "dir");

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: aliasStateDir,
      } as NodeJS.ProcessEnv;

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(realSessionsDir, env)).toBe(true);
      expect(isManagedSessionStorePath(path.join(realSessionsDir, "sessions.json"), env)).toBe(
        true,
      );
      expect(isManagedSessionTranscriptPath(path.join(realSessionsDir, "sess-1.jsonl"), env)).toBe(
        true,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
