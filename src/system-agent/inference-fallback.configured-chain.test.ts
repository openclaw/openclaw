import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { FailoverError } from "../agents/failover-error.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import { resolvePersistentApplyInference, verifySetupInference } from "./setup-inference-turn.js";
import { resolveSystemAgentVerifiedInferenceRoute } from "./verified-inference.js";

const primary = "fixture-primary/first";
const backup = "fixture-backup/second";
const runtime: RuntimeEnv = {
  log() {},
  error() {},
  exit() {
    throw new Error("unexpected exit");
  },
};

function configuredChain(): OpenClawConfig {
  const provider = (id: string) => ({
    api: "openai-completions" as const,
    baseUrl: "http://127.0.0.1:19998/v1",
    apiKey: "fixture-key-not-a-credential",
    models: [
      {
        id,
        name: id,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 256,
      },
    ],
  });
  return {
    plugins: { enabled: false },
    agents: {
      defaults: {
        model: { primary, fallbacks: [backup] },
        models: {
          [primary]: { agentRuntime: { id: "openclaw" } },
          [backup]: { agentRuntime: { id: "openclaw" } },
        },
      },
      entries: { main: {} },
    },
    models: {
      providers: { "fixture-primary": provider("first"), "fixture-backup": provider("second") },
    },
  };
}

const readSnapshot = () =>
  readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });

function probeFixture(
  options: {
    winner?: string;
    winnerModel?: string;
    primaryFailure?: "auth" | "format";
    failedProfiles?: string[];
    afterResponse?: () => Promise<void>;
  } = {},
) {
  const attempts: Array<{ provider: string; model: string; profile?: string }> = [];
  const runEmbeddedAgent: NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]> = async (
    params,
  ) => {
    expect(params.modelFallbacksOverride).toEqual([]);
    expect(params.authProfileStateMode).toBe("read-only");
    const provider = params.provider!;
    const model = params.model!;
    attempts.push({ provider, model, profile: params.authProfileId });
    if (
      `${provider}/${model}` === primary ||
      options.failedProfiles?.includes(params.authProfileId ?? "")
    ) {
      throw new FailoverError("Synthetic primary outage", {
        reason: options.primaryFailure ?? "auth",
      });
    }
    const auth = await resolveApiKeyForProviderCore({
      provider,
      cfg: params.config,
      agentDir: params.agentDir,
      modelId: model,
      modelApi: "openai-completions",
      ...(params.authProfileId
        ? { profileId: params.authProfileId, lockedProfile: true }
        : { allowAuthProfileFallback: false }),
      secretSentinels: true,
    });
    params.onSuccessfulAuthBinding?.({
      authFingerprint: fingerprintResolvedProviderAuth(auth),
      ...(auth.profileId ? { authProfileId: auth.profileId } : {}),
      agentHarnessId: "openclaw",
      modelId: model,
      modelApi: "openai-completions",
    });
    await options.afterResponse?.();
    return {
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "OK",
        executionTrace: {
          winnerProvider: options.winner ?? provider,
          winnerModel: options.winnerModel ?? model,
        },
      },
    };
  };
  return {
    attempts,
    readConfig: async () => {
      const snapshot = await readSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      return snapshot.runtimeConfig ?? snapshot.config;
    },
    verify: (params: {
      runtime: RuntimeEnv;
      bindSession: true;
      agentId: string;
      fallbackModelRef?: string;
    }) =>
      verifySetupInference({
        ...params,
        deps: { runEmbeddedAgent, readConfigFileSnapshot: readSnapshot },
      }),
  };
}

describe("bound maintenance configured model fallbacks", () => {
  it.each(["defaults", "agent"] as const)(
    "binds and revalidates the successful %s fallback under the original owner",
    async (scope) => {
      await withOpenClawTestState({ label: "bound-model-fallback" }, async (state) => {
        const config = configuredChain();
        if (scope === "agent") {
          expectDefined(config.agents?.entries?.main, "fixture main agent").model = {
            primary,
            fallbacks: [backup],
          };
          config.agents!.defaults!.model = "unused/default";
        }
        await state.writeConfig(config);
        const snapshot = await readSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const fixture = probeFixture();
        const result = await verifySystemAgentInferenceWithFallback({
          requestingAgentId: "main",
          runtime,
          deps: { readConfig: fixture.readConfig, verify: fixture.verify },
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) {
          throw new Error(result.error);
        }
        expect(fixture.attempts.map(({ provider, model }) => `${provider}/${model}`)).toEqual([
          primary,
          backup,
        ]);
        expect(result.binding.configuredRoute).toMatchObject({
          agentId: "main",
          fallbackModelRef: backup,
          provider: "fixture-backup",
          model: "second",
        });
        expect(result.binding.execution.sourceConfig.agents?.defaults?.model).toEqual(
          config.agents?.defaults?.model,
        );
        expect(await resolveSystemAgentVerifiedInferenceRoute(result.binding)).toBe(
          result.binding.execution,
        );
        expect(await resolvePersistentApplyInference({ binding: result.binding, runtime })).toBe(
          result.binding.execution,
        );
      });
    },
  );

  it.each(["empty", "strict-primary"] as const)(
    "does not inherit defaults through an agent's %s override",
    async (mode) => {
      await withOpenClawTestState({ label: "no-fallback-inheritance" }, async (state) => {
        const config = configuredChain();
        expectDefined(config.agents?.entries?.main, "fixture main agent").model =
          mode === "empty" ? { primary, fallbacks: [] } : primary;
        await state.writeConfig(config);
        const snapshot = await readSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const fixture = probeFixture();
        const result = await verifySystemAgentInferenceWithFallback({
          requestingAgentId: "main",
          runtime,
          deps: { readConfig: fixture.readConfig, verify: fixture.verify },
        });
        expect(result).toMatchObject({ ok: false, status: "auth" });
        expect(fixture.attempts.map(({ provider }) => provider)).toEqual(["fixture-primary"]);
      });
    },
  );

  it("does not accept an arbitrary fallback override or borrow ordinary fallbacks for utility verification", async () => {
    const config = configuredChain();
    config.agents!.defaults!.utilityModel = "fixture-primary/first";
    expect(
      await resolveSystemAgentConfiguredRouteFromConfig(config, "main", {
        fallbackModelRef: "foreign/model",
      }),
    ).toBeNull();
    expect(
      await resolveSystemAgentConfiguredRouteFromConfig(config, "main", {
        modelTarget: "utility",
        fallbackModelRef: backup,
      }),
    ).toBeNull();
  });

  it("keeps each configured profile pin and never forwards the primary pin to another provider", async () => {
    await withOpenClawTestState({ label: "fallback-profile-pins" }, async (state) => {
      const config = configuredChain();
      config.agents!.defaults!.model = {
        primary: `${primary}@fixture-primary:pinned`,
        fallbacks: [`${backup}@fixture-backup:pinned`],
      };
      await state.writeConfig(config);
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "fixture-primary:pinned": {
            type: "api_key",
            provider: "fixture-primary",
            key: "fixture-primary-key",
          },
          "fixture-backup:pinned": {
            type: "api_key",
            provider: "fixture-backup",
            key: "fixture-backup-key",
          },
        },
      });
      const snapshot = await readSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      const fixture = probeFixture();
      const result = await verifySystemAgentInferenceWithFallback({
        requestingAgentId: "main",
        runtime,
        deps: { readConfig: fixture.readConfig, verify: fixture.verify },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(fixture.attempts.map(({ profile }) => profile)).toEqual([
        "fixture-primary:pinned",
        "fixture-backup:pinned",
      ]);
      expect(result.binding.auth.authProfileId).toBe("fixture-backup:pinned");
      expect(await resolveSystemAgentVerifiedInferenceRoute(result.binding)).toBe(
        result.binding.execution,
      );
    });
  });

  it("preserves authored order across interleaved profile-pinned fallback references", async () => {
    await withOpenClawTestState({ label: "interleaved-fallback-pins" }, async (state) => {
      const config = configuredChain();
      const first = `${backup}@fixture-backup:first`;
      const second = "fixture-third/third@fixture-third:second";
      const provider = expectDefined(
        config.models?.providers?.["fixture-backup"],
        "backup provider",
      );
      config.models!.providers!["fixture-third"] = {
        ...provider,
        models: [
          {
            ...expectDefined(provider.models[0], "backup model"),
            id: "third",
            name: "Third fixture",
          },
        ],
      };
      config.agents!.defaults!.models!["fixture-third/third"] = {
        agentRuntime: { id: "openclaw" },
      };
      const third = `${backup}@fixture-backup:third`;
      config.agents!.defaults!.model = { primary, fallbacks: [first, second, third] };
      await state.writeConfig(config);
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "fixture-backup:first": {
            type: "api_key",
            provider: "fixture-backup",
            key: "first-fixture-key",
          },
          "fixture-third:second": {
            type: "api_key",
            provider: "fixture-third",
            key: "second-fixture-key",
          },
          "fixture-backup:third": {
            type: "api_key",
            provider: "fixture-backup",
            key: "third-fixture-key",
          },
        },
      });
      const fixture = probeFixture({ failedProfiles: ["fixture-backup:first"] });
      const result = await verifySystemAgentInferenceWithFallback({
        requestingAgentId: "main",
        runtime,
        deps: { readConfig: fixture.readConfig, verify: fixture.verify },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(fixture.attempts.map(({ profile }) => profile)).toEqual([
        undefined,
        "fixture-backup:first",
        "fixture-third:second",
      ]);
      expect(result.binding.execution.fallbackModelRef).toBe(second);
    });
  });

  it("tries a sibling model after a model-specific failure under the same credential owner", async () => {
    await withOpenClawTestState({ label: "fallback-sibling-model" }, async (state) => {
      const config = configuredChain();
      const sibling = "fixture-primary/second";
      config.agents!.defaults!.model = { primary, fallbacks: [sibling, backup] };
      expectDefined(
        config.models?.providers?.["fixture-primary"],
        "fixture primary provider",
      ).models.push({
        ...expectDefined(
          config.models?.providers?.["fixture-backup"]?.models[0],
          "fixture backup model",
        ),
      });
      config.agents!.defaults!.models![sibling] = { agentRuntime: { id: "openclaw" } };
      await state.writeConfig(config);
      const fixture = probeFixture({ primaryFailure: "format" });
      const result = await verifySystemAgentInferenceWithFallback({
        requestingAgentId: "main",
        runtime,
        deps: { readConfig: fixture.readConfig, verify: fixture.verify },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(fixture.attempts.map(({ provider, model }) => `${provider}/${model}`)).toEqual([
        primary,
        sibling,
      ]);
      expect(result.binding.execution).toMatchObject({
        agentId: "main",
        fallbackModelRef: sibling,
        provider: "fixture-primary",
        model: "second",
      });
      expect(await resolvePersistentApplyInference({ binding: result.binding, runtime })).toBe(
        result.binding.execution,
      );
    });
  });

  it.each(["provider", "model"] as const)(
    "rejects an unknown winner %s without trying another candidate",
    async (identity) => {
      await withOpenClawTestState({ label: "fallback-unknown-winner" }, async (state) => {
        const config = configuredChain();
        config.agents!.defaults!.model = { primary, fallbacks: [backup, "fixture-primary/other"] };
        await state.writeConfig(config);
        const fixture = probeFixture(
          identity === "provider"
            ? { winner: "unexpected-provider" }
            : { winnerModel: "unexpected-model" },
        );
        const result = await verifySystemAgentInferenceWithFallback({
          requestingAgentId: "main",
          runtime,
          deps: { readConfig: fixture.readConfig, verify: fixture.verify },
        });
        expect(result).toMatchObject({ ok: false, status: "unknown" });
        expect(fixture.attempts).toHaveLength(2);
      });
    },
  );

  it("does not retry after successful-response credential drift", async () => {
    await withOpenClawTestState({ label: "fallback-probe-drift" }, async (state) => {
      const config = configuredChain();
      await state.writeConfig(config);
      const fixture = probeFixture({
        afterResponse: async () => {
          expectDefined(
            config.models?.providers?.["fixture-backup"],
            "fixture backup provider",
          ).apiKey = "rotated-fixture-key";
          await state.writeConfig(config);
        },
      });
      const result = await verifySystemAgentInferenceWithFallback({
        requestingAgentId: "main",
        runtime,
        deps: { readConfig: fixture.readConfig, verify: fixture.verify },
      });
      expect(result).toMatchObject({ ok: false, status: "unknown" });
      expect(fixture.attempts).toHaveLength(2);
    });
  });

  it.each(["removed", "reordered", "primary", "policy", "credential", "harness"] as const)(
    "rejects a bound fallback after %s changes",
    async (change) => {
      await withOpenClawTestState({ label: "fallback-bound-drift" }, async (state) => {
        const config = configuredChain();
        await state.writeConfig(config);
        const snapshot = await readSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const fixture = probeFixture();
        const result = await verifySystemAgentInferenceWithFallback({
          requestingAgentId: "main",
          runtime,
          deps: { readConfig: fixture.readConfig, verify: fixture.verify },
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        if (change === "removed") {
          config.agents!.defaults!.model = { primary, fallbacks: [] };
        }
        if (change === "reordered") {
          config.agents!.defaults!.model = {
            primary,
            fallbacks: ["fixture-primary/other", backup],
          };
        }
        if (change === "primary") {
          config.agents!.defaults!.model = {
            primary: "fixture-primary/changed",
            fallbacks: [backup],
          };
        }
        if (change === "policy") {
          config.agents!.defaults!.modelPolicy = { allow: [primary] };
        }
        if (change === "credential") {
          expectDefined(
            config.models?.providers?.["fixture-backup"],
            "fixture backup provider",
          ).apiKey = "rotated-fixture-key";
        }
        if (change === "harness") {
          expectDefined(
            config.agents?.defaults?.models?.[backup],
            "fixture backup settings",
          ).agentRuntime = { id: "auto" };
        }
        await state.writeConfig(config);
        expect(await resolveSystemAgentVerifiedInferenceRoute(result.binding)).toBeNull();
        expect(
          await resolvePersistentApplyInference({ binding: result.binding, runtime }),
        ).toBeNull();
        expect(fixture.attempts).toHaveLength(2);
      });
    },
  );
});
