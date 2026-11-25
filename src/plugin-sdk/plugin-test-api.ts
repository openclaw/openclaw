// Plugin test API helpers construct SDK-shaped host APIs for plugin unit tests.
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { pluginApiDefaultHandlers } from "../plugins/api-builder.js";
import {
  attachPluginApiFacades,
  type OpenClawPluginApiWithoutFacades,
} from "../plugins/api-facades.js";
import { createPluginInlineViewResult } from "../plugins/inline-view.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { OpenClawPluginApi } from "./plugin-runtime.js";

/** Real scheduling ownership with a test clock; callers join it during fixture cleanup. */
export function createTestPluginServiceScheduler(
  scheduler: GatewayScheduler = createTestGatewayScheduler("fake-timers"),
): PluginServiceSchedulerV1 {
  return createPluginServiceScheduler(scheduler).scheduler;
}

/** Partial plugin API overrides accepted by the SDK test helper. */
export type TestPluginApiInput = Partial<OpenClawPluginApi>;

/** Create a minimal plugin API object for plugin-sdk contract and unit tests. */
export function createTestPluginApi(api: TestPluginApiInput = {}): OpenClawPluginApi {
  const { agent, lifecycle, runContext, session, ...flatApi } = api;
  const mergedApi = {
    id: "test-plugin",
    inlineView: (viewId, payload, options) =>
      createPluginInlineViewResult(api.id ?? "test-plugin", viewId, payload, options),
    name: "test-plugin",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...pluginApiDefaultHandlers,
    registerNodeCliFeature() {},
    steerActiveRun: async () => ({ steered: false as const, reason: "test api" }),
    emitAgentEvent: () => ({ emitted: false as const, reason: "test api" }),
    sendSessionAttachment: async () => ({ ok: false, error: "test plugin api" }),
    resolvePath(input: string) {
      return input;
    },
    ...flatApi,
  } satisfies OpenClawPluginApiWithoutFacades;
  // Facades construct the supported namespaces and omit retired flat aliases.
  // Explicit overrides replace only the nested surface under test without
  // rebuilding every no-op method.
  const withFacades = attachPluginApiFacades(mergedApi);
  return {
    ...withFacades,
    ...(agent ? { agent } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(runContext ? { runContext } : {}),
    ...(session ? { session } : {}),
  };
}

export {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
