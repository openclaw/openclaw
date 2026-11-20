import { expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { createLegacyPluginSdkReplyDispatch } from "./legacy-sdk-reply-dispatch.js";
import { LegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { createIdleReplyDispatcher } from "./reply-dispatch.test-support.js";

const { acpLoaded, providerLoaded, acp, buffered, plain } = vi.hoisted(() => ({
  acpLoaded: vi.fn(),
  providerLoaded: vi.fn(),
  acp: vi.fn(),
  buffered: vi.fn(),
  plain: vi.fn(),
}));

// mock-isolation: Observe the lazy ACP import without evaluating its real dispatch module graph.
vi.mock("../auto-reply/reply/dispatch-acp-sdk.js", () => {
  acpLoaded();
  return { tryDispatchAcpReplyHookCore: acp };
});
// mock-isolation: Count shared lazy provider loads without evaluating the real reply-dispatch graph.
vi.mock("../auto-reply/reply/provider-dispatcher.runtime.js", () => {
  providerLoaded();
  return {
    dispatchReplyWithBufferedBlockDispatcherCore: buffered,
    dispatchReplyWithDispatcherCore: plain,
  };
});

it("keeps host construction light and lazily delegates whole operations to raw runtimes", async () => {
  const host = new LegacyPluginSdkResourceHost(createLegacyPluginSdkReplyDispatch());
  const ctx = buildTestCtx({ Body: "hello", SessionKey: "agent:test:owner" });
  const params = { ctx, cfg: {}, dispatcherOptions: { deliver: async () => {} } };
  const result = { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
  const failure = new Error("synthetic provider failure");
  acp.mockResolvedValue({ handled: true, ...result });
  buffered.mockResolvedValue(result);
  plain.mockRejectedValue(failure);
  try {
    expect(acpLoaded).not.toHaveBeenCalled();
    expect(providerLoaded).not.toHaveBeenCalled();
    await expect(
      host.invokeReplyDispatch((reply) =>
        reply.tryDispatchAcpReplyHook(
          {
            ctx,
            inboundAudio: false,
            shouldRouteToOriginating: false,
            shouldSendToolSummaries: false,
            shouldSendFullToolDetails: false,
            sendPolicy: "allow",
          },
          {
            cfg: {},
            dispatcher: createIdleReplyDispatcher(),
            recordProcessed() {},
            markIdle() {},
          },
        ),
      ),
    ).resolves.toEqual({ handled: true, ...result });
    expect(acp).toHaveBeenCalledOnce();
    expect(providerLoaded).not.toHaveBeenCalled();
    await expect(
      host.invokeReplyDispatch((reply) => reply.dispatchReplyWithBufferedBlockDispatcher(params)),
    ).resolves.toBe(result);
    await expect(
      host.invokeReplyDispatch((reply) => reply.dispatchReplyWithDispatcher(params)),
    ).rejects.toBe(failure);
    expect(buffered).toHaveBeenCalledExactlyOnceWith(params);
    expect(plain).toHaveBeenCalledExactlyOnceWith(params);
    expect(providerLoaded).toHaveBeenCalledOnce();
  } finally {
    await host.close();
  }
});
