// @vitest-environment node
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionRequest as sessionRpc } from "./hydration-family.test-support.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { patchReceipt, sessionRow } from "./session-rpc.test-support.ts";

const sidebarQuery = {
  archivedFilter: "all" as const,
  limit: SIDEBAR_SESSION_ROSTER_LIMIT,
  includeDerivedTitles: true,
  includeLastMessage: true,
};

function fixture(handlers: Record<string, (params?: unknown) => unknown>, release: () => void) {
  vi.useFakeTimers();
  const errors: unknown[] = [];
  const request = sessionRpc(handlers);
  const client = createTestGatewayClient((method, params) =>
    request(method, params).catch((error: unknown) => {
      errors.push(error);
      throw error;
    }),
  );
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const pending: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>) => {
    pending.push(promise);
    return promise;
  };
  onTestFinished(async () => {
    try {
      sessions.dispose();
      release();
      await Promise.allSettled(pending);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  const patch = (row: GatewaySessionRow, fields: Parameters<typeof sessions.patch>[1]) =>
    track(
      sessions.patch(row.key, fields, {
        agentId: row.agentId,
        expectedSessionId: row.sessionId,
      }),
    );
  return { client, sessions, emitEvent, track, patch };
}

it.each([
  { name: "permission and read overlap", permission: true, read: true, primary: "main" },
  { name: "no permission projection", permission: false, read: true, primary: "main" },
  { name: "no read overlay", permission: true, read: false, primary: "main" },
  { name: "an intact primary copy", permission: true, read: true, primary: "work" },
])("retains an event label with $name", async ({ permission, read, primary }) => {
  const target = { key: "global", agentId: "work" };
  const initial = sessionRow("work-global-session", {
    key: "global",
    agentId: "work",
    kind: "global",
    updatedAt: 200,
    label: "Before rename",
    archived: false,
    status: "done",
    hasActiveRun: false,
    activeRunIds: [],
    permissionMode: "guarded",
    unread: true,
    lastReadAt: 0,
    lastActivityAt: 200,
  });
  const primaryRow =
    primary === "work"
      ? initial
      : {
          ...initial,
          agentId: "main",
          sessionId: "main-global-session",
          label: "Main roster",
        };
  const oldReply = createDeferred<ReturnType<typeof sessionsResult>>();
  const listReply = createDeferred<ReturnType<typeof sessionsResult>>();
  const listDispatched = createDeferred();
  const readReply = createDeferred<unknown>();
  const readDispatched = createDeferred();
  let permissionAcknowledged = false;
  const h = fixture(
    {
      "sessions.list": (params) => {
        const requestParams = asNullableRecord(params);
        if (requestParams?.archived === "all") {
          return oldReply.promise;
        }
        if (permissionAcknowledged) {
          expect(requestParams?.agentId).toBe("work");
          listDispatched.resolve();
          return listReply.promise;
        }
        expect(requestParams?.agentId).toBe(primary);
        return sessionsResult([primaryRow], 200);
      },
      "sessions.describe": (params) => {
        expect(params).toMatchObject(target);
        return { session: initial };
      },
      "sessions.patch": (params) => {
        const requestParams = asNullableRecord(params);
        expect(params).toMatchObject(target);
        if (requestParams?.permissionMode === "workspace") {
          permissionAcknowledged = true;
          return patchReceipt(
            "global",
            {
              sessionId: initial.sessionId,
              permissionMode: "workspace",
              updatedAt: 201,
            },
            "(multiple)",
          );
        }
        expect(requestParams?.unread).toBe(false);
        readDispatched.resolve();
        return readReply.promise;
      },
    },
    () => {
      oldReply.resolve(sessionsResult([{ ...initial }], 200));
      listReply.resolve(sessionsResult([initial], 200));
      readReply.resolve(patchReceipt("global", initial, "(multiple)"));
    },
  );
  await h.sessions.refresh({ agentId: primary, force: true });
  const observation = h.sessions.observeRow(target, () => {});
  const seed = observation.captureReconcile();
  const described = await h.client.request<{ session: GatewaySessionRow }>(
    "sessions.describe",
    target,
  );
  seed(described.session);
  expect(observation.row).toMatchObject(initial);
  const query = { ...sidebarQuery, agentId: "work" };
  const older = h.track(h.sessions.refreshList({ ...query, force: true }));
  expect(h.sessions.listSnapshot(query).loading).toBe(true);
  h.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: { ...initial, sessionKey: initial.key, reason: "patch", label: "New event label" },
  });
  expect(observation.row?.label).toBe("New event label");
  if (permission) {
    void h.patch(initial, { permissionMode: "workspace" });
    await listDispatched.promise;
  }
  if (read) {
    void h.patch(initial, { unread: false });
    await readDispatched.promise;
    expect(observation.row?.unread).toBe(false);
  }
  oldReply.resolve(sessionsResult([{ ...initial }], 200));
  await older;
  expect(observation.row).toMatchObject({
    label: "New event label",
    permissionMode: permission ? "workspace" : "guarded",
    unread: !read,
  });
  if (primary === "main") {
    expect(h.sessions.state.agentId).toBe("main");
    expect(h.sessions.state.result?.sessions).toEqual([primaryRow]);
  }
});

it.each([
  { name: "swarm and pin overlap", swarm: true, pin: true },
  { name: "no swarm decoration", swarm: false, pin: true },
  { name: "no pin overlay", swarm: true, pin: false },
])("retains a newer list preview with $name", async ({ swarm, pin }) => {
  const parentKey = "agent:main:main";
  const groupId = "swarm:agent:main:main:turn-42";
  const initial = sessionRow("worker-session", {
    key: "agent:main:subagent:worker",
    agentId: "main",
    parentSessionKey: parentKey,
    swarmGroupId: groupId,
    archived: false,
    updatedAt: 10,
    pinned: false,
    lastMessagePreview: "Before streaming output",
  });
  const parent = sessionRow("parent-session", {
    key: parentKey,
    agentId: "main",
    updatedAt: 1,
  });
  const fresh = { ...initial, lastMessagePreview: "New streaming output" };
  let current = initial;
  const oldReply = createDeferred<ReturnType<typeof sessionsResult>>();
  const pinReply = createDeferred<unknown>();
  const pinDispatched = createDeferred();
  const h = fixture(
    {
      "sessions.list": (params) => {
        const requestParams = asNullableRecord(params);
        if (requestParams?.archived === "all") {
          return oldReply.promise;
        }
        expect(params).toMatchObject({ agentId: "main", includeLastMessage: true });
        return sessionsResult([parent, current], 10);
      },
      "sessions.patch": (params) => {
        expect(params).toMatchObject({ key: initial.key, pinned: true });
        pinDispatched.resolve();
        return pinReply.promise;
      },
    },
    () => {
      oldReply.resolve(sessionsResult([parent, { ...initial }], 10));
      pinReply.resolve(patchReceipt(initial.key, initial, "(multiple)"));
    },
  );
  const refresh = () =>
    h.sessions.refresh({ agentId: "main", force: true, includeLastMessage: true });
  const row = () => h.sessions.state.result?.sessions.find((entry) => entry.key === initial.key);
  await refresh();
  if (swarm) {
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        ...parent,
        sessionKey: parentKey,
        reason: "swarm-note",
        swarmGroupId: groupId,
        kind: "log",
        text: "Work is progressing",
      },
    });
    expect(row()).toHaveProperty("swarmLog", "Work is progressing");
  }
  if (pin) {
    void h.patch(initial, { pinned: true });
    await pinDispatched.promise;
    expect(row()?.pinned).toBe(true);
  }
  const query = { ...sidebarQuery, agentId: "main" };
  const older = h.track(h.sessions.refreshList({ ...query, force: true }));
  expect(h.sessions.listSnapshot(query).loading).toBe(true);
  current = fresh;
  await refresh();
  expect(row()).toMatchObject({ lastMessagePreview: fresh.lastMessagePreview, pinned: pin });
  oldReply.resolve(sessionsResult([parent, { ...initial }], 10));
  await older;
  const managed = h.sessions
    .listSnapshot(query)
    .result?.sessions.find((entry) => entry.key === initial.key);
  expect(managed).toMatchObject({ lastMessagePreview: fresh.lastMessagePreview, pinned: pin });
  expect(row()).toMatchObject({ lastMessagePreview: fresh.lastMessagePreview, pinned: pin });
  if (swarm) {
    expect(row()).toHaveProperty("swarmLog", "Work is progressing");
  }
});
