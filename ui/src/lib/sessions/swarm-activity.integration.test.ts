import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it("keeps chronological phase and log annotations across canonical refreshes", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const parentKey = "agent:main:main";
  const groupId = "swarm:agent:main:main:turn-42";
  const childRow = (name: string, updatedAt: number): GatewaySessionRow => ({
    key: `agent:main:subagent:${name}`,
    kind: "direct",
    parentSessionKey: parentKey,
    swarmGroupId: groupId,
    status: "running",
    updatedAt,
  });
  let rows: GatewaySessionRow[] = [
    { key: parentKey, kind: "direct", updatedAt: 1 },
    childRow("older", 2),
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
  const emitChanged = (payload: Record<string, unknown>) =>
    emitEvent({ type: "event", event: "sessions.changed", payload });
  const note = (kind: "phase" | "log", text: string) =>
    emitChanged({
      sessionKey: parentKey,
      reason: "swarm-note",
      swarmGroupId: groupId,
      kind,
      text,
      key: parentKey,
      updatedAt: 1,
    });
  const createChild = (name: string, updatedAt: number) => {
    const row = childRow(name, updatedAt);
    rows = [...rows, row];
    emitChanged({ ...row, sessionKey: row.key, reason: "create" });
  };
  const displayRows = () => sessions.state.result?.sessions;
  const phase = (name: string) =>
    displayRows()?.find((row) => row.key.endsWith(`:${name}`))?.swarmPhase;

  onTestFinished(() => {
    sessions.dispose();
    random.mockRestore();
    vi.useRealTimers();
  });
  await sessions.refresh({ force: true });
  const revisionBeforePhase = sessions.canonicalListRevision;
  note("phase", "Plan");
  expect(sessions.canonicalListRevision).toBe(revisionBeforePhase);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sessions.canonicalListRevision).toBeGreaterThan(revisionBeforePhase);
  createChild("planner", 3);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(phase("older")).toBeUndefined();
  expect(phase("planner")).toBe("Plan");

  note("log", "Planning is complete.");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(
    displayRows()
      ?.filter((row) => row.swarmGroupId === groupId)
      .map((row) => row.swarmLog),
  ).toEqual(["Planning is complete.", "Planning is complete."]);

  note("phase", "Build");
  createChild("builder", 4);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(5);

  expect(phase("planner")).toBe("Plan");
  expect(phase("builder")).toBe("Build");

  // Status updates must not assign a phase to children created before phase notes.
  emitChanged({
    ...childRow("older", 5),
    sessionKey: "agent:main:subagent:older",
    reason: "status",
    status: "done",
  });
  expect(phase("older")).toBeUndefined();
});
