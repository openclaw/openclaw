// @vitest-environment node
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

function fixture(request: Parameters<typeof createTestGatewayClient>[0], release: () => void) {
  vi.useFakeTimers();
  const errors: unknown[] = [];
  const client = createTestGatewayClient(async (method, params) => {
    try {
      return await request(method, params);
    } catch (error) {
      errors.push(error);
      throw error;
    }
  });
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
  return { client, sessions, emitEvent, track };
}

describe("optimistic row provenance", () => {
  it.each([
    { name: "permission and read overlap", permission: true, read: true, primary: "main" },
    { name: "no permission projection", permission: false, read: true, primary: "main" },
    { name: "no read overlay", permission: true, read: false, primary: "main" },
    { name: "an intact primary copy", permission: true, read: true, primary: "work" },
  ])("retains an event label with $name", async ({ permission, read, primary }) => {
    const initial: GatewaySessionRow = {
      key: "global",
      agentId: "work",
      sessionId: "work-global-session",
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
    };
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
      async (method, params) => {
        const requestParams = asNullableRecord(params);
        if (method === "sessions.list") {
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
        }
        if (method === "sessions.describe") {
          expect(params).toMatchObject({ key: "global", agentId: "work" });
          return { session: initial };
        }
        if (method === "sessions.patch") {
          expect(params).toMatchObject({ key: "global", agentId: "work" });
          if (requestParams?.permissionMode === "workspace") {
            permissionAcknowledged = true;
            return {
              ok: true,
              path: "(multiple)",
              key: "global",
              entry: { sessionId: initial.sessionId, permissionMode: "workspace", updatedAt: 201 },
            };
          }
          expect(requestParams?.unread).toBe(false);
          readDispatched.resolve();
          return readReply.promise;
        }
        throw new Error(`Unexpected Gateway method: ${method}`);
      },
      () => {
        oldReply.resolve(sessionsResult([{ ...initial }], 200));
        listReply.resolve(sessionsResult([initial], 200));
        readReply.resolve({ ok: true, path: "(multiple)", key: "global", entry: initial });
      },
    );
    await h.sessions.refresh({ agentId: primary, force: true });
    const observation = h.sessions.observeRow({ key: "global", agentId: "work" }, () => {});
    const seed = observation.captureReconcile();
    seed(
      (
        await h.client.request<{ session: GatewaySessionRow }>("sessions.describe", {
          key: "global",
          agentId: "work",
        })
      ).session,
    );
    expect(observation.row).toMatchObject(initial);
    const query = {
      agentId: "work",
      archivedFilter: "all" as const,
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    const older = h.track(h.sessions.refreshList({ ...query, force: true }));
    expect(h.sessions.listSnapshot(query).loading).toBe(true);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { ...initial, sessionKey: initial.key, reason: "patch", label: "New event label" },
    });
    expect(observation.row?.label).toBe("New event label");
    if (permission) {
      void h.track(
        h.sessions.patch(
          "global",
          { permissionMode: "workspace" },
          {
            agentId: "work",
            expectedSessionId: initial.sessionId,
          },
        ),
      );
      await listDispatched.promise;
    }
    if (read) {
      void h.track(
        h.sessions.patch(
          "global",
          { unread: false },
          {
            agentId: "work",
            expectedSessionId: initial.sessionId,
          },
        ),
      );
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
    const initial: GatewaySessionRow = {
      key: "agent:main:subagent:worker",
      agentId: "main",
      sessionId: "worker-session",
      kind: "direct",
      parentSessionKey: parentKey,
      swarmGroupId: groupId,
      archived: false,
      updatedAt: 10,
      pinned: false,
      lastMessagePreview: "Before streaming output",
    };
    const parent: GatewaySessionRow = {
      key: parentKey,
      agentId: "main",
      sessionId: "parent-session",
      kind: "direct",
      updatedAt: 1,
    };
    const fresh = { ...initial, lastMessagePreview: "New streaming output" };
    let current = initial;
    const oldReply = createDeferred<ReturnType<typeof sessionsResult>>();
    const pinReply = createDeferred<unknown>();
    const pinDispatched = createDeferred();
    const h = fixture(
      async (method, params) => {
        const requestParams = asNullableRecord(params);
        if (method === "sessions.list") {
          if (requestParams?.archived === "all") {
            return oldReply.promise;
          }
          expect(params).toMatchObject({ agentId: "main", includeLastMessage: true });
          return sessionsResult([parent, current], 10);
        }
        if (method === "sessions.patch") {
          expect(params).toMatchObject({ key: initial.key, pinned: true });
          pinDispatched.resolve();
          return pinReply.promise;
        }
        throw new Error(`Unexpected Gateway method: ${method}`);
      },
      () => {
        oldReply.resolve(sessionsResult([parent, { ...initial }], 10));
        pinReply.resolve({ ok: true, path: "(multiple)", key: initial.key, entry: initial });
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
      void h.track(
        h.sessions.patch(
          initial.key,
          { pinned: true },
          {
            agentId: "main",
            expectedSessionId: initial.sessionId,
          },
        ),
      );
      await pinDispatched.promise;
      expect(row()?.pinned).toBe(true);
    }
    const query = {
      agentId: "main",
      archivedFilter: "all" as const,
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
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
});
