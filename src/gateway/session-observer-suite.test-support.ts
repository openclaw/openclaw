import { afterEach, beforeEach, expect, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  createHarness as createBaseHarness,
  event,
  flushObserver,
  resetSessionObserverEventSequence,
} from "./session-observer.test-utils.js";

export type Harness = ReturnType<typeof createBaseHarness>;
export type HarnessOptions = Parameters<typeof createBaseHarness>[0];
export type EventRoute = { runId?: string; sessionKey?: string; agentId?: string };
type DigestFields = Partial<SessionObserverDigest>;

export function useObserverSuite() {
  const activeHarnesses = new Set<Harness>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(async () => {
    for (const harness of activeHarnesses) {
      await harness.observer.disposeAsync();
    }
    activeHarnesses.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetSessionObserverEventSequence();
  });
  return {
    activeHarnesses,
    createHarness: (options?: HarnessOptions) => {
      const harness = createBaseHarness(options);
      activeHarnesses.add(harness);
      return harness;
    },
  };
}

export function emitEvent(
  harness: Harness,
  stream: string,
  data: Record<string, unknown>,
  route: EventRoute = {},
) {
  return harness.observer.handleEventAsync(event({ ...route, stream, data }));
}

export async function advanceAndFlush(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushObserver();
}

export function broadcastDigest(harness: Harness, index = -1) {
  return harness.broadcastToConnIds.mock.calls.at(index)?.[1] as SessionObserverDigest | undefined;
}

function persistedDigest(harness: Harness, index = 0) {
  return harness.persistDigest.mock.calls.at(index)?.[0]?.digest as
    | SessionObserverDigest
    | undefined;
}

export function expectBroadcast(harness: Harness, fields: DigestFields, index = -1) {
  expect(broadcastDigest(harness, index)).toMatchObject(fields);
}

export function expectPersisted(harness: Harness, fields: DigestFields, index = 0) {
  expect(persistedDigest(harness, index)).toMatchObject(fields);
}

export function observerBroadcasts(harness: Harness) {
  return harness.broadcastToConnIds.mock.calls.filter((call) => call[0] === "session.observer");
}

export function callCounts(harness: Harness) {
  return {
    model: harness.completeModel.mock.calls.length,
    persisted: harness.persistDigest.mock.calls.length,
    broadcast: observerBroadcasts(harness).length,
  };
}
