import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs/promises");
});

describe("ensurePrivateSessionsDir", () => {
  it("allows a symlinked state-root alias for managed session dirs", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-root-alias-"));
    try {
      const realStateDir = path.join(tempDir, "real-state");
      const aliasStateDir = path.join(tempDir, "alias-state");
      const aliasSessionsDir = path.join(aliasStateDir, "agents", "main", "sessions");
      fs.mkdirSync(realStateDir, { recursive: true });
      fs.symlinkSync(realStateDir, aliasStateDir, "dir");

      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(aliasSessionsDir)).resolves.toBe(
        path.resolve(aliasSessionsDir),
      );
      expect(fs.existsSync(path.join(realStateDir, "agents", "main", "sessions"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

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

  it("materializes missing managed parents before the final recursive mkdir", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-parent-pin-"));
    const stateDir = path.join(tempDir, "state");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const outsideAgentsDir = path.join(tempDir, "outside-agents");
    const realMkdir = fsPromises.mkdir.bind(fsPromises);

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(outsideAgentsDir, { recursive: true });

    vi.spyOn(fsPromises, "mkdir").mockImplementation(async (filePath, options) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === sessionsDir) {
        const agentsDir = path.join(stateDir, "agents");
        if (!fs.existsSync(agentsDir)) {
          fs.symlinkSync(outsideAgentsDir, agentsDir, "dir");
        }
      }
      return await realMkdir(filePath, options);
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).resolves.toBe(path.resolve(sessionsDir));
      expect(fs.existsSync(path.join(stateDir, "agents", "main", "sessions"))).toBe(true);
      expect(fs.existsSync(path.join(outsideAgentsDir, "main", "sessions"))).toBe(false);
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

  it("rejects when a freshly created state root changes before child mkdirs", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-root-swap-"));
    const stateDir = path.join(tempDir, "state");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const outsideStateDir = path.join(tempDir, "outside-state");
    const realMkdir = fsPromises.mkdir.bind(fsPromises);

    vi.spyOn(fsPromises, "mkdir").mockImplementation(async (filePath, options) => {
      const resolved = path.resolve(String(filePath));
      const result = await realMkdir(filePath, options);
      if (resolved === stateDir) {
        fs.mkdirSync(outsideStateDir, { recursive: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
        fs.symlinkSync(outsideStateDir, stateDir, "dir");
      }
      return result;
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).rejects.toThrow(
        /must not traverse a symlink|changed during permission update/i,
      );
      expect(fs.existsSync(path.join(outsideStateDir, "agents"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects when a symlinked state-root alias target changes before child mkdirs", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-root-alias-swap-"));
    const realStateDir = path.join(tempDir, "real-state");
    const movedStateDir = path.join(tempDir, "moved-state");
    const aliasStateDir = path.join(tempDir, "alias-state");
    const sessionsDir = path.join(aliasStateDir, "agents", "main", "sessions");
    const aliasAgentsDir = path.join(aliasStateDir, "agents");
    const realMkdir = fsPromises.mkdir.bind(fsPromises);

    fs.mkdirSync(realStateDir, { recursive: true });
    fs.symlinkSync(realStateDir, aliasStateDir, "dir");

    vi.spyOn(fsPromises, "mkdir").mockImplementation(async (filePath, options) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === aliasAgentsDir && !fs.existsSync(movedStateDir)) {
        fs.renameSync(realStateDir, movedStateDir);
        fs.mkdirSync(realStateDir, { recursive: true });
      }
      return await realMkdir(filePath, options);
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).rejects.toThrow(
        /changed during permission update/i,
      );
      expect(fs.existsSync(path.join(realStateDir, "agents", "main"))).toBe(false);
      expect(fs.existsSync(path.join(movedStateDir, "agents"))).toBe(false);
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

  it("rejects when an existing state root changes after parent pinning and before final mkdir", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-existing-state-root-swap-"));
    const stateDir = path.join(tempDir, "state");
    const replacementStateDir = path.join(tempDir, "replacement-state");
    const agentsDir = path.join(stateDir, "agents");
    const agentDir = path.join(agentsDir, "main");
    const sessionsDir = path.join(agentDir, "sessions");
    const realLstat = fsPromises.lstat.bind(fsPromises);
    let agentsDirLstatCalls = 0;

    fs.mkdirSync(agentDir, { recursive: true });

    vi.spyOn(fsPromises, "lstat").mockImplementation(async (filePath) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === agentsDir) {
        agentsDirLstatCalls++;
        if (agentsDirLstatCalls === 2) {
          fs.renameSync(stateDir, replacementStateDir);
          fs.mkdirSync(stateDir, { recursive: true });
        }
      }
      return await realLstat(filePath);
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).rejects.toThrow(
        /changed during permission update/i,
      );
      expect(fs.existsSync(path.join(stateDir, "agents", "main", "sessions"))).toBe(false);
      expect(fs.existsSync(path.join(replacementStateDir, "agents", "main", "sessions"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes missing custom managed parents before the final recursive mkdir", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-custom-managed-parent-pin-"));
    const customRoot = path.join(tempDir, "custom-root");
    const sessionsDir = path.join(customRoot, "feeds", "main");
    const outsideRoot = path.join(tempDir, "outside-root");
    const configPath = path.join(tempDir, "openclaw.json");
    const realMkdir = fsPromises.mkdir.bind(fsPromises);

    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        session: {
          store: path.join(customRoot, "feeds", "{agentId}", "sessions.json"),
        },
      }),
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    vi.spyOn(fsPromises, "mkdir").mockImplementation(async (filePath, options) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === sessionsDir && !fs.existsSync(customRoot)) {
        fs.symlinkSync(outsideRoot, customRoot, "dir");
      }
      return await realMkdir(filePath, options);
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).resolves.toBe(path.resolve(sessionsDir));
      expect(fs.existsSync(path.join(customRoot, "feeds", "main"))).toBe(true);
      expect(fs.existsSync(path.join(outsideRoot, "feeds", "main"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows a symlink alias for configured managed roots when materializing missing directories", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-custom-managed-alias-"));
    const realRoot = path.join(tempDir, "real-root");
    const aliasRoot = path.join(tempDir, "alias-root");
    const sessionsDir = path.join(aliasRoot, "feeds", "main");
    const configPath = path.join(tempDir, "openclaw.json");

    fs.mkdirSync(realRoot, { recursive: true });
    fs.symlinkSync(realRoot, aliasRoot, "dir");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        session: {
          store: path.join(aliasRoot, "feeds", "{agentId}", "sessions.json"),
        },
      }),
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).resolves.toBe(path.resolve(sessionsDir));
      expect(fs.existsSync(path.join(realRoot, "feeds", "main"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces chmod permission failures for managed session dirs on POSIX", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chmod-eacces-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const realOpen = fsPromises.open.bind(fsPromises);
    const chmodError = Object.assign(new Error("chmod denied"), { code: "EACCES" });

    fs.mkdirSync(sessionsDir, { recursive: true });

    vi.spyOn(fsPromises, "open").mockImplementation(async (filePath, flags) => {
      const resolved = path.resolve(String(filePath));
      if (resolved !== sessionsDir) {
        return await realOpen(filePath, flags);
      }
      return {
        stat: async () => fs.lstatSync(sessionsDir),
        chmod: async () => {
          throw chmodError;
        },
        close: async () => undefined,
      } as unknown as fsPromises.FileHandle;
    });

    try {
      const { ensurePrivateSessionsDir } = await import("./paths.js");

      await expect(ensurePrivateSessionsDir(sessionsDir)).rejects.toMatchObject({
        code: "EACCES",
      });
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

  it("treats case-variant managed paths as managed on case-insensitive filesystems", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-case-alias-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const realSessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(realSessionsDir, { recursive: true });

      // Skip on case-sensitive filesystems where the alias path is genuinely different.
      if (!fs.existsSync(path.join(stateDir, "AGENTS"))) {
        return;
      }

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv;
      const caseVariantSessionsDir = path.join(stateDir, "AGENTS", "Main", "sessions");

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(caseVariantSessionsDir, env)).toBe(true);
      expect(
        isManagedSessionStorePath(path.join(caseVariantSessionsDir, "sessions.json"), env),
      ).toBe(true);
      expect(
        isManagedSessionTranscriptPath(path.join(caseVariantSessionsDir, "sess-1.jsonl"), env),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat case-variant paths as managed on case-sensitive state roots", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-case-sensitive-"));
    try {
      const stateDir = path.join(tempDir, "StateRoot");
      fs.mkdirSync(stateDir, { recursive: true });

      const realLstatSync = fs.lstatSync.bind(fs);
      vi.spyOn(fs, "lstatSync").mockImplementation((candidatePath) => {
        const resolved = path.resolve(String(candidatePath));
        if (resolved === path.join(tempDir, "stateroot")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return realLstatSync(candidatePath);
      });

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv;
      const caseVariantSessionsDir = path.join(stateDir, "AGENTS", "Main", "sessions");

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(caseVariantSessionsDir, env)).toBe(false);
      expect(
        isManagedSessionStorePath(path.join(caseVariantSessionsDir, "sessions.json"), env),
      ).toBe(false);
      expect(
        isManagedSessionTranscriptPath(path.join(caseVariantSessionsDir, "sess-1.jsonl"), env),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat separately cased sibling roots as case-insensitive aliases", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-case-sibling-"));
    const siblingStateDir = path.join(tempDir, "sibling-state");
    try {
      const stateDir = path.join(tempDir, "StateRoot");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(siblingStateDir, { recursive: true });

      const siblingStat = fs.lstatSync(siblingStateDir);
      const realLstatSync = fs.lstatSync.bind(fs);
      vi.spyOn(fs, "lstatSync").mockImplementation((candidatePath) => {
        const resolved = path.resolve(String(candidatePath));
        if (resolved === path.join(tempDir, "stateroot")) {
          return siblingStat;
        }
        return realLstatSync(candidatePath);
      });

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv;
      const caseVariantSessionsDir = path.join(stateDir, "AGENTS", "Main", "sessions");

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(caseVariantSessionsDir, env)).toBe(false);
      expect(
        isManagedSessionStorePath(path.join(caseVariantSessionsDir, "sessions.json"), env),
      ).toBe(false);
      expect(
        isManagedSessionTranscriptPath(path.join(caseVariantSessionsDir, "sess-1.jsonl"), env),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat lookalike per-agent roots outside the configured template as managed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-lookalike-root-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const lookalikeSessionsDir = path.join(tempDir, "archive", "agents", "main", "sessions");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(lookalikeSessionsDir, { recursive: true });

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv;

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(lookalikeSessionsDir, env)).toBe(false);
      expect(isManagedSessionStorePath(path.join(lookalikeSessionsDir, "sessions.json"), env)).toBe(
        false,
      );
      expect(
        isManagedSessionTranscriptPath(path.join(lookalikeSessionsDir, "sess-1.jsonl"), env),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats configured custom per-agent roots as managed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-custom-root-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const customRoot = path.join(tempDir, "custom-root");
      const customSessionsDir = path.join(customRoot, "agents", "main", "sessions");
      const configPath = path.join(tempDir, "openclaw.json");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(customSessionsDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          session: {
            store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        }),
      );

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv;

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(customSessionsDir, env)).toBe(true);
      expect(isManagedSessionStorePath(path.join(customSessionsDir, "sessions.json"), env)).toBe(
        true,
      );
      expect(
        isManagedSessionTranscriptPath(path.join(customSessionsDir, "sess-1.jsonl"), env),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats configured session.store templates with {agentId} outside agents/<id>/sessions as managed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-store-template-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const customRoot = path.join(tempDir, "custom-root");
      const customSessionsDir = path.join(customRoot, "sessions", "main");
      const configPath = path.join(tempDir, "openclaw.json");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(customSessionsDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          session: {
            store: path.join(customRoot, "sessions", "{agentId}", "sessions.json"),
          },
        }),
      );

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv;

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(customSessionsDir, env)).toBe(true);
      expect(isManagedSessionStorePath(path.join(customSessionsDir, "sessions.json"), env)).toBe(
        true,
      );
      expect(
        isManagedSessionTranscriptPath(path.join(customSessionsDir, "sess-1.jsonl"), env),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats symlink-alias configured template roots outside agents/<id>/sessions as managed", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-template-alias-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const realRoot = path.join(tempDir, "real-root");
      const aliasRoot = path.join(tempDir, "alias-root");
      const realSessionsDir = path.join(realRoot, "feeds", "main");
      const configPath = path.join(tempDir, "openclaw.json");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(realSessionsDir, { recursive: true });
      fs.symlinkSync(realRoot, aliasRoot, "dir");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          session: {
            store: path.join(aliasRoot, "feeds", "{agentId}", "sessions.json"),
          },
        }),
      );

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
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

  it("does not treat case-variant custom per-agent roots as managed on case-sensitive filesystems", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-custom-case-"));
    try {
      const stateDir = path.join(tempDir, "StateRoot");
      const customRoot = path.join(tempDir, "custom-root");
      const canonicalCustomSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const caseVariantCustomSessionsDir = path.join(customRoot, "agents", "Ops", "sessions");
      const configPath = path.join(tempDir, "openclaw.json");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(canonicalCustomSessionsDir, { recursive: true });
      if (fs.existsSync(path.join(customRoot, "AGENTS"))) {
        return;
      }
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          session: {
            store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        }),
      );

      const realLstatSync = fs.lstatSync.bind(fs);
      vi.spyOn(fs, "lstatSync").mockImplementation((candidatePath) => {
        const resolved = path.resolve(String(candidatePath));
        if (resolved === path.join(tempDir, "stateroot")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return realLstatSync(candidatePath);
      });

      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv;

      const { isManagedSessionStorePath, isManagedSessionTranscriptPath, isManagedSessionsDir } =
        await import("./paths.js");

      expect(isManagedSessionsDir(caseVariantCustomSessionsDir, env)).toBe(false);
      expect(
        isManagedSessionStorePath(path.join(caseVariantCustomSessionsDir, "sessions.json"), env),
      ).toBe(false);
      expect(
        isManagedSessionTranscriptPath(
          path.join(caseVariantCustomSessionsDir, "sess-1.jsonl"),
          env,
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
