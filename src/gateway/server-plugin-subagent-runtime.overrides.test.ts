import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "../agents/command/model-ref.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";

const dispatch = vi.hoisted(() =>
  vi.fn(
    async (
      _method: string,
      _params: Record<string, unknown>,
      _options?: { sessionMutationCommitGuard?: () => void },
    ) => ({ runId: "override-run" }),
  ),
);
vi.mock("./server-plugin-in-process-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-plugin-in-process-dispatch.js")>()),
  dispatchGatewayMethodInProcess: dispatch,
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) =>
    params.provider !== "fixture"
      ? undefined
      : params.context.modelId === "literal"
        ? "permitted"
        : params.context.modelId === "permitted"
          ? "different"
          : undefined,
}));

let config: OpenClawConfig;

beforeEach(() => {
  dispatch.mockClear();
  config = {
    agents: { entries: { worker: { model: "fixture/literal" } } },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid/v1",
          models: [
            {
              id: "literal",
              name: "Literal",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    plugins: {
      entries: {
        "override-fixture": {
          subagent: { allowModelOverride: true, allowedModels: ["fixture/permitted"] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
});

afterEach(() => {
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

function run(override: { provider?: string; model?: string }) {
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  const runtime = createGatewaySubagentRuntime(
    () => context,
    resolvePluginSubagentOverridePolicies(config),
  );
  return withPluginRuntimePluginScope({ pluginId: "override-fixture" }, () =>
    runtime.run({
      sessionKey: "agent:worker:subagent:override",
      message: "Use the selected model",
      ...override,
    }),
  );
}

describe("plugin subagent initial override policy", () => {
  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "checks the exact configured execution target for %j",
    async (override) => {
      // An operator-authored model row intentionally bypasses the provider's runtime alias.
      expect(normalizeAgentCommandModelRef(config, "fixture", "literal", {})).toEqual({
        provider: "fixture",
        model: "literal",
      });
      await expect(run(override)).rejects.toThrow(/not allowlisted/u);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "preserves an explicit API owner without configured model rows for %j",
    async (override) => {
      config.models!.providers!.fixture!.api = "openai-completions";
      config.models!.providers!.fixture!.models = [];
      await expect(run(override)).rejects.toThrow(/not allowlisted/u);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "preserves command selection for %j with chained aliases",
    async (override) => {
      config.models!.providers!.fixture!.models = [];
      await expect(run(override)).resolves.toMatchObject({ runId: "override-run" });
      const request = dispatch.mock.calls[0]?.[1];
      expect(request).toMatchObject(override);
      const model = request?.model as string;
      const selected = request?.provider
        ? normalizeAgentCommandModelRef(config, request.provider as string, model, {})
        : parseAgentCommandModelRef(config, "worker", model, "", {});
      expect(selected).toEqual({ provider: "fixture", model: "permitted" });
    },
  );

  it("allows an explicitly permitted configured literal without applying its runtime alias", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/literal"];
    await expect(run({ provider: "fixture", model: "literal" })).resolves.toMatchObject({
      runId: "override-run",
    });
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ provider: "fixture", model: "literal" });
  });

  it("rejects a replaced configuration before admitting its prepared override", async () => {
    config.models!.providers!.fixture!.models = [];
    const pending = run({ provider: "fixture", model: "literal" });
    config = { ...config };
    await expect(pending).rejects.toThrow(/configuration changed before admission/u);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
