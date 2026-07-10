// Verifies process.env is restored after invalid config rejection.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";

describe("restoreEnvChangesIfUnchanged", () => {
  it("deletes keys added after the before snapshot", () => {
    const env: Record<string, string | undefined> = { EXISTING: "keep" };
    const before = { EXISTING: "keep" };
    env.LEAKED = "should-be-deleted";
    const after = { EXISTING: "keep", LEAKED: "should-be-deleted" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.EXISTING).toBe("keep");
    expect(env.LEAKED).toBeUndefined();
    expect("LEAKED" in env).toBe(false);
  });

  it("preserves keys that already existed before", () => {
    const env: Record<string, string | undefined> = { KEEP_ME: "original" };
    const before = { KEEP_ME: "original" };
    const after = { KEEP_ME: "original" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.KEEP_ME).toBe("original");
  });

  it("restores a key to its before value when it was changed", () => {
    const env: Record<string, string | undefined> = { CHANGED: "new-value" };
    const before = { CHANGED: "old-value" };
    const after = { CHANGED: "new-value" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.CHANGED).toBe("old-value");
  });

  it("does not touch keys that diverged from after snapshot (externally modified)", () => {
    // If something else also wrote to the env between snapshot and restore,
    // we must not overwrite it — it's not our change.
    const env: Record<string, string | undefined> = {
      OURS: "added-by-config",
      EXTERNAL: "added-by-someone-else",
    };
    const before: Record<string, string | undefined> = {};
    const after: Record<string, string | undefined> = { OURS: "added-by-config" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.OURS).toBeUndefined();
    // EXTERNAL was not in after; it was added outside config load — keep it.
    expect(env.EXTERNAL).toBe("added-by-someone-else");
  });

  it("handles empty before snapshot (clean start)", () => {
    const env: Record<string, string | undefined> = { ADDED1: "a", ADDED2: "b" };
    const before: Record<string, string | undefined> = {};
    const after = { ADDED1: "a", ADDED2: "b" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.ADDED1).toBeUndefined();
    expect(env.ADDED2).toBeUndefined();
  });
});

describe("env restoration via entry points", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-restore-env-"));
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  function createTestIO(home: string, env: NodeJS.ProcessEnv) {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      configPath,
      io: createConfigIO({
        fs,
        json5: JSON5,
        env,
        homedir: () => home,
        configPath,
        logger: { warn: () => {}, error: () => {} },
      }),
    };
  }

  async function withHome<T>(fn: (home: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${caseId++}`);
    await fsp.mkdir(home, { recursive: true });
    const env = {} as NodeJS.ProcessEnv;
    return fn(home, env);
  }

  async function writeConfig(configPath: string, config: Record<string, unknown>) {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  // Sync entry point: loadConfig via createConfigIO
  // -------------------------------------------------

  it("sync loadConfig restores env on schema validation failure", async () => {
    await withHome(async (home, env) => {
      const { io, configPath } = createTestIO(home, env);
      await writeConfig(configPath, {
        env: { vars: { OPENCLAW_TEST_LEAK_SYNC: "should-be-cleaned" } },
        gateway: { port: "not-a-number" },
      });

      expect(() => io.loadConfig()).toThrow();
      expect(env.OPENCLAW_TEST_LEAK_SYNC).toBeUndefined();
      expect("OPENCLAW_TEST_LEAK_SYNC" in env).toBe(false);
    });
  });

  it("sync loadConfig restores env on duplicate agent dir rejection", async () => {
    await withHome(async (home, env) => {
      const { io, configPath } = createTestIO(home, env);
      await writeConfig(configPath, {
        env: { vars: { OPENCLAW_DUP_SYNC: "leaked" } },
        gateway: { mode: "local" },
        agents: {
          list: [
            { id: "dup-1", agentDir: "/tmp/shared-agent-dir" },
            { id: "dup-2", agentDir: "/tmp/shared-agent-dir" },
          ],
        },
      });

      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.OPENCLAW_DUP_SYNC).toBeUndefined();
      expect("OPENCLAW_DUP_SYNC" in env).toBe(false);
    });
  });

  it("sync loadConfig restores changed env value on validation failure", async () => {
    await withHome(async (home, env) => {
      // Pre-existing env key that the config will overwrite
      env.PRE_EXISTING = "original-value";
      const { io, configPath } = createTestIO(home, env);
      await writeConfig(configPath, {
        env: { vars: { PRE_EXISTING: "replaced-by-config" } },
        gateway: { port: "not-a-number" },
      });

      expect(() => io.loadConfig()).toThrow();
      // Should be restored to original value, not the config's value
      expect(env.PRE_EXISTING).toBe("original-value");
    });
  });

  // Async entry point: readConfigFileSnapshot via createConfigIO
  // ------------------------------------------------------------

  it("async readConfigFileSnapshot restores env on validation failure", async () => {
    await withHome(async (home, env) => {
      const { io, configPath } = createTestIO(home, env);
      await writeConfig(configPath, {
        env: { vars: { OPENCLAW_TEST_LEAK_ASYNC: "should-be-cleaned" } },
        gateway: { port: "not-a-number" },
      });

      const result = await io.readConfigFileSnapshot();
      expect(result.valid).toBe(false);
      expect(env.OPENCLAW_TEST_LEAK_ASYNC).toBeUndefined();
      expect("OPENCLAW_TEST_LEAK_ASYNC" in env).toBe(false);
    });
  });

  it("async readConfigFileSnapshot restores changed env value on failure", async () => {
    await withHome(async (home, env) => {
      env.PRE_EXISTING_ASYNC = "original-value";
      const { io, configPath } = createTestIO(home, env);
      await writeConfig(configPath, {
        env: { vars: { PRE_EXISTING_ASYNC: "replaced-by-config" } },
        gateway: { port: "not-a-number" },
      });

      const result = await io.readConfigFileSnapshot();
      expect(result.valid).toBe(false);
      expect(env.PRE_EXISTING_ASYNC).toBe("original-value");
    });
  });

  // Verify valid configs are unaffected
  // -----------------------------------

  it("sync loadConfig preserves env vars from valid configs", async () => {
    await withHome(async (home, env) => {
      const { io, configPath } = createTestIO(home, env);
      await writeConfig(configPath, {
        env: { vars: { OPENCLAW_VALID_KEEP: "keep-me" } },
        gateway: { mode: "local" },
      });

      const config = io.loadConfig();
      expect(config.gateway?.mode).toBe("local");
      expect(env.OPENCLAW_VALID_KEEP).toBe("keep-me");
    });
  });
});
