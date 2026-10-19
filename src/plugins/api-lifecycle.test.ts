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
  it("returns inert results for unwired runtime and scheduler handlers", async () => {
    const api = createPluginApi();
    const sessionKey = "agent:main:main";

    expect({
      event: api.emitAgentEvent({ runId: "run", stream: "lifecycle", data: {} }),
      setContext: api.setRunContext({ runId: "run", namespace: "workflow", value: 1 }),
      getContext: api.getRunContext({ runId: "run", namespace: "workflow" }),
      registerJob: api.registerSessionSchedulerJob({ id: "job", sessionKey, kind: "session-turn" }),
      injection: await api.enqueueNextTurnInjection({ sessionKey, text: "queued" }),
      steering: await api.session.workflow.steerActiveRun({ sessionKey, text: "guidance" }),
      attachment: await api.sendSessionAttachment({
        sessionKey,
        files: [{ path: "/tmp/attachment.txt" }],
      }),
      schedule: await api.scheduleSessionTurn({ sessionKey, message: "wake", delayMs: 1_000 }),
      unschedule: await api.unscheduleSessionTurnsByTag({ sessionKey, tag: "wake" }),
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

  it("keeps both next-turn injection APIs callable after registration", async () => {
    const enqueueNextTurnInjection = vi.fn(async (injection) => ({
      enqueued: true,
      id: `injection-${injection.text}`,
      sessionKey: injection.sessionKey,
    }));
    const api = captureRegisteredPluginApi({ enqueueNextTurnInjection });
    const grouped = { sessionKey: "global", text: "grouped", agentId: "work" };
    const flat = { sessionKey: "global", text: "flat", agentId: "main" };
    expect([
      await api.session.workflow.enqueueNextTurnInjection(grouped),
      await api.enqueueNextTurnInjection(flat),
    ]).toEqual([
      { enqueued: true, id: "injection-grouped", sessionKey: "global" },
      { enqueued: true, id: "injection-flat", sessionKey: "global" },
    ]);
    expect(enqueueNextTurnInjection.mock.calls).toEqual([[grouped], [flat]]);
  });

  it("keeps workflow steering callable after registration", async () => {
    const steerActiveRun = vi.fn<OpenClawPluginApi["steerActiveRun"]>(async () => ({
      steered: true,
      runId: "active-run",
    }));
    const api = captureRegisteredPluginApi({ steerActiveRun });
    const input = { sessionKey: "agent:main:main", text: "guidance", idempotencyKey: "review-1" };
    await expect(api.session.workflow.steerActiveRun(input)).resolves.toEqual({
      steered: true,
      runId: "active-run",
    });
    expect(steerActiveRun).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("blocks registration-phase methods after registration", () => {
    const registerSessionExtension = vi.fn();
    const api = captureRegisteredPluginApi({ registerSessionExtension });

    expect(
      api.session.state.registerSessionExtension({
        namespace: "workflow",
        description: "workflow",
      }),
    ).toBeUndefined();
    expect(registerSessionExtension).not.toHaveBeenCalled();
  });

  it.each<[string, boolean]>([
    ["clearRunContext", true],
    ["emitAgentEvent", true],
    ["enqueueNextTurnInjection", true],
    ["steerActiveRun", true],
    ["getRunContext", true],
    ["sendSessionAttachment", true],
    ["scheduleSessionTurn", true],
    ["setRunContext", true],
    ["unscheduleSessionTurnsByTag", true],
    ["registerTool", false],
    ["registerSessionExtension", false],
    ["unknown", false],
    ["", false],
    ["constructor", false],
    ["toString", false],
    ["__proto__", false],
  ])("enforces post-registration call eligibility for %j as %s", (methodName, expected) => {
    const handler = vi.fn();
    const api = captureRegisteredPluginApi({ [methodName]: handler });
    const method = Reflect.get(api, methodName);
    const result = typeof method === "function" ? Reflect.apply(method, api, []) : undefined;

    expect(handler).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(result).toBeUndefined();
  });
});
