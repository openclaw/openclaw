// @vitest-environment node
import { setImmediate as flushRead } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { sessionRpcHarness } from "./session-rpc.test-support.ts";

const initial: GatewaySessionRow = {
  key: "agent:main:category-test",
  sessionId: "category-incarnation",
  kind: "direct",
  updatedAt: 1,
  category: "Alpha",
  pinned: false,
};
const result = (overrides: Partial<GatewaySessionRow>, ts = 2) =>
  sessionsResult([{ ...initial, ...overrides }], ts);
const receipt = (overrides: Partial<GatewaySessionRow>, updatedAt = 2) => ({
  ok: true,
  key: initial.key,
  path: "",
  entry: { ...initial, updatedAt, ...overrides },
});
function setup(readList?: (params: unknown) => Promise<ReturnType<typeof sessionsResult>>) {
  const replies = [createDeferred<unknown>(), createDeferred<unknown>()];
  const list = createDeferred<ReturnType<typeof sessionsResult>>();
  const listStarted = createDeferred();
  let reads = 0;
  let writes = 0;
  const harness = sessionRpcHarness(
    {
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.patch": () => replies[writes++]!.promise,
      "sessions.list": (params) => {
        if (readList) {
          return readList(params);
        }
        if (++reads === 1) {
          return result({}, 1);
        }
        listStarted.resolve();
        return list.promise;
      },
    },
    createTestGatewayClient,
  );
  const { sessions } = harness;
  const confirm = (index: number, category: string | undefined, updatedAt = index + 2) =>
    replies[index]!.resolve(receipt({ category }, updatedAt));
  return {
    ...harness,
    sessions,
    replies,
    list,
    listStarted,
    confirm,
    category: () => sessions.state.result?.sessions[0]?.category,
    move: (category: string | null) =>
      sessions.patch(initial.key, { category }, { ...options, deferListRefresh: true }),
    categoryEvent: (category: string, updatedAt: number) => {
      const session = { ...initial, category, updatedAt, archived: false };
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { ...session, sessionKey: initial.key, reason: "patch", session },
      });
    },
  };
}

const options = { agentId: "main", expectedSessionId: initial.sessionId };

describe("session category mutations", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await h.sessions.refresh({ agentId: "main", force: true });
  });

  it.each([false, true])(
    "settles a cleared category before its list refresh (pin=%s)",
    async (pin) => {
      const changes = { category: null, ...(pin ? { pinned: true } : {}) };
      const pending = h.sessions.patch(initial.key, changes, options);
      if (pin) {
        expect(h.sessions.state.result?.sessions[0]).toMatchObject({ pinned: true });
      }
      expect(h.category()).toBeUndefined();
      h.replies[0]!.resolve(
        receipt({ category: undefined, ...(pin ? { pinnedAt: 7 } : {}) }, pin ? 7 : 2),
      );
      await h.listStarted.promise;
      expect(h.category()).toBeUndefined();
      await expect(pending).resolves.toMatchObject({ ok: true });
      if (pin) {
        expect(h.sessions.state.result?.sessions[0]).toMatchObject({ pinned: true, pinnedAt: 7 });
        h.list.resolve(result({ category: undefined, pinned: true, pinnedAt: 7, updatedAt: 7 }, 7));
      } else {
        h.list.reject(new Error("injected list failure"));
        await h.list.promise.catch(() => undefined);
        await flushRead();
        expect(h.category()).toBeUndefined();
        expect(h.sessions.state.error).toContain("The session move was saved");
        expect(h.sessions.state.error).toContain("injected list failure");
      }
    },
  );

  it("keeps the latest A→B→A intent through out-of-order receipts and stale events", async () => {
    const first = h.move("Beta");
    const second = h.move("Alpha");
    expect(h.category()).toBe("Alpha");
    h.confirm(1, "Alpha", 3);
    await second;
    h.confirm(0, "Beta", 2);
    await first;
    expect(h.category()).toBe("Alpha");
    h.categoryEvent("Beta", 2);
    expect(h.category()).toBe("Alpha");
    h.categoryEvent("External", 9);
    expect(h.category()).toBe("External");
  });

  it.each([
    [1, null, "INVALID_REQUEST", "move rejected", "Beta"],
    [0, "Gamma", "FORBIDDEN", "first denied", "Gamma"],
  ] as const)(
    "rolls back only rejected intent %i",
    async (rejected, newest, code, message, kept) => {
      const moves = [h.move("Beta"), h.move(newest)];
      if (rejected === 1) {
        h.confirm(0, "Beta");
        await moves[0];
        expect(h.category()).toBeUndefined();
      }
      h.replies[rejected]!.reject(new GatewayRequestError({ code, message }));
      await expect(moves[rejected]).rejects.toThrow(message);
      expect(h.category()).toBe(kept);
      if (rejected === 0) {
        h.confirm(1, "Gamma");
        await moves[1];
        expect(h.category()).toBe("Gamma");
      }
    },
  );
  it("does not roll back an uncertain transport failure and never retries the write", async () => {
    const pending = h.sessions.patch(initial.key, { category: "Beta" }, options);
    h.replies[0]!.reject(new Error("connection lost"));
    await expect(pending).rejects.toThrow("could not be confirmed");
    expect(h.category()).toBe("Beta");
    await h.listStarted.promise;
    h.list.resolve(result({ category: "Beta", updatedAt: 2 }));
    await h.list.promise;
    await flushRead();
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
  });

  it.each(["session", "connection"])(
    "retires placement intent when its %s is replaced",
    async (owner) => {
      const pending = h.move("Beta");
      if (owner === "session") {
        const reading = h.sessions.refresh({ agentId: "main", force: true });
        h.list.resolve(
          result({ sessionId: "replacement", category: "Replacement", updatedAt: 9 }, 9),
        );
        await reading;
      } else {
        h.publish(false, null);
      }
      h.confirm(0, "Beta");
      if (owner === "session") {
        await pending;
        expect(h.category()).toBe("Replacement");
      } else {
        await expect(pending).resolves.toBeNull();
        expect(h.sessions.state.error).toBeNull();
      }
    },
  );
  it("keeps a confirmed category ahead of a read started before the write", async () => {
    const reading = h.sessions.refresh({ agentId: "main", force: true });
    const pending = h.move("Beta");
    h.confirm(0, "Beta");
    await pending;
    h.list.resolve(result({}, 1));
    await reading;
    expect(h.category()).toBe("Beta");
  });
});

it.each(["different", "returned"] as const)(
  "does not publish an old scoped category refresh failure into the %s foreground",
  async (selection) => {
    const oldRead = createDeferred<ReturnType<typeof sessionsResult>>();
    let committed = false;
    let scopedReads = 0;
    const writer = { ...initial, key: "agent:writer:main", sessionId: "writer" };
    const { sessions, confirm } = setup(async (raw) => {
      if ((raw as { agentId?: string }).agentId === "writer") {
        return sessionsResult([writer], 3);
      }
      if (committed && ++scopedReads === 1) {
        return oldRead.promise;
      }
      return result({ category: committed ? "External" : "Alpha" }, 4);
    });
    await sessions.refresh({ agentId: "main", force: true });
    const move = sessions.patch(initial.key, { category: "Beta" }, options);
    await sessions.refresh({ agentId: "writer", force: true });
    committed = true;
    confirm(0, "Beta");
    await move;
    await vi.waitFor(() => expect(scopedReads).toBe(1));
    if (selection === "returned") {
      await sessions.refresh({ agentId: "main", force: true });
    }
    oldRead.reject(new Error("old agent read failed"));
    await flushRead();
    expect(sessions.state).toMatchObject({
      agentId: selection === "returned" ? "main" : "writer",
      error: null,
    });
  },
);
