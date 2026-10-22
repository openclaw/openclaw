// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createSessionCapabilityHarness,
  sessionChangedEvent,
  sessionsResult,
} from "./session-capability.test-support.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 5_000;
const ownerId = "profile-ada";
const makeRow = (name: string, updatedAt: number, id = ownerId) => ({
  key: `agent:main:${name}`,
  kind: "direct" as const,
  updatedAt,
  createdActor: { type: "human" as const, id },
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(
  handler: (params?: { limit?: number; offset?: number; ownerFirst?: boolean }) => unknown,
) {
  const request = vi.fn(async (method: string, params?: Parameters<typeof handler>[0]) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler(params);
  });
  return {
    request,
    ...createSessionCapabilityHarness(request as unknown as GatewayBrowserClient["request"], {
      ownerId,
    }),
  };
}

describe("owner-first session roster plan", () => {
  it("retains owner and appended shared pages when an event replaces the list", async () => {
    const ownerTail = makeRow("owner-tail", 1);
    const ownerHead = makeRow("owner-head", 3);
    const sharedRows = [
      ownerHead,
      ...Array.from({ length: 119 }, (_, index) =>
        makeRow(`shared-${index}`, 119 - index, "profile-bob"),
      ),
    ];
    const { sessions, emitEvent, request } = harness((params) => {
      const offset = params?.offset ?? 0;
      const shared = sharedRows.slice(offset, offset + (params?.limit ?? 50));
      return sessionsResult(
        params?.ownerFirst
          ? [ownerHead, ownerTail, ...shared.filter((row) => row !== ownerHead)]
          : shared,
        2,
      );
    });

    await sessions.refresh({ agentId: "main", limit: 60, force: true });
    await sessions.refresh({ agentId: "main", limit: 60, offset: 60, append: true, force: true });
    expect(sessions.state.result?.sessions).toHaveLength(121);

    emitEvent(sessionChangedEvent(sharedRows[1]!.key));
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ ownerFirst: true, limit: 60 }),
      expect.objectContaining({ limit: 60, offset: 60 }),
      expect.objectContaining({ ownerFirst: true, limit: 120 }),
    ]);
    expect(sessions.state.result?.sessions).toHaveLength(121);
    expect(sessions.state.result?.sessions.map((row) => row.key)).toContain(ownerTail.key);
  });

  it("keeps foreign-owned rows published through a warm owner-first refresh", async () => {
    const ownRow = makeRow("ada", 2);
    const foreignRow = makeRow("bob", 1, "profile-bob");
    const { sessions, emitEvent, request } = harness(() => sessionsResult([ownRow, foreignRow], 2));

    await sessions.refresh({ agentId: "main", limit: 60, force: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toContain(foreignRow.key);

    const publishedKeySets: string[][] = [];
    const stop = sessions.subscribe((next) => {
      if (next.result) {
        publishedKeySets.push(next.result.sessions.map((row) => row.key));
      }
    });
    emitEvent(sessionChangedEvent(ownRow.key));
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
    stop();

    expect(request.mock.calls).toHaveLength(2);
    expect(publishedKeySets.length).toBeGreaterThan(0);
    for (const keys of publishedKeySets) {
      expect(keys).toContain(foreignRow.key);
    }
  });

  it("keeps the previous roster when a warm owner-first refresh fails", async () => {
    const ownRow = makeRow("ada", 2);
    const foreignRow = makeRow("bob", 1, "profile-bob");
    let failRefresh = false;
    const { sessions, emitEvent } = harness(() => {
      if (failRefresh) {
        throw new Error("session roster unavailable");
      }
      return sessionsResult([ownRow, foreignRow], 2);
    });

    await sessions.refresh({ agentId: "main", limit: 60, force: true });
    expect(sessions.state.result?.sessions).toHaveLength(2);

    failRefresh = true;
    emitEvent(sessionChangedEvent(ownRow.key));
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

    expect(sessions.state.error).not.toBeNull();
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
      ownRow.key,
      foreignRow.key,
    ]);
  });
});
