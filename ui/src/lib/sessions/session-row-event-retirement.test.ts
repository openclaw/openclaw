// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionRowEventListener } from "./session-capability.ts";

const frame = (event: string, seq: number, payload: object): GatewayEventFrame => ({
  type: "event",
  event,
  seq,
  payload: { agentId: "main", ...payload },
});

it.each(["event", "read"] as const)(
  "does not recapture a descriptor after retirement by an authoritative %s",
  async (retirement) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const initial: GatewaySessionRow = {
      agentId: "main",
      key: "agent:main:retired-event-capture",
      kind: "direct",
      sessionId: "previous-incarnation",
      updatedAt: 100,
    };
    const successor: GatewaySessionRow = {
      ...initial,
      sessionId: "successor-incarnation",
      updatedAt: 200,
    };
    let listed: GatewaySessionRow[] = retirement === "event" ? [] : [initial];
    const { gateway, emitEvent } = createGatewayHarness(
      createTestGatewayClient(async () => sessionsResult(listed, 200)),
    );
    const sessions = createTestSessionCapability(gateway);
    const target = { key: initial.key, agentId: "main" };
    const delivered = vi.fn<SessionRowEventListener>();
    const currentDelivered = vi.fn<SessionRowEventListener>();
    await sessions.refresh({ agentId: "main", force: true });
    if (retirement === "event") {
      expect(sessions.state.result?.sessions).toEqual([]);
      expect(sessions.captureReconcile()(initial)).toBe(true);
    }
    // Retirement must stop admission without consumer disposal.
    const original = sessions.observeRow(target, () => undefined, { onEvent: delivered });
    expect(original.row).toMatchObject(initial);
    const retiringFrame = frame("sessions.changed", 1, {
      reason: "create",
      session: successor,
      ts: 200,
    });
    if (retirement === "event") {
      emitEvent(retiringFrame);
      // The frame captured before retirement still belongs to this callback.
      expect(delivered).toHaveBeenCalledExactlyOnceWith(retiringFrame, { applied: false });
    } else {
      listed = [successor];
      await sessions.refresh({ agentId: "main", force: true });
      expect(delivered).not.toHaveBeenCalled();
    }
    expect(original.isCurrent()).toBe(false);
    expect(original.row).toBeNull();
    expect(original.captureReconcile()(initial)).toEqual({ status: "retired" });
    expect(sessions.state.result?.sessions[0]).toMatchObject(successor);

    const replacement = sessions.observeRow(target, () => undefined, { onEvent: currentDelivered });
    expect(replacement.isCurrent()).toBe(true);
    expect(replacement.row).toMatchObject(successor);
    const next = frame("session.message", 2, {
      sessionKey: initial.key,
      session: { ...successor, updatedAt: 201 },
    });
    emitEvent(next);
    expect(delivered).toHaveBeenCalledTimes(retirement === "event" ? 1 : 0);
    expect(currentDelivered).toHaveBeenCalledExactlyOnceWith(
      next,
      expect.objectContaining({
        applied: true,
        admittedRow: expect.objectContaining({ sessionId: successor.sessionId }),
      }),
    );
    // Only the current descriptor receives unrelated frames for recovery.
    const unrelated = frame("session.message", 3, {
      sessionKey: "agent:main:unrelated",
      reason: "patch",
    });
    emitEvent(unrelated);
    expect(delivered).toHaveBeenCalledTimes(retirement === "event" ? 1 : 0);
    expect(currentDelivered).toHaveBeenLastCalledWith(unrelated, { applied: false });
  },
);
