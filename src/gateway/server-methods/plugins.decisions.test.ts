import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { PluginsInspectResultSchema } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { evaluateDecisionInRegistry } from "../../decisions/runtime.js";
import { mergePluginDeclaredSurfaces } from "../../plugins/capability-summary.js";
import { emptyInstalledPluginComponents } from "../../plugins/installed-plugin-components.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { pluginRequest } from "./plugins.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin: inspect,
  listManagedPlugins: vi.fn(),
}));
const { pluginsHandlers } = await import("./plugins.js");

afterEach(() => resetPluginRuntimeStateForTest());

it.each([undefined, 1, 2] as const)(
  "validates the actual inspection response with a decision provider: %s",
  async (contractVersion) => {
    const registered = contractVersion !== undefined;
    const legacy = contractVersion === 1;
    const usage = { inputTokens: 2, outputTokens: 1 };
    const config = { agents: { defaults: { decisionModel: "fixture/fast" } } };
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "decision-plugin",
      source: "/synthetic/index.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: { decisionProviders: ["fixture"] },
    });
    if (registered) {
      let calls = 0;
      const api = builder.createApi(record, { config });
      runPluginRegisterSyncInRegistry(
        (registration) => {
          if (contractVersion === 2) {
            registration.registerDecisionProvider({
              id: "fixture",
              contractVersion: 2,
              provider: { label: "Fixture", auth: [] },
              async evaluate() {
                throw new Error("Inspection must not evaluate a V2 provider");
              },
            });
            return;
          }
          registration.registerDecisionProvider({
            id: "fixture",
            contractVersion: 1,
            async evaluate() {
              if (++calls > 1) {
                return { status: "unavailable", reason: "transport" };
              }
              return {
                status: "ok",
                result: {
                  model: "fast",
                  answers: { check: { type: "boolean", probabilityTrue: 1 } },
                  usage,
                },
              };
            },
          });
        },
        api,
        builder.registry,
        record.id,
      );
      builder.registry.plugins.push(record);
      onTestFinished(async () => {
        await getPluginInstance(record)?.dispose();
      });
    }
    setActivePluginRegistry(builder.registry);
    if (legacy) {
      for (let index = 0; index < 2; index++) {
        await evaluateDecisionInRegistry(
          { state: "synthetic", questions: { check: { type: "boolean" } } },
          {
            purpose: "inspection-proof",
            rubricVersion: "1",
            timeoutMs: 1000,
            signal: new AbortController().signal,
          },
          builder.registry,
          config,
        );
      }
    }
    const inspection = {
      ok: true,
      plugin: { id: record.id, name: "Decision fixture", installed: true, enabled: true },
      declared: {
        ...mergePluginDeclaredSurfaces([]),
        contracts: ["decisionProviders: fixture"],
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
      components: emptyInstalledPluginComponents(),
    };
    inspect.mockResolvedValueOnce(inspection);
    const options = pluginRequest("plugins.inspect", { pluginId: record.id }, {
      getRuntimeConfig: () => config,
    } as GatewayRequestContext);
    await withPluginRuntimeRegistryScope(builder.registry, () =>
      pluginsHandlers["plugins.inspect"]!(options),
    );
    const decision = {
      providerId: "fixture",
      pluginId: record.id,
      configured: true,
      callable: true,
      activeRequests: 0,
      successCount: legacy ? 1 : 0,
      usage: legacy ? usage : { inputTokens: 0, outputTokens: 0 },
      reasons: legacy ? { transport: 1 } : {},
      ...(legacy ? { credentialReady: false } : {}),
    };
    expect(options.respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ decisions: registered ? [expect.objectContaining(decision)] : [] }),
      undefined,
    );
    const response: unknown = options.respond.mock.calls[0]?.[1];
    if (contractVersion === 2) {
      expect(response).not.toHaveProperty("decisions.0.credentialReady");
    }
    expect(Value.Check(PluginsInspectResultSchema, response)).toBe(true);
    expect(Value.Check(PluginsInspectResultSchema, inspection)).toBe(true);
    if (registered) {
      const observed = builder.registry.decisionProviders[0]!.host.inspect(config);
      for (const malformed of [
        { ...observed, activeRequests: -1 },
        { ...observed, reasons: { unrecognized: 1 } },
        { ...observed, apiKey: "must-not-be-exposed" },
      ]) {
        expect(
          Value.Check(PluginsInspectResultSchema, { ...inspection, decisions: [malformed] }),
        ).toBe(false);
      }
    }
  },
);
