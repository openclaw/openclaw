import { expect, it, vi } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
} from "./runtime-forwarders.js";

const ctx = { cfg: {}, to: "a", text: "hi" };
const directoryCtx = { cfg: {}, runtime: {} as never };

it("forwards live directory calls through the runtime getter", async () => {
  const adapter = createRuntimeDirectoryLiveAdapter({
    getRuntime: async () => ({
      self: async () => ({ kind: "user" as const, id: "self" }),
      listPeersLive: async () => [{ kind: "user" as const, id: "alice" }],
    }),
    self: (runtime) => runtime.self,
    listPeersLive: (runtime) => runtime.listPeersLive,
  });

  await expect(adapter.self?.(directoryCtx)).resolves.toEqual({ kind: "user", id: "self" });
  await expect(adapter.listPeersLive?.({ ...directoryCtx, query: "a", limit: 1 })).resolves.toEqual(
    [{ kind: "user", id: "alice" }],
  );
});

it("resolves the current runtime and method for each call", async () => {
  const firstSender = vi.fn(async () => ({ channel: "x", messageId: "first" }));
  const secondSender = vi.fn(async () => ({ channel: "x", messageId: "second" }));
  let sender = firstSender;
  const params = {
    getRuntime: vi.fn(async () => ({ sendText: sender })),
    sendText: { resolve: (runtime: { sendText: typeof firstSender }) => runtime.sendText },
  };
  const outbound = createRuntimeOutboundDelegates(params);

  expect(params.getRuntime).not.toHaveBeenCalled();
  await expect(outbound.sendText?.(ctx)).resolves.toMatchObject({ messageId: "first" });
  sender = secondSender;
  await expect(outbound.sendText?.(ctx)).resolves.toMatchObject({ messageId: "second" });
  expect(params.getRuntime).toHaveBeenCalledTimes(2);
  expect(firstSender).toHaveBeenCalledWith(ctx);
  expect(secondSender).toHaveBeenCalledWith(ctx);
});

it("classifies unavailable outbound runtime methods as definitely not dispatched", async () => {
  const outbound = createRuntimeOutboundDelegates({
    getRuntime: async () => ({ outbound: {} }),
    sendPoll: { resolve: () => undefined, unavailableMessage: "poll unavailable" },
  });

  const result = outbound.sendPoll?.({ ...ctx, poll: { question: "q", options: ["a"] } });
  await expect(result).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
  await expect(result).rejects.toMatchObject({ message: "poll unavailable" });
});

it("classifies outbound runtime loading failures before method dispatch", async () => {
  const loadError = new Error("runtime import failed");
  const outbound = createRuntimeOutboundDelegates({
    getRuntime: () => Promise.reject(loadError),
    sendText: { resolve: () => undefined },
  });

  await expect(outbound.sendText?.(ctx)).rejects.toMatchObject({
    name: "PlatformMessageNotDispatchedError",
    message: "runtime import failed",
    cause: loadError,
  });
});

it("preserves presentation runtime loading failures without classifying dispatch", async () => {
  const loadError = new Error("renderer import failed");
  const outbound = createRuntimeOutboundDelegates({
    getRuntime: () => Promise.reject(loadError),
    renderPresentation: { resolve: () => undefined, unavailableMessage: "renderer unavailable" },
  });

  await expect(
    outbound.renderPresentation?.({
      payload: { text: "raw" },
      presentation: { blocks: [{ type: "text", text: "shown" }] },
      ctx: { ...ctx, text: "raw", payload: { text: "raw" } },
    }),
  ).rejects.toBe(loadError);
});
