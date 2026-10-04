import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DispatchReplyFromConfig } from "./dispatch-from-config.types.js";
import type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "./reply-dispatcher.js";

type BufferedDispatchFn =
  typeof import("../dispatch.js").dispatchInboundMessageWithBufferedDispatcherInternal;
type PlainDispatchFn = typeof import("../dispatch.js").dispatchInboundMessageWithDispatcherInternal;

const hoisted = vi.hoisted(() => ({
  bufferedDispatchMock: vi.fn(),
  plainDispatchMock: vi.fn(),
}));
// mock-isolation: Test wrapper forwarding without reply execution or foreground lease state.
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithBufferedDispatcherInternal: (...args: Parameters<BufferedDispatchFn>) =>
    hoisted.bufferedDispatchMock(...args),
  dispatchInboundMessageWithDispatcherInternal: (...args: Parameters<PlainDispatchFn>) =>
    hoisted.plainDispatchMock(...args),
}));

const { dispatchReplyWithBufferedBlockDispatcherCore, dispatchReplyWithDispatcherCore } =
  await import("./provider-dispatcher.js");

const dispatchResult = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
};

describe("provider dispatcher wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.bufferedDispatchMock.mockResolvedValue(dispatchResult);
    hoisted.plainDispatchMock.mockResolvedValue(dispatchResult);
  });

  it("forwards allowed tools and the owning dispatcher through the buffered wrapper", async () => {
    const dispatcherOptions = {
      deliver: async () => ({ visibleReplySent: false }),
    } satisfies ReplyDispatcherWithTypingOptions;
    const dispatchReplyFromConfig = vi.fn<DispatchReplyFromConfig>();

    await dispatchReplyWithBufferedBlockDispatcherCore({
      ctx: { Body: "hello" },
      cfg: {} as OpenClawConfig,
      dispatcherOptions,
      toolsAllow: ["message"],
      dispatchReplyFromConfig,
    });

    expect(hoisted.bufferedDispatchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.bufferedDispatchMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        dispatcherOptions,
        toolsAllow: ["message"],
        dispatchReplyFromConfig,
      }),
    );
  });

  it("forwards runtime toolsAllow through the plain wrapper", async () => {
    const dispatcherOptions = {
      deliver: async () => ({ visibleReplySent: false }),
    } satisfies ReplyDispatcherOptions;

    await dispatchReplyWithDispatcherCore({
      ctx: { Body: "hello" },
      cfg: {} as OpenClawConfig,
      dispatcherOptions,
      toolsAllow: ["message"],
    });

    expect(hoisted.plainDispatchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.plainDispatchMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        dispatcherOptions,
        toolsAllow: ["message"],
      }),
    );
  });
});
