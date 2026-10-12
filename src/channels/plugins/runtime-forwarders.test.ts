// Runtime forwarder tests cover channel plugin runtime method delegation and fallback handling.
import { describe, expect, it, vi } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
} from "./runtime-forwarders.js";
import type { ChannelOutboundAdapter } from "./types.adapters.js";

describe("createRuntimeDirectoryLiveAdapter", () => {
  it("forwards live directory calls through the runtime getter", async () => {
    const self = vi.fn(async (_ctx: unknown) => ({ kind: "user" as const, id: "self" }));
    const listPeersLive = vi.fn(async (_ctx: unknown) => [{ kind: "user" as const, id: "alice" }]);
    const adapter = createRuntimeDirectoryLiveAdapter({
      getRuntime: async () => ({ self, listPeersLive }),
      self: (runtime) => runtime.self,
      listPeersLive: (runtime) => runtime.listPeersLive,
    });

    await expect(adapter.self?.({ cfg: {} as never, runtime: {} as never })).resolves.toEqual({
      kind: "user",
      id: "self",
    });
    await expect(
      adapter.listPeersLive?.({ cfg: {} as never, runtime: {} as never, query: "a", limit: 1 }),
    ).resolves.toEqual([{ kind: "user", id: "alice" }]);
    expect(self).toHaveBeenCalled();
    expect(listPeersLive).toHaveBeenCalled();
  });
});

describe("createRuntimeOutboundDelegates", () => {
  it("resolves the current runtime and method for each call", async () => {
    const firstSender = vi.fn(async () => ({ channel: "x", messageId: "first" }));
    const secondSender = vi.fn(async () => ({ channel: "x", messageId: "second" }));
    let sender = firstSender;
    const params = {
      getRuntime: vi.fn(async () => ({ sendText: sender })),
      sendText: { resolve: (runtime: { sendText: typeof firstSender }) => runtime.sendText },
    };
    const outbound = createRuntimeOutboundDelegates(params);
    const ctx = { cfg: {}, to: "a", text: "hi" };

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
      sendPoll: {
        resolve: () => undefined,
        unavailableMessage: "poll unavailable",
      },
    });

    const error = await outbound
      .sendPoll?.({
        cfg: {} as never,
        to: "a",
        poll: { question: "q", options: ["a"] },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ message: "poll unavailable" });
  });

  it("classifies outbound runtime loading failures before method dispatch", async () => {
    const loadError = new Error("runtime import failed");
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => {
        throw loadError;
      },
      sendText: {
        resolve: (runtime: { sendText?: ChannelOutboundAdapter["sendText"] }) => runtime.sendText,
      },
    });

    await expect(
      outbound.sendText?.({ cfg: {} as never, to: "a", text: "hi" }),
    ).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      message: "runtime import failed",
      cause: loadError,
    });
  });

  it("preserves presentation runtime loading failures without classifying dispatch", async () => {
    const loadError = new Error("renderer import failed");
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => {
        throw loadError;
      },
      renderPresentation: {
        resolve: () => undefined,
        unavailableMessage: "renderer unavailable",
      },
    });

    await expect(
      outbound.renderPresentation?.({
        payload: { text: "raw" },
        presentation: { blocks: [{ type: "text", text: "shown" }] },
        ctx: { cfg: {}, to: "a", text: "raw", payload: { text: "raw" } },
      }),
    ).rejects.toBe(loadError);
  });
});
