import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  capture: vi.fn<typeof captureSessionEventTargetForHost>(async () => ({
    sessionId: "original",
    generation: "current",
  })),
  enqueue: vi.fn<typeof enqueueSessionEventForHost>(() => receipt("notice-turn")),
  acknowledge: vi.fn(async () => {}),
}));
// A shared worker may retain an earlier module's owner and its different queue/handoff bindings.
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  const resolve = actual.resolveGlobalSingleton;
  return {
    ...actual,
    resolveGlobalSingleton: (...[key, ...rest]: Parameters<typeof resolve>) =>
      resolve(key === Symbol.for("openclaw.sessionStateNotices") ? mocks.ownerKey : key, ...rest),
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
  try {
    await drainGlobalSingletonLifecycleState("restart");
  } finally {
    vi.useRealTimers();
  }
});

type Notice = Parameters<typeof enqueueSessionStateNotice>[0];
function enqueue(targetSessionKey: string, options: Partial<Notice> = {}) {
  enqueueSessionStateNotice({
    watcherSessionKey: "agent:main:main",
    targetSessionKey,
    lastSeenSequence: 1,
    ...options,
  });
}

const done: SessionEventOutcome = { status: "completed", executionStarted: true, delivered: false };
function receipt(id: string, settled = Promise.resolve(done)) {
  return { id, accepted: Promise.resolve({ ok: true as const }), cancel: () => true, settled };
}

it.each([
  ["session-state:efbbbf6167656e743a6d61696e", "\uFEFFagent:main"],
  ["session-state:ff", undefined], // Strict UTF-8 prevents corrupt watcher-cursor collisions.
  ["other:ff", undefined],
  ...["", "abc", "zz"].map((hex) => [`session-state:${hex}`, undefined] as const),
] as const)("decodes only valid session-state context keys: %s", (key, expected) => {
  expect(decodeSessionStateNoticeContextKey(key)).toBe(expected);
});

it("cancels a newer watcher buffer when an older queued batch starts during close", async () => {
  const firstSettled = createDeferred<SessionEventOutcome>();
  const secondSettled = createDeferred<SessionEventOutcome>();
  const secondEnqueued = createDeferred();
  mocks.enqueue
    .mockImplementationOnce(() => receipt("first-batch", firstSettled.promise))
    .mockImplementationOnce(() => {
      secondEnqueued.resolve();
      return receipt("second-batch", secondSettled.promise);
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
    firstSettled.resolve(done);
    secondSettled.resolve(done);
    await drainGlobalSingletonLifecycleState("restart");
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  } finally {
    firstSettled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
    secondSettled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
    await drainGlobalSingletonLifecycleState("restart");
  }
});

it("keeps different captured delivery routes in separate watcher batches", async () => {
  for (const to of ["first", "second"]) {
    mocks.capture.mockResolvedValueOnce({
      sessionId: "original",
      generation: "current",
      deliveryContext: { channel: "slack", to },
    });
  }
  for (const targetSessionKey of ["agent:main:first", "agent:main:second"]) {
    enqueue(targetSessionKey);
  }
  await vi.advanceTimersByTimeAsync(20_000);
  expect(
    mocks.enqueue.mock.calls.map(([, options]) => [
      options.expectedTarget?.deliveryContext?.to,
      options.occurrences?.length,
    ]),
  ).toEqual([
    ["first", 1],
    ["second", 1],
  ]);
});

it("keeps the first deadline and acknowledges coalesced store notices only upon adoption", async () => {
  const watcherStorePath = "/synthetic/store.sqlite";
  const watcherSessionKey = "agent:main:main";
  const targets = ["agent:main:slack:channel:C01234567", "agent:main:second"] as const;
  enqueue(targets[0], { watcherStorePath, lastSeenSequence: 42 });
  await vi.advanceTimersByTimeAsync(10_000);
  enqueue(targets[1], { watcherStorePath, lastSeenSequence: 2 });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  const options = mocks.enqueue.mock.calls[0]![1];
  expect(options).toMatchObject({
    expectedTarget: { sessionId: "original", generation: "current" },
    occurrences: targets.map(() => ({ sessionStorePath: watcherStorePath })),
  });
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  await options.onAdopted?.();
  expect(mocks.acknowledge).toHaveBeenCalledWith(
    watcherSessionKey,
    targets.map((targetSessionKey) => ({ targetSessionKey, watcherStorePath })),
    expect.any(Function),
    expect.objectContaining({ assertCurrent: expect.any(Function) }),
  );
});

it.each([
  { watcherSessionKey: "agent:main:main", queueOnly: true },
  { watcherSessionKey: "agent:main:subagent:child", queueOnly: false },
])("keeps ambient notices passive for $watcherSessionKey", async (options) => {
  enqueue("agent:main:group:watched", { ...options, lastSeenSequence: 42 });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mocks.pending).toHaveLength(1);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});

it("does not adopt a notice consumed during coalescing", async () => {
  enqueue("agent:main:group:watched", { lastSeenSequence: 42 });
  await vi.advanceTimersByTimeAsync(1);
  mocks.pending.length = 0;
  await vi.advanceTimersByTimeAsync(19_999);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});
