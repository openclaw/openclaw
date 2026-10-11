// Session-state notice parsing and coalesced producer handoff.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import type {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-handoff.js";
import type { SystemEvent } from "../infra/system-events.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  decodeSessionStateNoticeContextKey,
  enqueueSessionStateNotice,
} from "./session-state-notices.js";

const mocks = vi.hoisted(() => ({
  ownerKey: Symbol("session-state-notices-fixture"),
  pending: [] as SystemEvent[],
  nextOccurrenceId: 0,
  ownedIds: new Set<string>(),
  capture: vi.fn<typeof captureSessionEventTargetForHost>(async () => ({
    sessionId: "original",
    generation: "current",
  })),
  enqueue: vi.fn<typeof enqueueSessionEventForHost>(() => ({
    id: "notice-turn",
    accepted: Promise.resolve({ ok: true }),
    cancel: () => true,
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  })),
  acknowledge: vi.fn(async () => {}),
}));
// A shared worker may retain an earlier module's owner and its different queue/handoff bindings.
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      const [key, ...rest] = args;
      return actual.resolveGlobalSingleton(
        key === Symbol.for("openclaw.sessionStateNotices") ? mocks.ownerKey : key,
        ...rest,
      );
    },
  };
});

// mock-isolation: Exercise the real notice debouncer without starting model or SQLite work.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.capture,
  combineSessionEventTargetsForHost: (targets: readonly SessionEventTarget[]) => targets[0],
  enqueueSessionEventForHost: mocks.enqueue,
  assertSessionEventTargetCurrent: vi.fn(),
}));
// mock-isolation: Fake-time coalescing must not borrow another suite's live store resolver.
vi.mock("../infra/system-event-ownership.js", () => ({ isSystemEventStoreCurrent: () => true }));
// mock-isolation: Keep pending occurrences local so these timer cases cannot drain shared queues.
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventEntry: (text: string, options: Partial<SystemEvent>) => {
    if (
      mocks.pending.some(
        (event) =>
          event.text === text &&
          event.contextKey === options.contextKey &&
          event.sessionStorePath === options.sessionStorePath,
      )
    ) {
      return null;
    }
    const occurrence: SystemEvent = {
      text,
      ...options,
      id: String(mocks.nextOccurrenceId++),
      ts: 1,
    };
    mocks.pending.push(occurrence);
    return occurrence;
  },
  peekSystemEventEntries: () => [...mocks.pending],
  isSystemEventTurnOwned: (_key: string, event: SystemEvent) => mocks.ownedIds.has(event.id ?? ""),
}));
// mock-isolation: Observe adoption without opening cursor writers; the permissions suite covers native custody.
vi.mock("./session-state-notice-acknowledgment.js", () => ({
  acknowledgeSessionStateNoticesInWorker: mocks.acknowledge,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.capture.mockReset().mockResolvedValue({ sessionId: "original", generation: "current" });
  mocks.pending.length = 0;
  mocks.nextOccurrenceId = 0;
  mocks.ownedIds.clear();
});
afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

function encodeTarget(sessionKey: string): string {
  return `session-state:${Buffer.from(sessionKey, "utf8").toString("hex")}`;
}

describe("decodeSessionStateNoticeContextKey", () => {
  it("round-trips a valid encoded session key", () => {
    const sessionKey = "agent:main:slack:channel:C01234567";
    expect(decodeSessionStateNoticeContextKey(encodeTarget(sessionKey))).toBe(sessionKey);
  });

  it("round-trips a session key with a leading U+FEFF unchanged", () => {
    const sessionKey = "﻿agent:main";
    expect(decodeSessionStateNoticeContextKey(encodeTarget(sessionKey))).toBe(sessionKey);
  });

  it("rejects a context key whose hex payload is not valid UTF-8", () => {
    // 0xFF is not valid UTF-8; a forgiving decode would return U+FFFD and let a
    // corrupt context key collide with an unrelated watcher cursor.
    expect(decodeSessionStateNoticeContextKey("session-state:ff")).toBeUndefined();
  });

  it("rejects malformed prefixes and hex payloads", () => {
    expect(decodeSessionStateNoticeContextKey("other:ff")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:abc")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:zz")).toBeUndefined();
  });
});

describe("enqueueSessionStateNotice", () => {
  it.each(["capture refusal", "pre-claim rejection", "released admission"] as const)(
    "recovers an unadopted notice after %s and soft restart",
    async (failure) => {
      const input = {
        watcherSessionKey: "agent:main:main",
        watcherStorePath: "/synthetic/store.sqlite",
        targetSessionKey: "agent:main:child",
        lastSeenSequence: 42,
      };
      if (failure === "capture refusal") {
        mocks.capture.mockRejectedValueOnce(new Error("Gateway is restarting"));
      } else {
        mocks.capture.mockResolvedValueOnce({ sessionId: "original", generation: "retired" });
        mocks.enqueue.mockImplementationOnce(() => {
          if (failure === "pre-claim rejection") {
            throw new Error("Captured lifecycle generation retired before claim");
          }
          return {
            id: "rejected-notice",
            accepted: Promise.resolve({ ok: false, error: "Gateway is restarting" }),
            cancel: () => false,
            settled: Promise.resolve({
              status: "cancelled",
              executionStarted: false,
              delivered: false,
            }),
          };
        });
      }
      mocks.capture.mockResolvedValueOnce({ sessionId: "original", generation: "replacement" });
      enqueueSessionStateNotice(input);
      await vi.advanceTimersByTimeAsync(20_000);
      const original = mocks.pending.find(
        (event) => event.contextKey === encodeTarget(input.targetSessionKey),
      );
      expect(original?.id).toEqual(expect.any(String));
      const priorHandoffs = failure === "capture refusal" ? 0 : 1;
      expect(mocks.enqueue).toHaveBeenCalledTimes(priorHandoffs);
      expect(mocks.acknowledge).not.toHaveBeenCalled();

      await drainGlobalSingletonLifecycleState("restart");
      enqueueSessionStateNotice(input);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.enqueue).toHaveBeenCalledTimes(priorHandoffs + 1);
      const handoff = mocks.enqueue.mock.calls.at(-1)![1];
      expect(handoff.expectedTarget?.generation).toBe("replacement");
      expect(handoff.occurrences?.map((event) => event.id)).toEqual([original?.id]);
      expect(mocks.acknowledge).not.toHaveBeenCalled();
      await handoff.onAdopted?.();
      expect(mocks.acknowledge).toHaveBeenCalledOnce();
    },
  );

  it("rejects a late pre-restart capture without replacing the fresh recovery", async () => {
    const input = {
      watcherSessionKey: "agent:main:main",
      watcherStorePath: "/synthetic/store.sqlite",
      targetSessionKey: "agent:main:child",
      lastSeenSequence: 42,
    };
    const retiredCapture = createDeferred<SessionEventTarget>();
    mocks.capture
      .mockReturnValueOnce(retiredCapture.promise)
      .mockResolvedValueOnce({ sessionId: "original", generation: "replacement" });
    enqueueSessionStateNotice(input);
    await drainGlobalSingletonLifecycleState("restart");
    enqueueSessionStateNotice(input);
    retiredCapture.resolve({ sessionId: "original", generation: "retired" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue.mock.calls[0]![1].expectedTarget?.generation).toBe("replacement");
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("recovers an unadopted notice under fresh authority after soft restart", async () => {
    const input = {
      watcherSessionKey: "agent:main:main",
      watcherStorePath: "/synthetic/store.sqlite",
      targetSessionKey: "agent:main:child",
      lastSeenSequence: 42,
    };
    mocks.pending.push({ id: "passive", text: "Unrelated passive notice", ts: 1 });
    mocks.capture
      .mockResolvedValueOnce({ sessionId: "original", generation: "retired" })
      .mockResolvedValueOnce({ sessionId: "original", generation: "replacement" });
    enqueueSessionStateNotice(input);
    await vi.advanceTimersByTimeAsync(1);
    const original = mocks.pending.find(
      (event) => event.contextKey === encodeTarget(input.targetSessionKey),
    );
    expect(original?.id).toEqual(expect.any(String));

    await drainGlobalSingletonLifecycleState("restart");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    // Startup sweep republishes the still-pending durable cursor, not a caller wake.
    enqueueSessionStateNotice(input);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.enqueue).toHaveBeenCalledOnce();
    const handoff = mocks.enqueue.mock.calls[0]![1];
    expect(handoff.expectedTarget?.generation).toBe("replacement");
    expect(handoff.occurrences).toHaveLength(1);
    expect(handoff.occurrences?.[0]?.id).toBe(original?.id);
    expect(mocks.pending.filter((event) => event.id === "passive")).toHaveLength(1);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    await handoff.onAdopted?.();
    expect(mocks.acknowledge).toHaveBeenCalledOnce();
  });

  it("reserves one occurrence through capture, debounce, and handoff settlement", async () => {
    const input = {
      watcherSessionKey: "agent:main:main",
      targetSessionKey: "agent:main:child",
      lastSeenSequence: 42,
    };
    const capture = createDeferred<SessionEventTarget>();
    const settled = createDeferred<SessionEventOutcome>();
    mocks.capture.mockReturnValueOnce(capture.promise);
    mocks.enqueue.mockReturnValueOnce({
      id: "owned-notice",
      accepted: Promise.resolve({ ok: true }),
      cancel: () => false,
      settled: settled.promise,
    });
    try {
      enqueueSessionStateNotice(input);
      enqueueSessionStateNotice(input);
      expect(mocks.capture).toHaveBeenCalledOnce();
      capture.resolve({ sessionId: "original", generation: "current" });
      await vi.advanceTimersByTimeAsync(1);
      enqueueSessionStateNotice(input);
      await vi.advanceTimersByTimeAsync(19_999);
      enqueueSessionStateNotice(input);
      expect(mocks.capture).toHaveBeenCalledOnce();
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(mocks.pending).toHaveLength(1);
    } finally {
      capture.resolve({ sessionId: "original", generation: "current" });
      settled.resolve({ status: "completed", executionStarted: true, delivered: false });
      await vi.runAllTimersAsync();
    }
  });

  it("does not rearm a projection claimed by another turn", async () => {
    const input = {
      watcherSessionKey: "agent:main:main",
      targetSessionKey: "agent:main:child",
      lastSeenSequence: 42,
    };
    enqueueSessionStateNotice({ ...input, queueOnly: true });
    const event = mocks.pending[0]!;
    mocks.ownedIds.add(event.id!);
    enqueueSessionStateNotice(input);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.pending).toEqual([event]);
  });

  it("cancels a newer watcher buffer when an older queued batch starts during close", async () => {
    const firstSettled = createDeferred<SessionEventOutcome>();
    const secondSettled = createDeferred<SessionEventOutcome>();
    const secondEnqueued = createDeferred();
    mocks.enqueue
      .mockImplementationOnce(() => ({
        id: "first-batch",
        accepted: Promise.resolve({ ok: true }),
        cancel: () => true,
        settled: firstSettled.promise,
      }))
      .mockImplementationOnce(() => {
        secondEnqueued.resolve();
        return {
          id: "second-batch",
          accepted: Promise.resolve({ ok: true }),
          cancel: () => true,
          settled: secondSettled.promise,
        };
      });
    const enqueue = (targetSessionKey: string) =>
      enqueueSessionStateNotice({
        watcherSessionKey: "agent:main:main",
        targetSessionKey,
        lastSeenSequence: 1,
      });
    try {
      enqueue("agent:main:first");
      await vi.advanceTimersByTimeAsync(20_000);
      enqueue("agent:main:second");
      await vi.advanceTimersByTimeAsync(20_000);
      enqueue("agent:main:third");
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      await mocks.enqueue.mock.calls[0]![1].onAdopted?.();
      await secondEnqueued.promise;
      firstSettled.resolve({ status: "completed", executionStarted: true, delivered: false });
      secondSettled.resolve({ status: "completed", executionStarted: true, delivered: false });
      const closing = drainGlobalSingletonLifecycleState("restart");
      await vi.runAllTimersAsync();
      await closing;
      expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    } finally {
      firstSettled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
      secondSettled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
      await vi.runAllTimersAsync();
    }
  });

  it("keeps the first notice's 20-second deadline when another watched session changes", async () => {
    const watcherSessionKey = "agent:main:main";
    enqueueSessionStateNotice({
      watcherSessionKey,
      targetSessionKey: "agent:main:first",
      lastSeenSequence: 1,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    enqueueSessionStateNotice({
      watcherSessionKey,
      targetSessionKey: "agent:main:second",
      lastSeenSequence: 2,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue.mock.calls[0]?.[1].occurrences).toHaveLength(2);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("keeps different captured delivery routes in separate watcher batches", async () => {
    mocks.capture
      .mockResolvedValueOnce({
        sessionId: "original",
        generation: "current",
        deliveryContext: { channel: "slack", to: "first" },
      })
      .mockResolvedValueOnce({
        sessionId: "original",
        generation: "current",
        deliveryContext: { channel: "slack", to: "second" },
      });
    for (const targetSessionKey of ["agent:main:first", "agent:main:second"]) {
      enqueueSessionStateNotice({
        watcherSessionKey: "agent:main:main",
        targetSessionKey,
        lastSeenSequence: 1,
      });
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(
      mocks.enqueue.mock.calls.map(([, options]) => options.expectedTarget?.deliveryContext?.to),
    ).toEqual(["first", "second"]);
    expect(mocks.enqueue.mock.calls.map(([, options]) => options.occurrences?.length)).toEqual([
      1, 1,
    ]);
  });

  it.each([undefined, null, "/synthetic/store.sqlite"])(
    "coalesces for 20 seconds and acknowledges store %s only upon adoption",
    async (watcherStorePath) => {
      const notice = {
        watcherSessionKey: "agent:main:main",
        watcherStorePath,
        targetSessionKey: "agent:main:slack:channel:C01234567",
        lastSeenSequence: 42,
      };
      enqueueSessionStateNotice(notice);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(mocks.acknowledge).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      const options = mocks.enqueue.mock.calls[0]![1];
      expect(options).toMatchObject({
        source: "session",
        sessionKey: notice.watcherSessionKey,
        expectedTarget: { sessionId: "original", generation: "current" },
        occurrences: [{ sessionStorePath: watcherStorePath ?? null }],
      });
      expect(mocks.acknowledge).not.toHaveBeenCalled();
      await options.onAdopted?.();
      expect(mocks.acknowledge).toHaveBeenCalledWith(
        notice.watcherSessionKey,
        [{ targetSessionKey: notice.targetSessionKey, watcherStorePath: watcherStorePath ?? null }],
        expect.any(Function),
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
    },
  );

  it.each([
    { watcherSessionKey: "agent:main:main", queueOnly: true },
    { watcherSessionKey: "agent:main:subagent:child", queueOnly: false },
  ])("keeps ambient notices passive for $watcherSessionKey", async (options) => {
    enqueueSessionStateNotice({
      ...options,
      targetSessionKey: "agent:main:group:watched",
      lastSeenSequence: 42,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.pending).toHaveLength(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("does not adopt a notice consumed during coalescing", async () => {
    enqueueSessionStateNotice({
      watcherSessionKey: "agent:main:main",
      targetSessionKey: "agent:main:group:watched",
      lastSeenSequence: 42,
    });
    await vi.advanceTimersByTimeAsync(1);
    mocks.pending.length = 0;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
});
