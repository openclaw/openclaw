import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { fingerprintResolvedAuthProfileCredential } from "../agents/execution-auth-binding.js";
import type { AgentHarnessSetupVerificationContext } from "../agents/harness/types.js";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { fixture, modelRef, tempDirs } from "./setup-inference-activate.test-support.js";

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  clearConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["success", "rejected", "revoked-before-commit"] as const)(
  "uses native setup verification without an inference turn: %s",
  async (outcome) => {
    const setup = await fixture({ codex: true, homeScope: "user" });
    let retainedContext: AgentHarnessSetupVerificationContext | undefined;
    let checks = 0;
    const verifySetup = vi.fn(async (ctx: AgentHarnessSetupVerificationContext) => {
      retainedContext = ctx;
      ctx.assertCurrent();
      checks += 1;
      expect(ctx.provider).toBe("openai");
      expect(ctx.modelId).toBe("gpt-5.4-mini");
      if (outcome === "rejected" || (outcome === "revoked-before-commit" && checks > 1)) {
        throw new Error("Native account cannot access the selected model");
      }
    });
    setup.pluginRegistry.agentHarnesses.push({
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Native setup fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        verifySetup,
        runAttempt: async () => {
          throw new Error("Setup must not start a turn");
        },
      },
    });

    const result = await setup.activate("codex-cli");
    expect(setup.run).not.toHaveBeenCalled();
    expect(setup.readProfile()).toBeUndefined();
    expect(verifySetup).toHaveBeenCalled();
    expect(() => retainedContext?.assertCurrent()).toThrow("closed");
    if (outcome === "success") {
      expect(result).toMatchObject({ ok: true, modelRef });
      expect(checks).toBeGreaterThanOrEqual(2);
      const saved = await readConfigFileSnapshot();
      expect(JSON.stringify(saved.sourceConfig)).toContain(modelRef);
    } else {
      expect(result.ok).toBe(false);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      expect(checks).toBe(outcome === "rejected" ? 1 : 2);
    }
  },
);

it("retains the inference turn for credential-backed routes even when a hook exists", async () => {
  const setup = await fixture({ codex: true });
  const verifySetup = vi.fn(async () => {});
  setup.pluginRegistry.agentHarnesses.push({
    pluginId: "codex",
    source: "test",
    harness: {
      id: "codex",
      label: "Credential-backed fixture",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      verifySetup,
      authBinding: {
        async fingerprint({ authProfileId, authProfileStore, agentDir, config }) {
          const credential = authProfileStore.profiles[authProfileId];
          if (!credential) {
            return undefined;
          }
          const resolvedAuth = await setup.resolveAuth({
            provider: "openai",
            cfg: config,
            agentDir,
            profileId: authProfileId,
            lockedProfile: true,
            secretSentinels: false,
          });
          return fingerprintResolvedAuthProfileCredential({
            profileId: authProfileId,
            credential,
            resolvedAuth,
          });
        },
      },
      runAttempt: async () => {
        throw new Error("The fixture supplies the normal turn");
      },
    },
  });
  const result = await setup.activate("codex-cli");
  expect(result).toMatchObject({ ok: true });
  expect(verifySetup).not.toHaveBeenCalled();
  expect(setup.run).toHaveBeenCalledOnce();
});
