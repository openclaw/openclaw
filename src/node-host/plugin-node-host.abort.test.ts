import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { handleInvoke } from "./invoke.js";
import { registerCommands } from "./node-host-command.fixture.test-support.js";

afterEach(resetPluginRuntimeStateForTest);

function startInvocation(
  command: PluginNodeHostCommandRegistration["command"],
  runtime: Parameters<typeof handleInvoke>[4],
) {
  const registry = registerCommands(command);
  if (!runtime?.pluginCommandContext) {
    registry.plugins = [];
  }
  const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
  const invocation = handleInvoke(
    { id: "invocation", nodeId: "paired-node", command: command.command },
    { request } as unknown as GatewayClient,
    { current: async () => [] },
    undefined,
    runtime,
  );
  return { request, invocation };
}

it("passes the actual invocation signal into the non-duplex plugin context", async ({ signal }) => {
  const controller = new AbortController();
  const handlerReady = createDeferred();
  const handle: PluginNodeHostCommandRegistration["command"]["handle"] = async (
    _params,
    _io,
    context,
  ) => {
    expect(context?.signal).toBe(controller.signal);
    const aborted = createDeferred();
    context?.signal?.addEventListener("abort", () => aborted.reject(context.signal?.reason), {
      once: true,
    });
    handlerReady.resolve();
    await aborted.promise;
    return '{"stale":true}';
  };
  const { request, invocation } = startInvocation(
    { command: "ollama.chat", handle },
    { signal: controller.signal, pluginCommandContext: { sendNodeEvent: vi.fn(async () => {}) } },
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        handlerReady.promise,
        invocation,
        "invocation settled before its abort listener",
      ),
      signal,
    );
  } finally {
    controller.abort(new Error("paired inference canceled"));
    await invocation;
  }
  expect(request).not.toHaveBeenCalled();
});

it.each(["success", "failure", "cancellation", "supersession", "different-error"] as const)(
  "settles asynchronous plugin listener delivery before result (%s)",
  async (outcome) => {
    const listener = createDeferred();
    const controller = new AbortController();
    let currentInvocation = true;
    let framedFailure: Error | undefined;
    const frames = createNodeDuplexEndpoint({
      sendFrame: async () => undefined,
      onError: (error) => {
        framedFailure = error;
        controller.abort(error);
      },
    });
    controller.signal.addEventListener("abort", () => frames.close(), { once: true });
    const handle = vi.fn<PluginNodeHostCommandRegistration["command"]["handle"]>(
      async (_params, commandIo) => {
        commandIo?.frames?.onMessage(async () => await listener.promise);
        frames.receive(
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
      },
    );
    const { request, invocation } = startInvocation(
      { command: "fixture.duplex", duplex: true, handle },
      {
        signal: controller.signal,
        pluginCommandIo: {
          signal: controller.signal,
          emitChunk: async () => {},
          onInput: () => {},
          frames,
        },
        flushPluginCommandIo: frames.drain,
        canReportAbortedFailure: (error) =>
          currentInvocation && error === framedFailure && error === controller.signal.reason,
      },
    );
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
        const result =
          outcome === "success"
            ? { ok: true, payloadJSON: '{"ok":true}' }
            : {
                ok: false,
                error: {
                  code: "INVALID_REQUEST",
                  message: "Error: asynchronous plugin listener rejected",
                },
              };
        expect(request).toHaveBeenCalledWith("node.invoke.result", expect.objectContaining(result));
      } else {
        expect(controller.signal.aborted).toBe(true);
        expect(request).not.toHaveBeenCalled();
      }
    } finally {
      listener.resolve();
      frames.close();
      await invocation;
    }
  },
);
