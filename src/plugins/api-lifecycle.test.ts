import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { buildPluginApi } from "./api-builder.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
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
  const api = createPluginApi(handlers);
  let captured: OpenClawPluginApi | undefined;
  runPluginRegisterSyncInRegistry(
    (pluginApi) => {
      captured = pluginApi;
    },
    api,
    createEmptyPluginRegistry(),
    "late-call-fixture",
  );
  return expectDefined(captured, "captured plugin api");
}

describe("plugin api lifecycle", () => {
  it("omits retired registrations and exposes runtime capabilities through grouped namespaces", () => {
    const api = captureRegisteredPluginApi({});
    for (const method of [
      "emitAgentEvent",
      "setRunContext",
      "getRunContext",
      "clearRunContext",
      "registerSessionAction",
      "sendSessionAttachment",
      "scheduleSessionTurn",
      "unscheduleSessionTurnsByTag",
      "steerActiveRun",
      "registerCodexAppServerExtensionFactory",
      "registerHostedMediaResolver",
      "registerTextTransforms",
      "registerAgentExecutorController",
    ]) {
      expect(method in api).toBe(false);
    }
    expect(
      api.agent.events.emitAgentEvent({ runId: "run", stream: "lifecycle", data: {} }),
    ).toEqual({
      emitted: false,
      reason: "not wired",
    });
  });

  it("returns inert results for unwired runtime and scheduler handlers", async () => {
    const api = createPluginApi();
    const sessionKey = "agent:main:main";

    expect({
      event: api.agent.events.emitAgentEvent({ runId: "run", stream: "lifecycle", data: {} }),
      setContext: api.runContext.setRunContext({ runId: "run", namespace: "workflow", value: 1 }),
      getContext: api.runContext.getRunContext({ runId: "run", namespace: "workflow" }),
      registerJob: api.registerSessionSchedulerJob({ id: "job", sessionKey, kind: "session-turn" }),
      injection: await api.enqueueNextTurnInjection({ sessionKey, text: "queued" }),
      steering: await api.session.workflow.steerActiveRun({ sessionKey, text: "guidance" }),
      attachment: await api.session.workflow.sendSessionAttachment({
        sessionKey,
        files: [{ path: "/tmp/attachment.txt" }],
      }),
      schedule: await api.session.workflow.scheduleSessionTurn({
        sessionKey,
        message: "wake",
        delayMs: 1_000,
      }),
      unschedule: await api.session.workflow.unscheduleSessionTurnsByTag({
        sessionKey,
        tag: "wake",
      }),
    }).toStrictEqual({
      event: { emitted: false, reason: "not wired" },
      setContext: false,
      getContext: undefined,
      registerJob: undefined,
      injection: { enqueued: false, id: "", sessionKey },
      steering: { steered: false, reason: "not wired" },
      attachment: { ok: false, error: "not wired" },
      schedule: undefined,
      unschedule: { removed: 0, failed: 0 },
    });
  });

  it("keeps inherited handlers, undefined defaults, and one captured CLI lookup", () => {
    const reads: string[] = [];
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    const registerHook = vi.fn<OpenClawPluginApi["registerHook"]>();
    class InheritedHandlers {
      get registerCli() {
        reads.push("cli");
        return registerCli;
      }
      get registerTool() {
        reads.push("tool");
        return undefined;
      }
      get registerHook() {
        reads.push("hook");
        return registerHook;
      }
    }
    const api = createPluginApi(new InheritedHandlers());
    const hook: Parameters<OpenClawPluginApi["registerHook"]>[1] = () => {};
    const registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] = () => {};

    const toolFactory = vi.fn(() => null);
    expect(api.registerTool(toolFactory)).toBeUndefined();
    expect(toolFactory).not.toHaveBeenCalled();
    expect(api).toMatchObject({ registerHook, registerCli });
    api.registerHook("message_received", hook);
    expect(registerHook).toHaveBeenCalledExactlyOnceWith("message_received", hook);
    api.registerNodeCliFeature(registrar, { commands: ["camera"] });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(registrar, {
      commands: ["camera"],
      parentPath: ["nodes"],
    });
    expect(reads).toEqual(["cli", "tool", "hook"]);
  });

  it.each<[string, boolean]>([
    ["runContext.clearRunContext", true],
    ["agent.events.emitAgentEvent", true],
    ["enqueueNextTurnInjection", true],
    ["session.workflow.enqueueNextTurnInjection", true],
    ["session.workflow.steerActiveRun", true],
    ["runContext.getRunContext", true],
    ["session.workflow.sendSessionAttachment", true],
    ["session.workflow.scheduleSessionTurn", true],
    ["runContext.setRunContext", true],
    ["session.workflow.unscheduleSessionTurnsByTag", true],
    ["registerTool", false],
    ["registerSessionExtension", false],
    ["session.state.registerSessionExtension", false],
    ["session.controls.registerSessionAction", false],
    ["unknown", false],
    ["", false],
    ["constructor", false],
    ["toString", false],
    ["__proto__", false],
  ])("enforces post-registration call eligibility for %j as %s", async (methodName, expected) => {
    const input = { sessionKey: "agent:main:main", text: "guidance", namespace: "workflow" };
    const output = { forwarded: true };
    const handler = vi.fn(async () => output);
    const path = methodName.split(".");
    const api = captureRegisteredPluginApi({ [path.at(-1)!]: handler });
    const method = path.reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? Reflect.get(value, key) : undefined),
      api,
    );
    const result = typeof method === "function" ? Reflect.apply(method, api, [input]) : undefined;

    expect(handler.mock.calls).toEqual(expected ? [[input]] : []);
    expect(await result).toBe(expected ? output : undefined);
  });
});
