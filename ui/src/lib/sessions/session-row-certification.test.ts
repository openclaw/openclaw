// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const workRow: GatewaySessionRow = {
  key: "global",
  agentId: "work",
  sessionId: "work-global-session",
  kind: "global",
  updatedAt: 200,
  label: "Work descriptor",
  archived: false,
  status: "running",
  hasActiveRun: true,
  activeRunIds: ["work-run"],
};

async function descriptorOwner(onInvalidate: () => void) {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => sessionsResult([], 1)));
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const target = { key: "global", agentId: "work" };
  const changed = vi.fn();
  const observation = sessions.observeRow(target, changed, { onInvalidate });
  expect(observation.captureReconcile()(workRow)).toMatchObject({
    status: "current",
    row: workRow,
  });
  changed.mockClear();
  return { ...gateway, sessions, target, changed, observation };
}

describe("descriptor certification refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("publishes uncertified rows immediately and paces both registrations in the same tick", async () => {
    const invalidated = vi.fn(() => Date.now());
    const h = await descriptorOwner(invalidated);
    const otherInvalidated = vi.fn(() => Date.now());
    const otherChanged = vi.fn();
    const other = h.sessions.observeRow(h.target, otherChanged, {
      onInvalidate: otherInvalidated,
    });
    const staleRow = h.observation.captureReconcile();
    const staleAbsence = other.captureReconcile();
    const beforeRefresh = h.observation.captureReconcile();
    const started = Date.now();
    for (const [offset, reason] of ["patch", "send"].entries()) {
      if (offset) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const row = { ...workRow, updatedAt: 201 + offset, label: `Admitted ${offset}` };
      h.emitEvent({
        type: "event",
        event: offset ? "session.message" : "sessions.changed",
        payload: { agentId: "work", reason, session: row },
      });
      expect(h.observation.row).toEqual(row);
      expect(other.row).toEqual(row);
      expect(h.changed).toHaveBeenLastCalledWith(row);
      expect(otherChanged).toHaveBeenLastCalledWith(row);
      expect(invalidated).not.toHaveBeenCalled();
      expect(otherInvalidated).not.toHaveBeenCalled();
    }
    // Pacing cannot let a pre-event row or absence replace the admitted facts.
    expect(staleRow(workRow)).toMatchObject({ status: "current", row: { label: "Admitted 1" } });
    expect(staleAbsence(undefined)).toMatchObject({
      status: "current",
      row: { label: "Admitted 1" },
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(invalidated).not.toHaveBeenCalled();
    expect(otherInvalidated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("send");
    expect(otherInvalidated).toHaveBeenCalledExactlyOnceWith("send");
    expect(invalidated.mock.results[0]?.value).toBe(started + 5_000);
    expect(otherInvalidated.mock.results[0]?.value).toBe(started + 5_000);
    expect(beforeRefresh(workRow)).toEqual({ status: "invalidated" });
  });

  it("immediately invalidates an envelope-only event and absorbs pending certification", async () => {
    const invalidated = vi.fn();
    const h = await descriptorOwner(invalidated);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { agentId: "work", reason: "patch", session: { ...workRow, updatedAt: 201 } },
    });
    expect(invalidated).not.toHaveBeenCalled();
    const pending = h.observation.captureReconcile();
    await vi.advanceTimersByTimeAsync(4_000);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "global", agentId: "work", reason: "swarm" },
    });
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("swarm");
    expect(pending(workRow)).toEqual({ status: "invalidated" });
    await vi.advanceTimersByTimeAsync(500);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { agentId: "work", reason: "send", session: { ...workRow, updatedAt: 202 } },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(invalidated).toHaveBeenCalledTimes(2);
    expect(invalidated).toHaveBeenLastCalledWith("send");
  });

  it.each(["read", "absence", "delete", "dispose", "reset"] as const)(
    "absorbs pending certification after %s",
    async (action) => {
      const invalidated = vi.fn();
      const h = await descriptorOwner(invalidated);
      const row = { ...workRow, updatedAt: 201 };
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { agentId: "work", reason: "patch", session: row },
      });
      expect(invalidated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      if (action === "read" || action === "absence") {
        expect(h.observation.captureReconcile()(action === "read" ? row : undefined)).toMatchObject(
          {
            status: "current",
            row: action === "read" ? row : null,
          },
        );
      } else if (action === "delete") {
        h.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            agentId: "work",
            sessionKey: "global",
            sessionId: row.sessionId,
            reason: "delete",
            ts: 202,
          },
        });
        expect(h.observation.isCurrent()).toBe(false);
      } else if (action === "dispose") {
        h.observation.dispose();
      } else {
        h.publish(false);
      }
      if (action === "read") {
        await vi.advanceTimersByTimeAsync(500);
        h.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { agentId: "work", reason: "send", session: { ...row, updatedAt: 202 } },
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(invalidated).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4_500);
        expect(invalidated).toHaveBeenCalledExactlyOnceWith("send");
        return;
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(invalidated).not.toHaveBeenCalled();
    },
  );
});
