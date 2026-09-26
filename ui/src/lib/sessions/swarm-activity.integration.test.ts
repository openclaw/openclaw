import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("session swarm activity", () => {
  it("keeps chronological phase and log annotations across canonical refreshes", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const parentKey = "agent:main:main";
    const groupId = "swarm:agent:main:main:turn-42";
    let rows: SessionsListResult["sessions"] = [
      { key: parentKey, kind: "direct", updatedAt: 1 },
      {
        key: "agent:main:subagent:older",
        kind: "direct",
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "running",
        updatedAt: 2,
      },
    ];
    let ts = 1;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(rows, ts++);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    const note = (kind: "phase" | "log", text: string) => ({
      sessionKey: parentKey,
      reason: "swarm-note",
      swarmGroupId: groupId,
      kind,
      text,
      key: parentKey,
      updatedAt: 1,
    });
    const child = (key: string, updatedAt: number) => ({
      sessionKey: key,
      reason: "create",
      key,
      kind: "direct",
      parentSessionKey: parentKey,
      swarmGroupId: groupId,
      status: "running",
      updatedAt,
    });
    const emitChanged = (payload: Record<string, unknown>) =>
      emitEvent({ type: "event", event: "sessions.changed", payload });

    try {
      await sessions.refresh({ force: true });
      const revisionBeforePhase = sessions.canonicalListRevision;
      emitChanged(note("phase", "Plan"));
      expect(sessions.canonicalListRevision).toBe(revisionBeforePhase);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.canonicalListRevision).toBeGreaterThan(revisionBeforePhase);
      rows = [
        ...rows,
        {
          key: "agent:main:subagent:planner",
          kind: "direct",
          parentSessionKey: parentKey,
          swarmGroupId: groupId,
          status: "running",
          updatedAt: 3,
        },
      ];
      emitChanged(child("agent:main:subagent:planner", 3));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions.state.result?.sessions.some((row) => row.key.endsWith(":planner"))).toBe(
        true,
      );

      type SwarmDisplayRow = GatewaySessionRow & { swarmLog?: string; swarmPhase?: string };
      const displayRows = () => sessions.state.result?.sessions as SwarmDisplayRow[] | undefined;
      expect(displayRows()?.find((row) => row.key.endsWith(":older"))?.swarmPhase).toBeUndefined();
      expect(displayRows()?.find((row) => row.key.endsWith(":planner"))?.swarmPhase).toBe("Plan");

      emitChanged(note("log", "Planning is complete."));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(request).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        displayRows()
          ?.filter((row) => row.swarmGroupId === groupId)
          .map((row) => row.swarmLog),
      ).toEqual(["Planning is complete.", "Planning is complete."]);

      emitChanged(note("phase", "Build"));
      rows = [
        ...rows,
        {
          key: "agent:main:subagent:builder",
          kind: "direct",
          parentSessionKey: parentKey,
          swarmGroupId: groupId,
          status: "running",
          updatedAt: 4,
        },
      ];
      emitChanged(child("agent:main:subagent:builder", 4));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(request).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions.state.result?.sessions.some((row) => row.key.endsWith(":builder"))).toBe(
        true,
      );

      expect(displayRows()?.find((row) => row.key.endsWith(":planner"))?.swarmPhase).toBe("Plan");
      expect(displayRows()?.find((row) => row.key.endsWith(":builder"))?.swarmPhase).toBe("Build");

      // Only creation events assign an implicit phase; a later status update
      // must leave a child that predates all phase notes unphased.
      emitChanged({
        sessionKey: "agent:main:subagent:older",
        reason: "status",
        key: "agent:main:subagent:older",
        kind: "direct",
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "done",
        updatedAt: 5,
      });
      expect(displayRows()?.find((row) => row.key.endsWith(":older"))?.swarmPhase).toBeUndefined();
    } finally {
      sessions.dispose();
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});
