import { describe, expect, it } from "vitest";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import { applyConfigEnvVars, createConfigRuntimeEnvBase, snapshotEnv } from "./config-env-vars.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

function configIO(home: string, env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, homedir: () => home, logger: { warn: () => {}, error: () => {} } });
}

describe("restoreEnvChangesIfUnchanged", () => {
  it("restores external ownership when rejected config replaced equal lower-precedence bytes", () => {
    const env = { KEY: "same" };
    const cfg = { env: { vars: { KEY: "same" } } };
    const before = snapshotEnv(env);
    applyConfigEnvVars(cfg, env, { lowerPrecedenceEnv: { KEY: "same" } });
    const after = snapshotEnv(env);
    expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBeUndefined();

    restoreEnvChangesIfUnchanged({ env, before, after });

    expect(env.KEY).toBe("same");
    expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBe("same");
  });

  it("preserves a later ownership change even when environment bytes are unchanged", () => {
    const env: NodeJS.ProcessEnv = {};
    const before = snapshotEnv(env);
    applyConfigEnvVars({ env: { vars: { KEY: "value" } } }, env);
    const after = snapshotEnv(env);
    applyConfigEnvVars({}, env);

    restoreEnvChangesIfUnchanged({ env, before, after });

    expect(env.KEY).toBe("value");
  });

  it("restores earlier config ownership with its value after a rejected replacement", () => {
    const env: NodeJS.ProcessEnv = {};
    const cfg = { env: { vars: { KEY: "old" } } };
    applyConfigEnvVars(cfg, env);
    const before = snapshotEnv(env);
    applyConfigEnvVars({ env: { vars: { KEY: "new" } } }, env, {
      lowerPrecedenceEnv: { KEY: "old" },
    });
    const after = snapshotEnv(env);

    restoreEnvChangesIfUnchanged({ env, before, after });

    expect(env.KEY).toBe("old");
    expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBeUndefined();
  });

  it("preserves an externally modified value", () => {
    const env = { KEY: "external-change" };
    restoreEnvChangesIfUnchanged({ env, before: {}, after: { KEY: "config-set" } });
    expect(env.KEY).toBe("external-change");
  });
});

describe("loadConfig env restoration", () => {
  it("returns resolution facts with a valid synchronous load", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      });
      const config = configIO(home, { HOME: home }).loadConfig();

      expect([...(getConfigResolutionFacts(config) ?? [])]).toEqual(["gateway.auth.token"]);
    });
  });

  it("restores env changes after non-INVALID_CONFIG error (DuplicateAgentDirError)", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { DUP_DIR_TEST_VAR: "injected-value" } },
        agents: {
          list: [
            { id: "agent-a", agentDir: "/tmp/dup-agent-dir" },
            { id: "agent-b", agentDir: "/tmp/dup-agent-dir" },
          ],
        },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = configIO(home, env);

      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
    });
  });
});

it.each(["loadConfig", "readConfigFileSnapshot"] as const)(
  "%s rolls back env after invalid config",
  async (read) => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { TEST_VAR: "injected-value" } },
        gateway: { port: "invalid" },
      });
      const env: NodeJS.ProcessEnv = { HOME: home };
      const io = configIO(home, env);
      if (read === "loadConfig") {
        expect(() => io.loadConfig()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
      } else {
        expect((await io.readConfigFileSnapshot()).valid).toBe(false);
      }
      expect(env.TEST_VAR).toBeUndefined();
    });
  },
);
