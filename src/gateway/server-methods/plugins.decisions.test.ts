import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { PluginsInspectResultSchema } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { evaluateDecisionInRegistry } from "../../decisions/runtime.js";
import { emptyInstalledPluginComponents } from "../../plugins/installed-plugin-components.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./types.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("../../plugins/management-service.js", () => ({
  inspectManagedPlugin: inspect,
  listManagedPlugins: vi.fn(),
}));
const { pluginsHandlers } = await import("./plugins.js");

afterEach(() => resetPluginRuntimeStateForTest());

it.each([false, true])(
  "validates the actual inspection response with a decision provider: %s",
  async (registered) => {
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
        (registration) =>
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
                  usage: { inputTokens: 2, outputTokens: 1 },
                },
              };
            },
          }),
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
    if (registered) {
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
      reviewToken: "synthetic-review-token",
      declared: {
        channels: [],
        providers: [],
        tools: [],
        contracts: ["decisionProviders: fixture"],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
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
    let response: unknown;
    await withPluginRuntimeRegistryScope(builder.registry, () =>
      pluginsHandlers["plugins.inspect"]!({
        req: {
          type: "req",
          id: "inspect",
          method: "plugins.inspect",
          params: { pluginId: record.id },
        },
        params: { pluginId: record.id },
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
    expect(response).toMatchObject({
      decisions: registered
        ? [
            {
              providerId: "fixture",
              pluginId: record.id,
              configured: true,
              credentialReady: true,
              callable: true,
              successCount: 1,
              activeRequests: 0,
              usage: { inputTokens: 2, outputTokens: 1 },
              reasons: { transport: 1 },
            },
          ]
        : [],
    });
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
