// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isHostProgressSupervisorPayload } from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { createDispatcher, mocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  installThreadingTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig progress supervisor", () => {
  beforeEach(describe0BeforeEach0);

  it.each([
    {
      label: "heartbeat",
      ctx: buildTestCtx({ Provider: "telegram", ChatType: "direct" }),
      replyOptions: { isHeartbeat: true },
    },
    {
      label: "room event",
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        InboundEventKind: "room_event",
      }),
      replyOptions: undefined,
    },
  ])("does not supervise an intentionally quiet $label turn", async ({ ctx, replyOptions }) => {
    vi.useFakeTimers();
    setNoAbort();
    let finish!: (payload: ReplyPayload) => void;
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dispatcher = createDispatcher();
    const run = dispatchReplyFromConfig({
      ctx,
      cfg: {
        agents: { defaults: { progressSupervisor: { enabled: true, intervalSeconds: 5 } } },
      },
      dispatcher,
      replyOptions,
      replyResolver: () => {
        started();
        return new Promise<ReplyPayload>((resolve) => {
          finish = resolve;
        });
      },
    });

    await resolverStarted;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    finish({ text: "done" });
    await run;
  });

  it("delivers a supervised notice through the queued dispatcher receipt", async () => {
    vi.useFakeTimers();
    setNoAbort();
    let finish!: (payload: ReplyPayload) => void;
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dispatcher = createDispatcher();
    const run = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:main",
      }),
      cfg: {
        agents: { defaults: { progressSupervisor: { enabled: true, intervalSeconds: 5 } } },
      },
      dispatcher,
      replyResolver: () => {
        started();
        return new Promise<ReplyPayload>((resolve) => {
          finish = resolve;
        });
      },
    });

    await resolverStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    const notice = vi
      .mocked(dispatcher.sendToolResult)
      .mock.calls.map(([payload]) => payload)
      .find(isHostProgressSupervisorPayload);
    expect(notice).toBeDefined();
    finish({ text: "done" });
    await run;
  });

  it("drops a queued supervised notice that becomes stale before beforeDeliver", async () => {
    vi.useFakeTimers();
    setNoAbort();
    let releaseNotice!: () => void;
    const noticeGate = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
    const deliver = vi.fn(async (_payload: ReplyPayload) => undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async (payload) => {
        if (isHostProgressSupervisorPayload(payload)) {
          await noticeGate;
        }
        return payload;
      },
    });
    let options: GetReplyOptions | undefined;
    let finish!: (payload: ReplyPayload) => void;
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:main",
      }),
      cfg: {
        agents: { defaults: { progressSupervisor: { enabled: true, intervalSeconds: 5 } } },
      },
      dispatcher,
      replyOptions: { onPartialReply: vi.fn(() => true) },
      replyResolver: (_ctx, opts) => {
        options = opts;
        started();
        return new Promise<ReplyPayload>((resolve) => {
          finish = resolve;
        });
      },
    });

    await resolverStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await options?.onPartialReply?.({ text: "visible progress" });
    releaseNotice();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver.mock.calls.some(([payload]) => isHostProgressSupervisorPayload(payload))).toBe(
      false,
    );
    finish({ text: "done" });
    await run;
  });

  it("does not reset quiet time for suppressed progress and does reset it for visible fast-mode progress", async () => {
    vi.useFakeTimers();
    setNoAbort();
    let finish!: (payload: ReplyPayload) => void;
    let options: GetReplyOptions | undefined;
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn(() => true);
    const run = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:main",
      }),
      cfg: {
        agents: { defaults: { progressSupervisor: { enabled: true, intervalSeconds: 5 } } },
      },
      dispatcher,
      replyOptions: {
        onPartialReply: vi.fn(() => false),
        onToolResult,
        forceToolResultProgress: true,
      },
      replyResolver: (_ctx, opts) => {
        options = opts;
        started();
        return new Promise<ReplyPayload>((resolve) => {
          finish = resolve;
        });
      },
    });

    await resolverStarted;
    await vi.advanceTimersByTimeAsync(4_000);
    await options?.onPartialReply?.({ text: "suppressed progress" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      vi
        .mocked(dispatcher.sendToolResult)
        .mock.calls.some(([p]) => isHostProgressSupervisorPayload(p)),
    ).toBe(true);

    vi.mocked(dispatcher.sendToolResult).mockClear();
    await options?.onToolResult?.({
      text: "Fast mode progress",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(
      vi
        .mocked(dispatcher.sendToolResult)
        .mock.calls.some(([p]) => isHostProgressSupervisorPayload(p)),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      vi
        .mocked(dispatcher.sendToolResult)
        .mock.calls.some(([p]) => isHostProgressSupervisorPayload(p)),
    ).toBe(true);
    finish({ text: "done" });
    await run;
  });

  it("keeps final fallback recovery eligible when a delivered notice precedes cancellation", async () => {
    vi.useFakeTimers();
    setNoAbort();
    const deliver = vi.fn(async (_payload: ReplyPayload) => undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async (payload) => (isHostProgressSupervisorPayload(payload) ? payload : null),
    });
    let finish!: () => void;
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: {
        agents: { defaults: { progressSupervisor: { enabled: true, intervalSeconds: 5 } } },
      },
      dispatcher,
      replyResolver: () => {
        started();
        return new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        });
      },
    });

    await resolverStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(isHostProgressSupervisorPayload(deliver.mock.calls[0]![0])).toBe(true);
    finish();
    const result = await run;

    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("routes notices to the originating channel and joins an in-flight send before finalization", async () => {
    vi.useFakeTimers();
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
    let releaseNotice!: () => void;
    const noticePending = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
    mocks.routeReply.mockImplementation(async (params: { payload?: ReplyPayload }) => {
      if (params.payload && isHostProgressSupervisorPayload(params.payload)) {
        await noticePending;
      }
      return { ok: true, delivered: true, messageId: "mock" };
    });
    let finish!: (payload: ReplyPayload) => void;
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
        SessionKey: "agent:main:main",
      }),
      cfg: {
        agents: { defaults: { progressSupervisor: { enabled: true, intervalSeconds: 5 } } },
      },
      dispatcher: createDispatcher(),
      replyResolver: () => {
        started();
        return new Promise<ReplyPayload>((resolve) => {
          finish = resolve;
        });
      },
    });

    await resolverStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    finish({ text: "done" });
    let completed = false;
    void run.then(() => (completed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    releaseNotice();
    await run;
    expect(
      mocks.routeReply.mock.calls.some(([params]) =>
        isHostProgressSupervisorPayload((params as { payload: ReplyPayload }).payload),
      ),
    ).toBe(true);
  });
});
