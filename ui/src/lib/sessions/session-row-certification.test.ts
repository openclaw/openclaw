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

describe("descriptor refresh pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("publishes rows immediately and paces both registrations in the same tick", async () => {
    const invalidated = vi.fn(() => Date.now());
    const h = await descriptorOwner(invalidated);
    const otherInvalidated = vi.fn(() => Date.now());
    const otherChanged = vi.fn();
    const other = h.sessions.observeRow(h.target, otherChanged, {
      onInvalidate: otherInvalidated,
    });
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
    await vi.advanceTimersByTimeAsync(3_999);
    expect(invalidated).not.toHaveBeenCalled();
    expect(otherInvalidated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("send");
    expect(otherInvalidated).toHaveBeenCalledExactlyOnceWith("send");
    expect(invalidated.mock.results[0]?.value).toBe(started + 5_000);
    expect(otherInvalidated.mock.results[0]?.value).toBe(started + 5_000);
  });
});
