// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

const scope = {
  agentId: "main",
  includeDerivedTitles: false,
  includeLastMessage: false,
  limit: 50,
};
const primary = { agentId: "main", force: true };

function row(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    sessionId: `${key}-generation`,
    updatedAt: 1,
    permissionMode: "guarded",
    archived: false,
    hasActiveRun: true,
    status: "running",
    ...fields,
  };
}

function pendingList(fallback: SessionsListResult) {
  const read = createDeferred<SessionsListResult>();
  const operations: Promise<unknown>[] = [];
  return {
    ...read,
    fallback,
    operations,
    track<T>(operation: Promise<T>) {
      operations.push(operation);
      return operation;
    },
  };
}
type PendingList = ReturnType<typeof pendingList>;
type Reply = SessionsListResult | PendingList | Error;

function harness(replies: Reply[]) {
  const pending = replies.filter(
    (reply): reply is PendingList => !(reply instanceof Error) && "promise" in reply,
  );
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    const reply = replies.shift();
    if (!reply) {
      throw new Error("Unexpected additional session list request");
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return "promise" in reply ? reply.promise : reply;
  });
  const capability = createSessionCapabilityHarness(
    request as unknown as GatewayBrowserClient["request"],
  );
  const { sessions } = capability;
  onTestFinished(async () => {
    pending.forEach((read) => read.resolve(read.fallback));
    await Promise.all(pending.flatMap((read) => read.operations));
    sessions.dispose();
  });
  return {
    sessions,
    request,
    rows: () => sessions.state.result?.sessions,
    managed: (query = scope) => sessions.listSnapshot(query),
    event: (session: GatewaySessionRow, agentId = "main") =>
      capability.emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          agentId,
          sessionKey: session.key,
          hasActiveRun: true,
          status: "running",
          session: { ...session, permissionMode: session.permissionMode ?? null },
        },
      }),
  };
}

describe("permission projection across canonical session lists", () => {
  it.each([
    { name: "an explicit mode", permissionMode: "full" as const },
    { name: "the default mode", permissionMode: undefined },
  ])("preserves $name without discarding a pending ordinary roster", async ({ permissionMode }) => {
    const existing = row("agent:main:edited", { label: "Original" });
    const removed = row("agent:main:removed");
    const added = row("agent:main:added", { label: "New member" });
    const response = sessionsResult(
      [{ ...existing, label: "Listed label", updatedAt: 2 }, added],
      2,
    );
    const pending = pendingList(response);
    const { sessions, rows, event, request } = harness([
      sessionsResult([existing, removed], 1),
      pending,
    ]);
    await sessions.refresh(primary);
    const refresh = pending.track(sessions.refresh(primary));
    expect(sessions.state.loading).toBe(true);
    event({ ...existing, updatedAt: 3, permissionMode });
    pending.resolve(response);
    await refresh;
    expect(sessions.state).toMatchObject({ loading: false, error: null });
    expect(rows()?.map((entry) => entry.key)).toEqual([existing.key, added.key]);
    expect(rows()?.[0]).toMatchObject({ label: "Original", updatedAt: 3 });
    expect(rows()?.[0]?.permissionMode).toBe(permissionMode);
    if (permissionMode === undefined) {
      expect(rows()?.[0]).not.toHaveProperty("permissionMode");
    }
    expect(rows()?.[1]).toEqual(added);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a late event older than a permission already confirmed by another held list", async () => {
    const initial = row("agent:main:cross-list");
    const confirmed = row(initial.key, { updatedAt: 5, permissionMode: "workspace" });
    const response = sessionsResult([{ ...confirmed, label: "Late independent result" }], 5);
    const pending = pendingList(response);
    const { sessions, rows, managed, event } = harness([
      sessionsResult([initial], 1),
      pending,
      sessionsResult([confirmed], 5),
    ]);
    await sessions.refresh(primary);
    const first = pending.track(sessions.list({ agentId: "main" }));
    event({ ...initial, updatedAt: 3, permissionMode: "full" });
    await sessions.refreshList(scope);
    expect(rows()?.[0]?.permissionMode).toBe("workspace");
    expect(managed().result?.sessions[0]?.permissionMode).toBe("workspace");
    event({ ...initial, updatedAt: 4, permissionMode: "guarded", label: "Stale event label" });
    expect(rows()?.[0]?.permissionMode).toBe("workspace");
    expect(rows()?.[0]?.label).toBeUndefined();
    pending.resolve(response);
    expect((await first)?.sessions).toEqual(response.sessions);
    expect(managed().result?.sessions).toEqual([confirmed]);
    expect(sessions.state.loading).toBe(false);
  });

  it("keeps raw global permission projections with their explicit agent", async () => {
    const main = row("global", { kind: "global", agentId: "main", sessionId: "shared-id" });
    const research = { ...main, agentId: "research", label: "Research" };
    const mainRead = pendingList(sessionsResult([main], 1));
    const researchRead = pendingList(sessionsResult([research], 1));
    const { sessions, event } = harness([sessionsResult([main], 1), mainRead, researchRead]);
    await sessions.refresh(primary);
    const mainList = mainRead.track(sessions.list({ agentId: "main" }));
    const researchList = researchRead.track(sessions.list({ agentId: "research" }));
    event({ ...main, updatedAt: 3, permissionMode: "full" }, "main");
    mainRead.resolve(mainRead.fallback);
    researchRead.resolve(researchRead.fallback);
    expect((await mainList)?.sessions[0]?.permissionMode).toBe("full");
    expect((await researchList)?.sessions[0]).toEqual(research);
  });

  it("retires permission projections when a canonical list establishes a successor incarnation", async () => {
    const original = row("agent:main:recreated");
    const replacement = row(original.key, {
      sessionId: "replacement-generation",
      permissionMode: "workspace",
      updatedAt: 5,
    });
    const pending = pendingList(sessionsResult([original], 1));
    const { sessions, managed, event } = harness([
      pending.fallback,
      pending,
      sessionsResult([replacement], 5),
      sessionsResult([replacement], 6),
    ]);
    await sessions.refresh(primary);
    const first = pending.track(sessions.list({ agentId: "main" }));
    event({ ...original, updatedAt: 3, permissionMode: "full" });
    await sessions.refreshList(scope);
    event({ ...original, updatedAt: 99, permissionMode: "full" });
    pending.resolve(pending.fallback);
    expect((await first)?.sessions).toEqual([]);
    expect(managed().result?.sessions).toEqual([replacement]);
    expect((await sessions.list({ agentId: "main" }))?.sessions).toEqual([replacement]);
  });

  it("binds accepted successor events to their incarnation before primary publication", async () => {
    const original = row("agent:main:successor-events", { sessionId: "old-generation" });
    const successor = row(original.key, { sessionId: "successor-generation", updatedAt: 3 });
    const response = sessionsResult(
      [{ ...successor, permissionMode: "workspace", updatedAt: 4, label: "Canonical successor" }],
      4,
    );
    const pending = pendingList(response);
    const { sessions, rows, managed, event } = harness([
      sessionsResult([original], 1),
      sessionsResult([successor], 3),
      pending,
    ]);
    await sessions.refresh(primary);
    event({ ...original, updatedAt: 2, permissionMode: "full" });
    await sessions.refreshList(scope);
    expect(rows()?.[0]?.sessionId).toBe(original.sessionId);
    expect(managed().result?.sessions[0]?.sessionId).toBe(successor.sessionId);
    event({ ...successor, updatedAt: 4, permissionMode: "workspace" });
    expect(rows()?.[0]).toMatchObject({
      sessionId: successor.sessionId,
      permissionMode: "workspace",
    });
    const refresh = pending.track(sessions.refresh(primary));
    event({ ...successor, updatedAt: 5, permissionMode: "full" });
    pending.resolve(response);
    await refresh;
    const expected = { sessionId: successor.sessionId, permissionMode: "full" };
    expect(rows()?.[0]).toMatchObject(expected);
    expect(sessions.state.loading).toBe(false);
    event({ ...original, updatedAt: 99, permissionMode: "guarded" });
    expect(rows()?.[0]).toMatchObject(expected);
  });

  it.each([true, false])(
    "preserves a managed-only permission with primary availability %s",
    async (primaryAvailable) => {
      const main = row("agent:main:main");
      const research = row("agent:research:managed", { agentId: "research" });
      const query = { ...scope, agentId: "research" };
      const response = sessionsResult([{ ...research, label: "Refreshed managed label" }], 2);
      const pending = pendingList(response);
      const { sessions, managed, event, request } = harness([
        primaryAvailable ? sessionsResult([main], 1) : new Error("Primary unavailable"),
        sessionsResult([research], 1),
        pending,
      ]);
      await sessions.refresh(primary);
      await sessions.refreshList(query);
      const refresh = pending.track(sessions.refreshList({ ...query, force: true }));
      event({ ...research, updatedAt: 3, permissionMode: "full" }, "research");
      pending.resolve(response);
      await refresh;
      expect(managed(query)).toMatchObject({
        loading: false,
        result: {
          sessions: [{ key: research.key, permissionMode: "full" }],
        },
      });
      expect(sessions.state.result?.sessions ?? null).toEqual(primaryAvailable ? [main] : null);
      expect(sessions.state.error).toBe(primaryAvailable ? null : "Primary unavailable");
      expect(request).toHaveBeenCalledTimes(3);
    },
  );
});
