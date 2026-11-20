import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { PluginsInspectResultSchema } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { createPluginDeclaredSurface } from "../../../test/helpers/plugin-declared-surface.js";
import { createDecisionRegistry } from "../../decisions/contract.test-support.js";
import { evaluateDecisionInRegistry } from "../../decisions/runtime.js";
import { answer, batch, config, options } from "../../decisions/runtime.test-support.js";
import { emptyInstalledPluginComponents } from "../../plugins/installed-plugin-components.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin: inspect,
  listManagedPlugins: vi.fn(),
}));
const { pluginsHandlers } = await import("./plugins.js");

afterEach(() => resetPluginRuntimeStateForTest());

it.each([1, 2] as const)(
  "validates the actual inspection response with a decision provider: %s",
  async (contractVersion) => {
    let calls = 0;
    const selectedReady = vi.fn(() => true);
    const builder = createDecisionRegistry(
      config,
      contractVersion === 2
        ? {
            id: "fixture",
            contractVersion: 2,
            provider: { label: "Fixture", auth: [] },
            async evaluate() {
              throw new Error("Inspection must not evaluate a V2 provider");
            },
          }
        : {
            id: "fixture",
            contractVersion: 1,
            isReady: selectedReady,
            async evaluate() {
              if (++calls > 1) {
                return { status: "unavailable", reason: "transport" };
              }
              return answer;
            },
          },
    );
    const {
      registry,
      record: { id: pluginId },
    } = builder;
    const selectedInspection = vi.spyOn(registry.decisionProviders[0]!.host, "inspect");
    const unrelatedReady = vi.fn(() => true);
    const unrelated = createPluginRecord({
      id: "unrelated",
      source: "/synthetic/unrelated.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: { decisionProviders: ["unrelated"] },
    });
    runPluginRegisterSyncInRegistry(
      (api) =>
        api.registerDecisionProvider({
          id: "unrelated",
          contractVersion: 1,
          isReady: unrelatedReady,
          evaluate: async () => answer,
        }),
      builder.createApi(unrelated, { config }),
      registry,
      unrelated.id,
    );
    registry.plugins.push(unrelated);
    onTestFinished(async () => {
      for (const record of registry.plugins) {
        await getPluginInstance(record)?.dispose();
      }
    });
    if (contractVersion === 1) {
      for (let index = 0; index < 2; index++) {
        await evaluateDecisionInRegistry(batch, options(), registry, config);
      }
    }
    selectedReady.mockClear();
    const inspection = {
      ok: true,
      plugin: { id: pluginId, name: "Decision fixture", installed: true, enabled: true },
      reviewToken: "synthetic-review-token",
      declared: createPluginDeclaredSurface({ contracts: ["decisionProviders: fixture"] }),
      grants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
      components: emptyInstalledPluginComponents(),
    };
    inspect.mockResolvedValueOnce(inspection);
    let response: unknown;
    await withPluginRuntimeRegistryScope(registry, () =>
      pluginsHandlers["plugins.inspect"]!({
        req: gatewayRequest("inspect", "plugins.inspect", { pluginId }),
        params: { pluginId },
        client: null,
        isWebchatConnect: () => false,
        context: { getRuntimeConfig: () => config } as GatewayRequestContext,
        respond: (ok, result, error) => {
          expect(ok).toBe(true);
          expect(error).toBeUndefined();
          response = result;
        },
      }),
    );
    expect(selectedInspection).toHaveBeenCalledTimes(1);
    expect(selectedReady).toHaveBeenCalledTimes(contractVersion === 1 ? 1 : 0);
    expect(unrelatedReady).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      decisions: [
        {
          providerId: "fixture",
          pluginId,
          configured: true,
          ...(contractVersion === 1 ? { credentialReady: true } : {}),
          callable: true,
          successCount: contractVersion === 1 ? 1 : 0,
          activeRequests: 0,
          usage:
            contractVersion === 1
              ? { inputTokens: 25, outputTokens: 4 }
              : { inputTokens: 0, outputTokens: 0 },
          reasons: contractVersion === 1 ? { transport: 1 } : {},
        },
      ],
    });
    if (contractVersion === 2) {
      expect(response).not.toHaveProperty("decisions.0.credentialReady");
    }
    expect(Value.Check(PluginsInspectResultSchema, response)).toBe(true);
    const observed = registry.decisionProviders[0]!.host.inspect(config);
    for (const malformed of [
      { ...observed, activeRequests: -1 },
      { ...observed, reasons: { unrecognized: 1 } },
      { ...observed, apiKey: "must-not-be-exposed" },
    ]) {
      expect(
        Value.Check(PluginsInspectResultSchema, { ...inspection, decisions: [malformed] }),
      ).toBe(false);
    }
  },
);
