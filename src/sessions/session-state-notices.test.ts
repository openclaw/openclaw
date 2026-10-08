// Session-state notice parsing and coalesced producer handoff.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { enqueueSessionEventForHost } from "../auto-reply/reply/session-event-handoff.js";
import type { SystemEvent } from "../infra/system-events.js";
import {
  decodeSessionStateNoticeContextKey,
  enqueueSessionStateNotice,
} from "./session-state-notices.js";

const mocks = vi.hoisted(() => ({
  ownerKey: Symbol("session-state-notices-fixture"),
  pending: [] as SystemEvent[],
  capture: vi.fn(async () => ({ sessionId: "original", generation: "current" })),
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
  enqueueSessionEventForHost: mocks.enqueue,
  assertSessionEventTargetCurrent: vi.fn(),
}));
// mock-isolation: Fake-time coalescing must not borrow another suite's live store resolver.
vi.mock("../infra/system-event-ownership.js", () => ({ isSystemEventStoreCurrent: () => true }));
// mock-isolation: Keep pending occurrences local so these timer cases cannot drain shared queues.
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventEntry: (text: string, options: Partial<SystemEvent>) => {
    const occurrence: SystemEvent = { text, ...options, id: String(mocks.pending.length), ts: 1 };
    mocks.pending.push(occurrence);
    return occurrence;
  },
  peekSystemEventEntries: () => [...mocks.pending],
}));
// mock-isolation: Observe adoption without opening cursor writers; the permissions suite covers native custody.
vi.mock("./session-state-notice-acknowledgment.js", () => ({
  acknowledgeSessionStateNoticesInWorker: mocks.acknowledge,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.pending.length = 0;
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
        occurrence: { sessionStorePath: watcherStorePath ?? null },
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
