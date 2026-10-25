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

function startInvocation(
  command: PluginNodeHostCommandRegistration["command"],
  runtime: Parameters<typeof handleInvoke>[4],
  frame: Partial<Parameters<typeof handleInvoke>[0]> = {},
) {
  const pluginId = command.command.split(".")[0]!;
  const registry = createEmptyPluginRegistry();
  registry.plugins = runtime?.pluginCommandContext
    ? [
        createPluginRecord({
          id: pluginId,
          source: "test",
          origin: "bundled",
          enabled: true,
          configSchema: true,
        }),
      ]
    : [];
  registry.nodeHostCommands = [{ pluginId, command, source: "test" }];
  setActivePluginRegistry(registry);
  const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
  const invocation = handleInvoke(
    { id: "invocation", nodeId: "paired-node", command: command.command, ...frame },
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
  const sendNodeEvent = vi.fn(async () => undefined);
  const handle = vi.fn<PluginNodeHostCommandRegistration["command"]["handle"]>(
    async (_paramsJSON, _io, context) => {
      await new Promise<void>((_resolve, reject) => {
        context?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              context.signal?.reason instanceof Error
                ? context.signal.reason
                : new Error("node plugin invocation aborted", { cause: context.signal?.reason }),
            ),
          { once: true },
        );
        handlerReady.resolve();
      });
      return '{"stale":true}';
    },
  );
  const { request, invocation } = startInvocation(
    { command: "ollama.chat", cap: "local-inference", handle },
    { signal: controller.signal, pluginCommandContext: { sendNodeEvent } },
    { paramsJSON: '{"model":"local-only:small"}', sessionKey: "agent:main:local-model" },
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
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: controller.signal,
      emitChunk: vi.fn(async (_chunk: string) => undefined),
      onInput: vi.fn(),
      frames,
    };
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
        pluginCommandIo: io,
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
