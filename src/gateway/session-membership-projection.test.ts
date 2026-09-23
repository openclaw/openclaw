import { afterEach, expect, it, vi } from "vitest";
import type { SessionMembershipFacts } from "../config/sessions/session-membership-facts.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSessionMembershipProjection } from "./session-membership-projection.js";

const { readFacts } = vi.hoisted(() => ({ readFacts: vi.fn() }));
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabases: async (
    targets: readonly { path: string }[],
    consume: (owners: { readMembershipFacts: typeof readFacts }[]) => Promise<unknown>,
  ) => consume(targets.map(() => ({ readMembershipFacts: readFacts }))),
}));

afterEach(() => readFacts.mockReset());

const target = {
  agentId: "main",
  storePath: "/sessions/store.json",
  filename: "/sessions/agent.sqlite",
  identity: "1:2",
};
const sessionKey = "agent:main:shared";
const snapshot = (
  identity: string,
  members: string[],
  category = "work",
): SessionMembershipFacts => ({
  kind: "session-membership-facts",
  identity,
  facts: [
    [
      sessionKey,
      category,
      members,
      { participants: [{ identity: { type: "profile", id: "alice" } }], participantCount: 1 },
      "shared-session",
    ],
  ],
});

it("coalesces viewer preparation and never reinstates membership revoked during a worker read", async () => {
  const deferred = createDeferredCore<SessionMembershipFacts>();
  readFacts
    .mockReturnValueOnce(deferred.promise)
    .mockResolvedValueOnce(snapshot(target.identity, []));
  const projection = createSessionMembershipProjection();
  projection.updateTargets([target]);
  try {
    const viewers = Array.from({ length: 50 }, () => projection.prepare());
    projection.invalidate({
      storePath: target.storePath,
      sessionKey,
      facts: { kind: "member", sessionId: "shared-session", identityId: "alice", present: false },
    });
    expect(projection.membership(target.storePath, sessionKey)).toEqual([]);
    deferred.resolve(snapshot(target.identity, ["alice"]));
    await Promise.all(viewers);
    expect(projection.membership(target.storePath, sessionKey)).toEqual([]);
    expect(projection.groupTargets().get("work")).toEqual([{ sessionKey, agentId: "main" }]);
    expect(readFacts).toHaveBeenCalledTimes(2);
    expect(projection.ready(target.filename, sessionKey)).toBe(true);
    projection.invalidate({
      storePath: target.filename,
      sessionKey,
      facts: { kind: "member", sessionId: "shared-session", identityId: "bob", present: true },
    });
    expect(projection.membership(target.storePath, sessionKey)).toEqual(["bob"]);
    expect(projection.needsPreparation).toBe(false);
  } finally {
    projection.dispose();
  }
});

it.each(["replace", "remove", "dispose"] as const)(
  "rejects an in-flight snapshot after store %s",
  async (operation) => {
    const deferred = createDeferredCore<SessionMembershipFacts>();
    readFacts
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(snapshot("3:4", ["bob"], "new"));
    const projection = createSessionMembershipProjection();
    projection.updateTargets([target]);
    try {
      const prepared = projection.prepare();
      if (operation === "replace") {
        projection.updateTargets([{ ...target, identity: "3:4" }]);
      } else if (operation === "remove") {
        projection.updateTargets([]);
      } else {
        projection.dispose();
      }
      deferred.resolve(snapshot(target.identity, ["alice"]));
      await prepared;
      expect(projection.membership(target.storePath, sessionKey)).toEqual(
        operation === "replace" ? ["bob"] : undefined,
      );
      expect([...projection.groupTargets().keys()]).toEqual(operation === "replace" ? ["new"] : []);
    } finally {
      projection.dispose();
    }
  },
);

it("retains failed refresh work and patches only committed changed keys", async () => {
  readFacts.mockResolvedValueOnce(snapshot(target.identity, ["alice"]));
  const projection = createSessionMembershipProjection();
  projection.updateTargets([target]);
  try {
    await projection.prepare();
    readFacts.mockRejectedValueOnce(new Error("reader unavailable"));
    projection.invalidate({ storePath: target.filename, sessionKey, factsInvalidated: true });
    await expect(projection.prepare()).rejects.toThrow("reader unavailable");
    expect(projection.ready(target.storePath, sessionKey)).toBe(false);
    expect(projection.membership(target.storePath, sessionKey)).toEqual([]);
    readFacts.mockResolvedValueOnce({
      kind: "session-membership-facts",
      identity: target.identity,
      facts: [],
    });
    await projection.prepare();
    expect(readFacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionKeys: [sessionKey] }),
    );
    expect(projection.membership(target.storePath, sessionKey)).toEqual([]);
    expect([...projection.groupTargets()]).toEqual([]);
    expect(projection.ready(target.storePath, sessionKey)).toBe(true);
  } finally {
    projection.dispose();
  }
});

it("retires membership when a new file reuses a previous database inode", async () => {
  readFacts
    .mockResolvedValueOnce({ ...snapshot(target.identity, ["alice"]), birthtime: "old" })
    .mockResolvedValueOnce({ ...snapshot(target.identity, ["bob"], "new"), birthtime: "new" });
  const projection = createSessionMembershipProjection();
  projection.updateTargets([{ ...target, birthtime: "old" }]);
  try {
    await projection.prepare();
    projection.updateTargets([{ ...target, birthtime: "new" }]);
    expect(projection.membership(target.storePath, sessionKey)).toEqual([]);
    expect(projection.ready(target.storePath, sessionKey)).toBe(false);
    await projection.prepare();
    expect(projection.membership(target.storePath, sessionKey)).toEqual(["bob"]);
    expect([...projection.groupTargets().keys()]).toEqual(["new"]);
    expect(readFacts).toHaveBeenCalledTimes(2);
  } finally {
    projection.dispose();
  }
});

it("shares physical membership across logical aliases and publishes each group member once", async () => {
  const alias = { ...target, storePath: "/alias/sessions.json" };
  readFacts.mockResolvedValue(snapshot(target.identity, ["alice"]));
  const projection = createSessionMembershipProjection();
  projection.updateTargets([target, alias]);
  try {
    await projection.prepare();
    expect(readFacts).toHaveBeenCalledTimes(1);
    expect(projection.groupTargets().get("work")).toEqual([{ sessionKey, agentId: "main" }]);
    projection.invalidate({
      storePath: target.filename,
      sessionKey,
      facts: { kind: "member", sessionId: "shared-session", identityId: "alice", present: false },
    });
    for (const storePath of [target.storePath, alias.storePath, target.filename]) {
      expect(projection.membership(storePath, sessionKey)).toEqual([]);
    }
    projection.invalidate({
      storePath: alias.storePath,
      sessionKey,
      facts: { kind: "member", sessionId: "shared-session", identityId: "bob", present: true },
    });
    expect(projection.membership(target.storePath, sessionKey)).toEqual(["bob"]);
    projection.updateTargets([alias]);
    await projection.prepare();
    expect(readFacts).toHaveBeenCalledTimes(1);
    expect(projection.membership(target.storePath, sessionKey)).toBeUndefined();
    expect(projection.membership(alias.storePath, sessionKey)).toEqual(["bob"]);
  } finally {
    projection.dispose();
  }
});

it.each(["key", "store"] as const)(
  "withholds uncertain %s membership until a fresh worker read succeeds",
  async (scope) => {
    const alias = { ...target, storePath: "/alias/sessions.json" };
    const initial = snapshot(target.identity, ["alice"]);
    const siblingKey = "agent:main:sibling";
    initial.facts.push([siblingKey, "other", ["carol"], {}, "sibling-session"]);
    readFacts.mockResolvedValueOnce(initial);
    const projection = createSessionMembershipProjection();
    projection.updateTargets([target, alias]);
    try {
      await projection.prepare();
      const stale = createDeferredCore<SessionMembershipFacts>();
      readFacts
        .mockReturnValueOnce(stale.promise)
        .mockRejectedValueOnce(new Error("reader unavailable"));
      projection.invalidate({ storePath: target.filename, sessionKey, factsInvalidated: true });
      const preparing = projection.prepare();
      projection.invalidate(
        scope === "key"
          ? { storePath: target.filename, sessionKey, factsInvalidated: true }
          : { all: true, scope: { storePath: target.filename }, factsInvalidated: true },
      );
      stale.resolve(initial);
      await expect(preparing).rejects.toThrow("reader unavailable");
      for (const storePath of [target.storePath, alias.storePath, target.filename]) {
        expect(projection.membership(storePath, sessionKey)).toEqual([]);
        expect(projection.ready(storePath, sessionKey)).toBe(false);
        expect(projection.membership(storePath, siblingKey)).toEqual(
          scope === "key" ? ["carol"] : [],
        );
      }
      readFacts.mockResolvedValueOnce(snapshot(target.identity, ["bob"]));
      await projection.prepare();
      expect(projection.membership(alias.storePath, sessionKey)).toEqual(["bob"]);
      expect(projection.ready(alias.storePath, sessionKey)).toBe(true);
    } finally {
      projection.dispose();
    }
  },
);
