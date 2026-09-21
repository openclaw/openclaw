import { describe, expect, it } from "vitest";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("restoreEnvChangesIfUnchanged", () => {
  it.each([
    {
      name: "removes a newly injected key when unchanged from after snapshot",
      before: {},
      after: { KEY: "injected" },
      current: "injected",
      expected: undefined,
    },
    {
      name: "restores an overwritten key back to its before value",
      before: { KEY: "original" },
      after: { KEY: "new-value" },
      current: "new-value",
      expected: "original",
    },
    {
      name: "preserves an externally modified key even when different from before",
      before: {},
      after: { KEY: "config-set" },
      current: "external-change",
      expected: "external-change",
    },
  ])("$name", ({ before, after, current, expected }) => {
    const env: NodeJS.ProcessEnv = { HOME: "/tmp/test", KEY: current };
    restoreEnvChangesIfUnchanged({
      env,
      before: { HOME: "/tmp/test", ...before },
      after: { HOME: "/tmp/test", ...after },
    });
    expect(env.KEY).toBe(expected);
  });
});

describe("loadConfig env restoration", () => {
  it("returns resolution facts with a valid synchronous load", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      });
      const config = createConfigIO({
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      }).loadConfig();

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
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
    });
  });
});

describe.each(["loadConfig", "readConfigFileSnapshot"] as const)(
  "%s env restoration after invalid config",
  (read) => {
    it.each([
      { key: "TEST_VAR", original: undefined, injected: "injected-value" },
      { key: "PRE_EXISTING", original: "original-value", injected: "new-value" },
    ])("restores $key to $original", async ({ key, original, injected }) => {
      await withTempHome(async (home) => {
        await writeOpenClawConfig(home, {
          env: { vars: { [key]: injected } },
          gateway: { port: "invalid" },
        });
        const env: NodeJS.ProcessEnv = { HOME: home };
        if (original !== undefined) {
          env[key] = original;
        }
        const io = createConfigIO({
          env,
          homedir: () => home,
          logger: { warn: () => {}, error: () => {} },
        });

        expect(env[key]).toBe(original);
        if (read === "loadConfig") {
          expect(() => io.loadConfig()).toThrow(
            expect.objectContaining({ code: "INVALID_CONFIG" }),
          );
        } else {
          expect((await io.readConfigFileSnapshot()).valid).toBe(false);
        }
        expect(env[key]).toBe(original);
      });
    });
  },
);
