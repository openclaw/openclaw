import { expect, it, vi } from "vitest";
import { buildPluginApi } from "./api-builder.js";
import { runPluginRegistration } from "./api-lifecycle.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function createPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"] = {}) {
  return buildPluginApi({
    id: "late-call-fixture",
    name: "Late Call Fixture",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {} as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (input) => input,
    handlers,
  });
}

function captureRegisteredPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"]) {
  let captured = createPluginApi(handlers);
  runPluginRegistration((pluginApi) => {
    captured = pluginApi;
  }, captured);
  return captured;
}

it("keeps path resolution available to registered callbacks", () => {
  const api = captureRegisteredPluginApi({});

  expect(api.resolvePath("models/model.onnx")).toBe("models/model.onnx");
});

it("lets registered callbacks construct inline view results", () => {
  const api = captureRegisteredPluginApi({});
  const result = api.inlineView(
    "incident",
    { id: "incident-42" },
    {
      version: 1,
      summary: "Showing incident 42.",
    },
  );

  expect(result).toEqual({
    content: [{ type: "text", text: "Showing incident 42." }],
    details: {
      pluginInlineView: {
        pluginId: "late-call-fixture",
        viewId: "incident",
        version: 1,
        payload: { id: "incident-42" },
        summary: "Showing incident 42.",
      },
    },
  });
});

it.each<[string, unknown, boolean]>([
  ["runContext.clearRunContext", undefined, true],
  ["agent.events.emitAgentEvent", { emitted: false, reason: "not wired" }, true],
  ["enqueueNextTurnInjection", { enqueued: false, id: "", sessionKey: "agent:main:main" }, true],
  [
    "session.workflow.enqueueNextTurnInjection",
    { enqueued: false, id: "", sessionKey: "agent:main:main" },
    true,
  ],
  ["session.workflow.steerActiveRun", { steered: false, reason: "not wired" }, true],
  ["runContext.getRunContext", undefined, true],
  ["session.workflow.sendSessionAttachment", { ok: false, error: "not wired" }, true],
  ["session.workflow.scheduleSessionTurn", undefined, true],
  ["runContext.setRunContext", false, true],
  ["session.workflow.unscheduleSessionTurnsByTag", { removed: 0, failed: 0 }, true],
  ["registerSessionSchedulerJob", undefined, false],
  ["registerTool", undefined, false],
  ["session.state.registerSessionExtension", undefined, false],
  ["session.controls.registerSessionAction", undefined, false],
  ["unknown", undefined, false],
  ["__proto__", undefined, false],
])(
  "keeps the unwired default and post-registration eligibility for %s",
  async (methodName, fallback, eligible) => {
    const input = { sessionKey: "agent:main:main", text: "guidance", namespace: "workflow" };
    const output = { forwarded: true };
    const handler = vi.fn(async () => output);
    const path = methodName.split(".");
    const invoke = (api: OpenClawPluginApi) => {
      const method = path.reduce<unknown>(
        (value, key) => (value && typeof value === "object" ? Reflect.get(value, key) : undefined),
        api,
      );
      return typeof method === "function" ? Reflect.apply(method, api, [input]) : undefined;
    };
    expect(await invoke(createPluginApi())).toStrictEqual(fallback);
    const api = captureRegisteredPluginApi({ [path.at(-1)!]: handler });
    expect(await invoke(api)).toBe(eligible ? output : undefined);
    expect(handler.mock.calls).toEqual(eligible ? [[input]] : []);
  },
);
