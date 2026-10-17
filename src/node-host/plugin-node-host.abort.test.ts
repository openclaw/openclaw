import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import { handleInvoke } from "./invoke.js";

afterEach(resetPluginRuntimeStateForTest);
type Command = PluginNodeHostCommandRegistration["command"];
function register(command: Command, withPlugin = false) {
  const registry = createEmptyPluginRegistry();
  if (withPlugin) {
    registry.plugins.push(
      createPluginRecord({
        id: "fixture",
        source: "test",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      }),
    );
  }
  registry.nodeHostCommands = [{ pluginId: "fixture", command, source: "test" }];
  setActivePluginRegistry(registry);
  return vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
}
function invoke(
  request: GatewayClient["request"],
  options: NonNullable<Parameters<typeof handleInvoke>[4]>,
  payload: Partial<Parameters<typeof handleInvoke>[0]> = {},
) {
  return handleInvoke(
    { id: "invocation", nodeId: "paired-node", command: "fixture.command", ...payload },
    { request } as unknown as GatewayClient,
    { current: async () => [] },
    undefined,
    options,
  );
}

it("passes the actual invocation signal into the node-owned plugin context", async ({ signal }) => {
  const controller = new AbortController();
  const handlerReady = createDeferred();
  const sendNodeEvent = vi.fn(async () => undefined);
  const handle = vi.fn<Command["handle"]>(async (_paramsJSON, _io, context) => {
    await new Promise<void>((_resolve, reject) => {
      context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
        once: true,
      });
      handlerReady.resolve();
    });
    return '{"stale":true}';
  });
  const request = register({ command: "fixture.command", cap: "local-inference", handle }, true);
  const invocation = invoke(
    request,
    { signal: controller.signal, pluginCommandContext: { sendNodeEvent } },
    {
      paramsJSON: '{"model":"local-only:small"}',
      sessionKey: "agent:main:local-model",
    },
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        handlerReady.promise,
        invocation,
        "node plugin invocation settled before its handler installed the abort listener",
      ),
      signal,
    );
  } finally {
    controller.abort(new Error("paired inference canceled"));
    await invocation;
  }

  expect(handle).toHaveBeenCalledOnce();
  expect(handle).toHaveBeenCalledWith('{"model":"local-only:small"}', undefined, {
    sendNodeEvent,
    sessionKey: "agent:main:local-model",
    signal: controller.signal,
    prepareExecAuthorization: expect.any(Function),
  });
  expect(request).not.toHaveBeenCalled();
});

it.each(["success", "failure", "cancellation", "supersession", "different-error"] as const)(
  "settles pending asynchronous plugin listener delivery before result (%s)",
  async (outcome) => {
    const listener = createDeferred();
    const controller = new AbortController();
    let currentInvocation = true;
    let framedFailure: Error | undefined;
    const framedIo = createNodeDuplexEndpoint({
      sendFrame: async () => undefined,
      onError: (error) => {
        framedFailure = error;
        controller.abort(error);
      },
    });
    controller.signal.addEventListener("abort", () => framedIo.close(), { once: true });
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: controller.signal,
      emitChunk: vi.fn(async (_chunk: string) => undefined),
      onInput: vi.fn(),
      frames: framedIo,
    };
    const handle = vi.fn<Command["handle"]>(async (_paramsJSON, commandIo) => {
      commandIo?.frames?.onMessage(async () => await listener.promise);
      framedIo.receive(
        JSON.stringify({ v: 1, kind: "data", message: 0, index: 0, last: true, data: "Bw==" }),
      );
      if (outcome === "different-error") {
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("identical framed failure message")),
            { once: true },
          );
        });
      }
      return '{"ok":true}';
    });
    const request = register({ command: "fixture.command", duplex: true, handle });
    const invocation = invoke(request, {
      signal: controller.signal,
      pluginCommandIo: io,
      flushPluginCommandIo: framedIo.drain,
      canReportAbortedFailure: (error) =>
        currentInvocation && error === framedFailure && error === controller.signal.reason,
    });

    try {
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
      expect(request).not.toHaveBeenCalled();
      if (outcome === "failure") {
        listener.reject(new Error("asynchronous plugin listener rejected"));
      } else if (outcome === "cancellation") {
        controller.abort(new Error("plugin command canceled"));
      } else if (outcome === "supersession") {
        currentInvocation = false;
        listener.reject(new Error("superseded plugin listener rejected"));
      } else if (outcome === "different-error") {
        listener.reject(new Error("identical framed failure message"));
      } else {
        listener.resolve();
      }
      await invocation;

      if (outcome === "success" || outcome === "failure") {
        expect(request).toHaveBeenCalledWith(
          "node.invoke.result",
          expect.objectContaining(
            outcome === "success"
              ? { ok: true, payloadJSON: '{"ok":true}' }
              : {
                  ok: false,
                  error: {
                    code: "INVALID_REQUEST",
                    message: "Error: asynchronous plugin listener rejected",
                  },
                },
          ),
        );
      } else {
        expect(controller.signal.aborted).toBe(true);
        expect(request).not.toHaveBeenCalled();
      }
    } finally {
      listener.resolve();
      framedIo.close();
      await invocation;
    }
  },
);
