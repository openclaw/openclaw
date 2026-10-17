import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader, readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { resolveSetupInferenceWinnerError } from "./setup-inference-core.js";
import { resolvePersistentApplyInference, verifySetupInference } from "./setup-inference-turn.js";
import { installSystemAgentClaudeCliBackendTestFixture } from "./system-agent.test-helpers.js";
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
  const provider = (providerId: string, id: string) => ({
    api: "openai-completions" as const,
    baseUrl: `${fixtureBaseUrl}/${providerId}/v1`,
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
      providers: {
        "fixture-primary": provider("fixture-primary", "first"),
        "fixture-backup": provider("fixture-backup", "second"),
      },
    },
  };
}

const readSnapshot = () =>
  readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });

type ProbeOptions = {
  primarySuccess?: boolean;
  primaryFailure?: "auth" | "format";
  failedProfiles?: string[];
  afterResponse?: () => Promise<void>;
};
type ProbeAttempt = { provider: string; model: string; profile?: string };
let fixtureBaseUrl: string;
let activeProbe: { options: ProbeOptions; attempts: ProbeAttempt[] } | undefined;
let releaseServer: (() => Promise<void>) | undefined;
const profileByKey = new Map([
  ["fixture-primary-key", "fixture-primary:pinned"],
  ["fixture-backup-key", "fixture-backup:pinned"],
  ["first-fixture-key", "fixture-backup:first"],
  ["second-fixture-key", "fixture-third:second"],
  ["third-fixture-key", "fixture-backup:third"],
]);

beforeAll(async () => {
  const server = createServer((request, response) => {
    const respond = async () => {
      const fixture = expectDefined(activeProbe, "active inference HTTP fixture");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        !("model" in body) ||
        typeof body.model !== "string"
      ) {
        throw new Error("Inference fixture requires a model request");
      }
      const provider = new URL(request.url ?? "/", "http://localhost").pathname.split("/")[1];
      if (!provider) {
        throw new Error("Inference fixture requires a provider path");
      }
      const model = body.model;
      const profile = profileByKey.get(
        request.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      fixture.attempts.push({ provider, model, ...(profile ? { profile } : {}) });
      if (
        (`${provider}/${model}` === primary && !fixture.options.primarySuccess) ||
        fixture.options.failedProfiles?.includes(profile ?? "")
      ) {
        const status = fixture.options.primaryFailure === "format" ? 400 : 401;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                status === 400
                  ? "Invalid request: model not supported"
                  : "Synthetic primary credential rejected",
              type: status === 400 ? "invalid_request_error" : "invalid_api_key",
              code: status === 400 ? "model_not_supported" : "invalid_api_key",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "fixture-probe",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
        })}\n\n`,
      );
      await fixture.options.afterResponse?.();
      response.end(
        `data: ${JSON.stringify({
          id: "fixture-probe",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    };
    void respond().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const reservation = await reserveTestPortListener({ offsets: [0], createListener: () => server });
  fixtureBaseUrl = `http://127.0.0.1:${reservation.claim.port}`;
  releaseServer = async () => {
    server.closeAllConnections();
    try {
      await reservation.releaseListener();
    } finally {
      await reservation.claim.release();
    }
  };
});
afterEach(() => {
  activeProbe = undefined;
});
afterAll(async () => {
  await releaseServer?.();
});

function probeFixture(options: ProbeOptions = {}) {
  const attempts: ProbeAttempt[] = [];
  activeProbe = { options, attempts };
  return {
    attempts,
    readConfig: async () => {
      const snapshot = await readSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      return snapshot.runtimeConfig ?? snapshot.config;
    },
    verify: async (params: {
      runtime: RuntimeEnv;
      bindSession: true;
      agentId: string;
      fallbackModelRef?: string;
    }) => {
      await captureRuntimeConfigAsyncReader()();
      return await verifySetupInference({
        ...params,
        deps: { readConfigFileSnapshot: readSnapshot },
      });
    },
  };
}

describe("bound maintenance configured model fallbacks", () => {
  it("keeps a healthy primary when an optional CLI fallback profile is missing", async () => {
    const restoreCliBackend = installSystemAgentClaudeCliBackendTestFixture();
    try {
      await withOpenClawTestState(
        { label: "healthy-primary-missing-fallback-profile" },
        async (state) => {
          const config = configuredChain();
          config.agents!.defaults!.model = {
            primary,
            fallbacks: ["claude-cli/claude-opus-5@missing-profile"],
          };
          await state.writeConfig(config);
          const fixture = probeFixture({ primarySuccess: true });
          const result = await verifySystemAgentInferenceWithFallback({
            requestingAgentId: "main",
            runtime,
            deps: { readConfig: fixture.readConfig, verify: fixture.verify },
          });
          expect(result.ok, JSON.stringify(result)).toBe(true);
          if (!result.ok) {
            throw new Error(result.error);
          }
          expect(result.binding.configuredRoute).toMatchObject({
            agentId: "main",
            provider: "fixture-primary",
            model: "first",
          });
          expect(result.binding.execution).toMatchObject({
            agentId: "main",
            provider: "fixture-primary",
            model: "first",
          });
          expect(fixture.attempts).toEqual([{ provider: "fixture-primary", model: "first" }]);
        },
      );
    } finally {
      restoreCliBackend();
    }
  });

  it("skips a missing CLI fallback profile after the primary fails", async () => {
    const restoreCliBackend = installSystemAgentClaudeCliBackendTestFixture();
    try {
      await withOpenClawTestState(
        { label: "failed-primary-missing-fallback-profile" },
        async (state) => {
          const config = configuredChain();
          config.agents!.defaults!.model = {
            primary,
            fallbacks: ["claude-cli/claude-opus-5@missing-profile", backup],
          };
          await state.writeConfig(config);
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
          expect(result.binding.configuredRoute).toMatchObject({
            agentId: "main",
            fallbackModelRef: backup,
            provider: "fixture-backup",
            model: "second",
          });
          expect(result.binding.execution).toMatchObject({
            agentId: "main",
            fallbackModelRef: backup,
            provider: "fixture-backup",
            model: "second",
          });
          expect(fixture.attempts).toEqual([
            { provider: "fixture-primary", model: "first" },
            { provider: "fixture-backup", model: "second" },
          ]);
        },
      );
    } finally {
      restoreCliBackend();
    }
  });

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
        baseUrl: `${fixtureBaseUrl}/fixture-third/v1`,
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
    "rejects runner metadata reporting an unknown winner %s",
    async (identity) => {
      const route = await resolveSystemAgentConfiguredRouteFromConfig(configuredChain(), "main");
      if (!route) {
        throw new Error("missing configured inference route");
      }
      const error = await resolveSetupInferenceWinnerError(route, {
        meta: {
          durationMs: 0,
          executionTrace: {
            winnerProvider: identity === "provider" ? "unexpected-provider" : route.provider,
            winnerModel: identity === "model" ? "unexpected-model" : route.model,
          },
        },
      });
      expect(error).toContain("instead of the requested fixture-primary/first");
    },
  );

  it("does not retry when credentials change during a successful response", async () => {
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
