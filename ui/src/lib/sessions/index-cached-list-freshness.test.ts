// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const parentKey = "agent:main:parent";
const childQuery = { spawnedBy: parentKey };
const activeRun = { status: "running" as const, hasActiveRun: true, activeRunIds: ["new-run"] };
function childRow(sessionId: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: "agent:main:subagent:child",
    sessionId,
    kind: "direct",
    spawnedBy: parentKey,
    snapshotAt: 100,
    hasActiveRun: false,
    ...fields,
  };
}
function setup(request: Parameters<typeof createTestGatewayClient>[0]) {
  const harness = createGatewayHarness(createTestGatewayClient(request));
  return { ...harness, sessions: createTestSessionCapability(harness.gateway) };
}

const background: GatewaySessionRow = {
  key: "agent:main:background",
  sessionId: "background-session",
  kind: "direct",
  updatedAt: 10,
  snapshotAt: 100,
  status: "done",
  hasActiveRun: false,
  activeRunIds: [],
};

function emitRuntime(harness: ReturnType<typeof createGatewayHarness>, session: GatewaySessionRow) {
  harness.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      agentId: "main",
      reason: "run-capacity",
      session,
      ancestorSessions: [],
      ts: session.snapshotAt,
    },
  });
}

it("orders runtime events and cached list pages by their sampling clock", async () => {
  const running = { ...background, ...activeRun, snapshotAt: 200 };
  let page = sessionsResult([background], 100);
  const harness = setup(async () => structuredClone(page));
  const { sessions } = harness;
  await sessions.refresh({ agentId: "main", force: true });
  const completed = { ...background, snapshotAt: 300 };
  const settled = { ...background, snapshotAt: 500 };
  const steps: Array<["event" | "list", GatewaySessionRow, GatewaySessionRow?]> = [
    ["event", running, running],
    ["list", background, running],
    ["list", completed, completed],
    ["event", running, completed],
    ["list", { ...running, snapshotAt: 400 }],
    ["event", settled, settled],
  ];
  for (const [source, sample, expected] of steps) {
    if (source === "list") {
      page = sessionsResult([sample], sample.snapshotAt ?? 0);
      await sessions.refresh({ agentId: "main", force: true });
    } else {
      emitRuntime(harness, sample);
    }
    if (expected) {
      expect(sessions.state.result?.sessions[0]).toMatchObject(expected);
    }
  }
});

it("keeps fresh child facts when a later root request returns an older cached page", async () => {
  const parent: GatewaySessionRow = {
    key: parentKey,
    sessionId: "parent-session",
    kind: "direct",
    childSessions: ["agent:main:subagent:child"],
  };
  const child = childRow("child-session", { updatedAt: 10, status: "done", activeRunIds: [] });
  const freshChild = { ...child, ...activeRun, snapshotAt: 200 };
  let root = sessionsResult([parent, child], 100);
  const children = sessionsResult([freshChild], 200);
  const { sessions } = setup(async (method, params) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    expect(method).toBe("sessions.list");
    return structuredClone(isRecord(params) && params.spawnedBy ? children : root);
  });
  const query = { ...childQuery, limit: 100 };
  await sessions.refresh({ agentId: "main", force: true });
  const primaryRevision = sessions.canonicalListRevision;
  const published: Array<[string | undefined, string | undefined]> = [];
  const capturePublication = () =>
    published.push([
      sessions.state.result?.sessions.find((row) => row.key === child.key)?.status,
      sessions.listSnapshot(query).result?.sessions.find((row) => row.key === child.key)?.status,
    ]);
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
  const assertChild = (facts: Partial<GatewaySessionRow>) => {
    expect(sessions.projectRows([child])[0]).toMatchObject(facts);
    expect(sessions.state.result?.sessions.find((row) => row.key === child.key)).toMatchObject(
      facts,
    );
  };
  assertChild({ hasActiveRun: true, status: "running", activeRunIds: ["new-run"] });
  await sessions.refresh({ agentId: "main", force: true });
  assertChild({ hasActiveRun: true, status: "running", activeRunIds: ["new-run"] });

  root = sessionsResult([parent, { ...child, snapshotAt: 300, status: "done" }], 300);
  await sessions.refresh({ agentId: "main", force: true });
  assertChild({ hasActiveRun: false, status: "done" });
  await sessions.refreshList(query);
  assertChild({ hasActiveRun: false, status: "done" });
});

it.each(["removed", "replaced"] as const)(
  "does not restore a primary child %s while its managed query was pending",
  async (change) => {
    const child = childRow("old-child");
    let root = sessionsResult([child], 100);
    const pending = createDeferred<ReturnType<typeof sessionsResult>>();
    const { sessions } = setup(async (_method, params) =>
      isRecord(params) && params.spawnedBy ? pending.promise : structuredClone(root),
    );
    await sessions.refresh({ agentId: "main", force: true });
    const refresh = sessions.refreshList(childQuery);
    root = sessionsResult(
      change === "removed" ? [] : [{ ...child, sessionId: "new-child", snapshotAt: 200 }],
      200,
    );
    await sessions.refresh({ agentId: "main", force: true });
    const primary = sessions.state.result;
    pending.resolve(sessionsResult([{ ...child, snapshotAt: 300, hasActiveRun: true }], 300));
    await refresh;
    expect(sessions.state.result).toBe(primary);
  },
);

it.each(["disconnects", "replaces the client"] as const)(
  "does not publish a retired child snapshot after a primary listener %s",
  async (transition) => {
    const disconnected = transition === "disconnects";
    const child = childRow("child-session");
    const { gateway, publish, sessions } = setup(async (_method, params) =>
      isRecord(params) && params.spawnedBy
        ? sessionsResult([{ ...child, snapshotAt: 200, hasActiveRun: true }], 200)
        : sessionsResult([child], 100),
    );
    const replacementRead = createDeferred<ReturnType<typeof sessionsResult>>();
    const replacementClient = createTestGatewayClient(async () => replacementRead.promise);
    const client = gateway.snapshot.client;
    await sessions.refresh({ agentId: "main", force: true });
    sessions.subscribe((state) => {
      if (state.result?.sessions.some((row) => row.hasActiveRun)) {
        publish(!disconnected, disconnected ? client : replacementClient);
      }
    });
    const published = vi.fn();
    sessions.subscribeList(childQuery, (snapshot) => {
      if (snapshot.result && !snapshot.loading) {
        published();
      }
    });
    await sessions.refreshList(childQuery);
    if (disconnected) {
      expect(sessions.state.result).toBeNull();
    } else {
      expect(gateway.snapshot.client).toBe(replacementClient);
      expect(gateway.snapshot.phase).toBe("connected");
    }
    expect(published).not.toHaveBeenCalled();
    sessions.dispose();
    replacementRead.resolve(sessionsResult([], 300));
  },
);
