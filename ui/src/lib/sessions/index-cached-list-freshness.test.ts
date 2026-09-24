// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("cached session list freshness", () => {
  it("keeps a background run visible when a later request replays a pre-event page", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:background",
      sessionId: "background-session",
      kind: "direct",
      updatedAt: 10,
      snapshotAt: 100,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    };
    let page = sessionsResult([row], 100);
    const harness = createGatewayHarness(
      createTestGatewayClient(async () => structuredClone(page)),
    );
    const sessions = createTestSessionCapability(harness.gateway);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "main",
          reason: "run-capacity",
          session: {
            ...row,
            snapshotAt: 200,
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["background-run"],
          },
          ancestorSessions: [],
          ts: 200,
        },
      });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        status: "running",
        hasActiveRun: true,
      });

      // Runtime projection changed without a persisted-row write. Request order
      // does not make this completed Gateway cache entry a fresh observation.
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["background-run"],
        snapshotAt: 200,
      });

      page = sessionsResult([{ ...row, snapshotAt: 300 }], 300);
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        snapshotAt: 300,
      });
    } finally {
      sessions.dispose();
    }
  });

  it("does not revive a finished run when its older sampled event arrives after a list", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:background",
      sessionId: "background-session",
      kind: "direct",
      updatedAt: 10,
      snapshotAt: 300,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    };
    const harness = createGatewayHarness(
      createTestGatewayClient(async () => sessionsResult([structuredClone(row)], 300)),
    );
    const sessions = createTestSessionCapability(harness.gateway);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "main",
          reason: "run-capacity",
          session: {
            ...row,
            snapshotAt: 200,
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["background-run"],
          },
          ancestorSessions: [],
          ts: 200,
        },
      });
      expect(sessions.state.result?.sessions[0]).toMatchObject(row);
    } finally {
      sessions.dispose();
    }
  });

  it("settles a runtime-only run from a newer sampled event without a persisted write", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:background",
      sessionId: "background-session",
      kind: "direct",
      updatedAt: 10,
      snapshotAt: 100,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["background-run"],
    };
    const harness = createGatewayHarness(
      createTestGatewayClient(async () => sessionsResult([structuredClone(row)], 100)),
    );
    const sessions = createTestSessionCapability(harness.gateway);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const settled = {
        ...row,
        snapshotAt: 200,
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
      };
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "main",
          reason: "run-capacity",
          session: settled,
          ancestorSessions: [],
          ts: 200,
        },
      });
      expect(sessions.state.result?.sessions[0]).toMatchObject(settled);
    } finally {
      sessions.dispose();
    }
  });

  it("keeps fresh child facts when a later root request returns an older cached page", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:child";
    const parent: GatewaySessionRow = {
      key: parentKey,
      sessionId: "parent-session",
      kind: "direct",
      childSessions: [childKey],
    };
    const child: GatewaySessionRow = {
      key: childKey,
      sessionId: "child-session",
      kind: "direct",
      spawnedBy: parentKey,
      updatedAt: 10,
      snapshotAt: 100,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    };
    // Runtime facts can change without advancing the persisted updatedAt value.
    const freshChild = {
      ...child,
      snapshotAt: 200,
      status: "running" as const,
      hasActiveRun: true,
      activeRunIds: ["new-run"],
    };
    let root = sessionsResult([parent, child], 100);
    let children = sessionsResult([freshChild], 200);
    const client = createTestGatewayClient(
      vi.fn(async (method, params) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        expect(method).toBe("sessions.list");
        // RPC serialization returns distinct objects even when the server reused a page.
        return structuredClone(isRecord(params) && params.spawnedBy ? children : root);
      }),
    );
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    const query = { spawnedBy: parentKey, limit: 100 };
    await sessions.refresh({ agentId: "main", force: true });
    const primaryRevision = sessions.canonicalListRevision;
    const published: Array<[string | undefined, string | undefined]> = [];
    const capturePublication = () => {
      published.push([
        sessions.state.result?.sessions.find((row) => row.key === child.key)?.status,
        sessions.listSnapshot(query).result?.sessions.find((row) => row.key === child.key)?.status,
      ]);
    };
    const stopPrimary = sessions.subscribe(capturePublication);
    const stopChildren = sessions.subscribeList(query, (snapshot) => {
      if (!snapshot.loading && snapshot.result) {
        capturePublication();
      }
    });
    await sessions.refreshList(query);
    expect(published).toEqual([
      ["running", "running"],
      ["running", "running"],
    ]);
    expect(sessions.canonicalListRevision).toBe(primaryRevision);
    expect(sessions.state.result).toMatchObject({ ts: 100, count: 2 });
    stopPrimary();
    stopChildren();
    const projectedChild = () => sessions.projectRows([child])[0];
    expect(projectedChild()).toMatchObject({ hasActiveRun: true, status: "running" });
    expect(sessions.state.result?.sessions.find((row) => row.key === child.key)).toMatchObject({
      hasActiveRun: true,
      status: "running",
      activeRunIds: ["new-run"],
    });

    // A later request is not a newer observation when its result came from cache.
    await sessions.refresh({ agentId: "main", force: true });
    expect(projectedChild()).toMatchObject({ hasActiveRun: true, status: "running" });
    expect(sessions.state.result?.sessions.find((row) => row.key === child.key)).toMatchObject({
      hasActiveRun: true,
      activeRunIds: ["new-run"],
    });

    // An actually newer root snapshot still owns terminal transitions.
    root = sessionsResult([parent, { ...child, snapshotAt: 300, status: "done" }], 300);
    await sessions.refresh({ agentId: "main", force: true });
    expect(projectedChild()).toMatchObject({ hasActiveRun: false, status: "done" });
    children = sessionsResult([freshChild], 200);
    await sessions.refreshList(query);
    expect(projectedChild()).toMatchObject({ hasActiveRun: false, status: "done" });
    sessions.dispose();
  });

  it.each(["removed", "replaced"] as const)(
    "does not restore a primary child %s while its managed query was pending",
    async (change) => {
      const parentKey = "agent:main:parent";
      const child: GatewaySessionRow = {
        key: "agent:main:subagent:child",
        sessionId: "old-child",
        kind: "direct",
        spawnedBy: parentKey,
        snapshotAt: 100,
        hasActiveRun: false,
      };
      let root = sessionsResult([child], 100);
      const pending = createDeferred<ReturnType<typeof sessionsResult>>();
      const client = createTestGatewayClient(async (_method, params) =>
        isRecord(params) && params.spawnedBy ? pending.promise : structuredClone(root),
      );
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const refresh = sessions.refreshList({ spawnedBy: parentKey });
      root = sessionsResult(
        change === "removed" ? [] : [{ ...child, sessionId: "new-child", snapshotAt: 200 }],
        200,
      );
      await sessions.refresh({ agentId: "main", force: true });
      const primary = sessions.state.result;
      pending.resolve(sessionsResult([{ ...child, snapshotAt: 300, hasActiveRun: true }], 300));
      await refresh;
      expect(sessions.state.result).toBe(primary);
      sessions.dispose();
    },
  );

  it.each(["disconnects", "replaces the client"] as const)(
    "does not publish a retired child snapshot after a primary listener %s",
    async (transition) => {
      const parentKey = "agent:main:parent";
      const child: GatewaySessionRow = {
        key: "agent:main:subagent:child",
        sessionId: "child-session",
        kind: "direct",
        spawnedBy: parentKey,
        snapshotAt: 100,
        hasActiveRun: false,
      };
      const client = createTestGatewayClient(async (_method, params) =>
        isRecord(params) && params.spawnedBy
          ? sessionsResult([{ ...child, snapshotAt: 200, hasActiveRun: true }], 200)
          : sessionsResult([child], 100),
      );
      const replacementRead = createDeferred<ReturnType<typeof sessionsResult>>();
      const replacementClient = createTestGatewayClient(async () => replacementRead.promise);
      const { gateway, publish } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const stopPrimary = sessions.subscribe((state) => {
        if (state.result?.sessions.some((row) => row.hasActiveRun)) {
          publish(
            transition !== "disconnects",
            transition === "disconnects" ? client : replacementClient,
          );
        }
      });
      const query = { spawnedBy: parentKey };
      const published = vi.fn();
      const stopChildren = sessions.subscribeList(query, (snapshot) => {
        if (snapshot.result && !snapshot.loading) {
          published();
        }
      });
      await sessions.refreshList(query);
      if (transition === "disconnects") {
        expect(sessions.state.result).toBeNull();
      } else {
        expect(gateway.snapshot.client).toBe(replacementClient);
        expect(gateway.snapshot.phase).toBe("connected");
      }
      expect(published).not.toHaveBeenCalled();
      stopPrimary();
      stopChildren();
      sessions.dispose();
      replacementRead.resolve(sessionsResult([], 300));
    },
  );
});
