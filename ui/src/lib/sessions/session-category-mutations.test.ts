// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const initial: GatewaySessionRow = {
  key: "agent:main:category-test",
  sessionId: "category-incarnation",
  kind: "direct",
  updatedAt: 1,
  category: "Alpha",
  pinned: false,
};

function setup() {
  const replies = [createDeferred<unknown>(), createDeferred<unknown>()];
  const list = createDeferred<ReturnType<typeof sessionsResult>>();
  const listStarted = createDeferred();
  let reads = 0;
  let writes = 0;
  const client = createTestGatewayClient(async (method) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.patch") {
      return replies[writes++]!.promise;
    }
    if (method === "sessions.list") {
      if (++reads === 1) {
        return sessionsResult([initial], 1);
      }
      listStarted.resolve();
      return list.promise;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const harness = createGatewayHarness(client);
  const sessions = createTestSessionCapability(harness.gateway);
  const confirm = (index: number, category: string | undefined, updatedAt = index + 2) =>
    replies[index]!.resolve({
      ok: true,
      key: initial.key,
      path: "",
      entry: { ...initial, category, updatedAt },
    });
  return {
    ...harness,
    sessions,
    replies,
    list,
    listStarted,
    confirm,
    category: () => sessions.state.result?.sessions[0]?.category,
  };
}

const options = { agentId: "main", expectedSessionId: initial.sessionId };

describe("session category mutations", () => {
  it.each(["Beta", null])(
    "projects %s immediately and preserves its receipt when refresh fails",
    async (category) => {
      const h = setup();
      try {
        await h.sessions.refresh({ agentId: "main", force: true });
        const pending = h.sessions.patch(initial.key, { category }, options);
        expect(h.category()).toBe(category ?? undefined);
        h.confirm(0, category ?? undefined);
        await h.listStarted.promise;
        expect(h.category()).toBe(category ?? undefined);
        await expect(pending).resolves.toMatchObject({ ok: true });
        h.list.reject(new Error("injected list failure"));
        await h.list.promise.catch(() => undefined);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(h.category()).toBe(category ?? undefined);
        expect(h.sessions.state.error).toContain("The session move was saved");
        expect(h.sessions.state.error).toContain("injected list failure");
      } finally {
        h.sessions.dispose();
      }
    },
  );

  it("keeps the latest A→B→A intent through out-of-order receipts and stale events", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const first = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      const second = h.sessions.patch(
        initial.key,
        { category: "Alpha" },
        { ...options, deferListRefresh: true },
      );
      expect(h.category()).toBe("Alpha");
      h.confirm(1, "Alpha", 3);
      await second;
      h.confirm(0, "Beta", 2);
      await first;
      expect(h.category()).toBe("Alpha");
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          ...initial,
          sessionKey: initial.key,
          reason: "patch",
          category: "Beta",
          updatedAt: 2,
          archived: false,
          session: { ...initial, category: "Beta", updatedAt: 2, archived: false },
        },
      });
      expect(h.category()).toBe("Alpha");
    } finally {
      h.sessions.dispose();
    }
  });

  it("rolls back a rejected newest move to the earlier confirmed category", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const first = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      const second = h.sessions.patch(
        initial.key,
        { category: null },
        { ...options, deferListRefresh: true },
      );
      h.confirm(0, "Beta");
      await first;
      expect(h.category()).toBeUndefined();
      h.replies[1]!.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "move rejected" }),
      );
      await expect(second).rejects.toThrow("move rejected");
      expect(h.category()).toBe("Beta");
    } finally {
      h.sessions.dispose();
    }
  });
  it("does not roll back an uncertain transport failure and never retries the write", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.sessions.patch(initial.key, { category: "Beta" }, options);
      h.replies[0]!.reject(new Error("connection lost"));
      await expect(pending).rejects.toThrow("could not be confirmed");
      expect(h.category()).toBe("Beta");
      await h.listStarted.promise;
      h.list.resolve(sessionsResult([{ ...initial, category: "Beta", updatedAt: 2 }], 2));
      await h.list.promise;
    } finally {
      h.sessions.dispose();
    }
  });

  it("keeps category and pin receipts together without waiting for the list", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.sessions.patch(initial.key, { category: null, pinned: true }, options);
      expect(h.sessions.state.result?.sessions[0]).toMatchObject({ pinned: true });
      expect(h.category()).toBeUndefined();
      h.replies[0]!.resolve({
        ok: true,
        path: "",
        key: initial.key,
        entry: { ...initial, category: undefined, pinnedAt: 7, updatedAt: 7 },
      });
      await pending;
      expect(h.sessions.state.result?.sessions[0]).toMatchObject({ pinned: true, pinnedAt: 7 });
      h.list.resolve(
        sessionsResult(
          [{ ...initial, category: undefined, pinned: true, pinnedAt: 7, updatedAt: 7 }],
          7,
        ),
      );
    } finally {
      h.sessions.dispose();
    }
  });

  it("does not restore an old intent over a newer pending move", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const first = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      const second = h.sessions.patch(
        initial.key,
        { category: "Gamma" },
        { ...options, deferListRefresh: true },
      );
      h.replies[0]!.reject(new GatewayRequestError({ code: "FORBIDDEN", message: "first denied" }));
      await expect(first).rejects.toThrow("first denied");
      expect(h.category()).toBe("Gamma");
      h.confirm(1, "Gamma");
      await second;
      expect(h.category()).toBe("Gamma");
    } finally {
      h.sessions.dispose();
    }
  });

  it("does not project a late receipt into a replacement session", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      const reading = h.sessions.refresh({ agentId: "main", force: true });
      h.list.resolve(
        sessionsResult(
          [{ ...initial, sessionId: "replacement", category: "Replacement", updatedAt: 9 }],
          9,
        ),
      );
      await reading;
      h.confirm(0, "Beta");
      await pending;
      expect(h.category()).toBe("Replacement");
    } finally {
      h.sessions.dispose();
    }
  });

  it("retires placement intent when the connection is replaced", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      h.publish(false, null);
      h.confirm(0, "Beta");
      await expect(pending).resolves.toBeNull();
      expect(h.sessions.state.error).toBeNull();
    } finally {
      h.sessions.dispose();
    }
  });
  it("keeps a confirmed category ahead of a read started before the write", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const reading = h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      h.confirm(0, "Beta");
      await pending;
      h.list.resolve(sessionsResult([{ ...initial }], 1));
      await reading;
      expect(h.category()).toBe("Beta");
    } finally {
      h.sessions.dispose();
    }
  });

  it("continues admitting newer authoritative category events", async () => {
    const h = setup();
    try {
      await h.sessions.refresh({ agentId: "main", force: true });
      const pending = h.sessions.patch(
        initial.key,
        { category: "Beta" },
        { ...options, deferListRefresh: true },
      );
      h.confirm(0, "Beta");
      await pending;
      h.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          ...initial,
          sessionKey: initial.key,
          reason: "patch",
          category: "External",
          updatedAt: 9,
          archived: false,
          session: { ...initial, category: "External", updatedAt: 9, archived: false },
        },
      });
      expect(h.category()).toBe("External");
    } finally {
      h.sessions.dispose();
    }
  });
});

it.each(["different", "returned"] as const)(
  "does not publish an old scoped category refresh failure into the %s foreground",
  async (selection) => {
    const reply = createDeferred<unknown>();
    const oldRead = createDeferred<ReturnType<typeof sessionsResult>>();
    let committed = false;
    let scopedReads = 0;
    const writer = {
      ...initial,
      key: "agent:writer:main",
      sessionId: "writer",
      category: "Writer",
    };
    const client = createTestGatewayClient(async (method, raw) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.patch") {
        return reply.promise;
      }
      if (method === "sessions.list") {
        if ((raw as { agentId?: string }).agentId === "writer") {
          return sessionsResult([writer], 3);
        }
        if (committed && ++scopedReads === 1) {
          return oldRead.promise;
        }
        return sessionsResult([{ ...initial, category: committed ? "External" : "Alpha" }], 4);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const h = createGatewayHarness(client);
    const sessions = createTestSessionCapability(h.gateway);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const move = sessions.patch(initial.key, { category: "Beta" }, options);
      await sessions.refresh({ agentId: "writer", force: true });
      committed = true;
      reply.resolve({
        ok: true,
        key: initial.key,
        entry: { ...initial, category: "Beta", updatedAt: 2 },
      });
      await move;
      await vi.waitFor(() => expect(scopedReads).toBe(1));
      if (selection === "returned") {
        await sessions.refresh({ agentId: "main", force: true });
      }
      oldRead.reject(new Error("old agent read failed"));
      // Let the completed read propagate through the refresh promise chain.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(sessions.state.agentId).toBe(selection === "returned" ? "main" : "writer");
      expect(sessions.state.error).toBeNull();
    } finally {
      sessions.dispose();
    }
  },
);
