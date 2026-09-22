// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

it("ignores recap-only changes for canonical, filtered, and child rosters", async () => {
  vi.useFakeTimers();
  const key = "agent:main:parent";
  const row = { key, kind: "direct" as const, updatedAt: 1 };
  const child = { ...row, key: "agent:main:child", spawnedBy: key };
  const request = vi.fn(async (method: string, params?: { spawnedBy?: string }) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return sessionsResult(params?.spawnedBy ? [child] : [row], 1);
  });
  const { sessions, emitEvent } = createSessionCapabilityHarness(
    request as unknown as GatewayBrowserClient["request"],
    { ownerId: "viewer" },
  );
  const scopes = [
    { agentId: "main", involvingMe: true },
    { agentId: "main", spawnedBy: key, limit: 100, includeGlobal: false, includeUnknown: false },
    {
      agentId: "main",
      spawnedBy: key,
      limit: 10_000,
      includeGlobal: false,
      includeUnknown: false,
    },
  ];
  const stops = scopes.map((scope) => sessions.subscribeList(scope, vi.fn()));

  try {
    await sessions.refresh({ agentId: "main", force: true });
    await Promise.all(scopes.map((scope) => sessions.refreshList({ ...scope, force: true })));
    expect(request).toHaveBeenCalledTimes(4);
    request.mockClear();

    for (let index = 0; index < 4; index += 1) {
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { agentId: "main", sessionKey: key, reason: "activity-summary" },
      });
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
    }
    expect(request).not.toHaveBeenCalled();

    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { agentId: "main", sessionKey: key, reason: "patch" },
    });
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ ownerFirst: true }),
    );
    expect(sessions.state.result?.sessions).toEqual([row]);
  } finally {
    stops.forEach((stop) => stop());
    sessions.dispose();
    vi.useRealTimers();
  }
});
