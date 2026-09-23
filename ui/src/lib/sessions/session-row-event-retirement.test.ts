// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionRowEventListener, SessionRowObservation } from "./session-capability.ts";

it.each(["event", "read"] as const)(
  "does not recapture a descriptor after retirement by an authoritative %s",
  async (retirement) => {
    vi.useFakeTimers();
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
    let original: SessionRowObservation | undefined;
    let replacement: SessionRowObservation | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      if (retirement === "event") {
        expect(sessions.state.result?.sessions).toEqual([]);
        expect(sessions.captureReconcile()(initial)).toBe(true);
      }
      // Keep the original handle attached deliberately: retirement must end
      // admission of new frames without requiring the consumer to dispose it.
      original = sessions.observeRow(target, () => undefined, { onEvent: delivered });
      expect(original.row).toMatchObject(initial);
      const retiringFrame = {
        type: "event" as const,
        event: "sessions.changed",
        seq: 1,
        payload: {
          agentId: "main",
          reason: "create",
          session: successor,
          ts: 200,
        },
      };
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

      replacement = sessions.observeRow(target, () => undefined, { onEvent: currentDelivered });
      expect(replacement.isCurrent()).toBe(true);
      expect(replacement.row).toMatchObject(successor);
      const next = {
        type: "event" as const,
        event: "session.message",
        seq: 2,
        payload: {
          agentId: "main",
          sessionKey: initial.key,
          session: { ...successor, updatedAt: 201 },
        },
      };
      emitEvent(next);
      expect(delivered).toHaveBeenCalledTimes(retirement === "event" ? 1 : 0);
      expect(currentDelivered).toHaveBeenCalledExactlyOnceWith(
        next,
        expect.objectContaining({
          applied: true,
          admittedRow: expect.objectContaining({ sessionId: successor.sessionId }),
        }),
      );
      // A current descriptor still receives an unrelated raw frame for shared
      // recovery; only the already-retired registration loses future admission.
      const unrelated = {
        ...next,
        seq: 3,
        payload: { agentId: "main", sessionKey: "agent:main:unrelated", reason: "patch" },
      };
      emitEvent(unrelated);
      expect(delivered).toHaveBeenCalledTimes(retirement === "event" ? 1 : 0);
      expect(currentDelivered).toHaveBeenLastCalledWith(unrelated, { applied: false });
    } finally {
      replacement?.dispose();
      original?.dispose();
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);
