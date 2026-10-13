import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

afterEach(() => {
  readFacts.mockReset();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
const directories = useAutoCleanupTempDirTracker(afterEach);

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

it.each([false, true])(
  "publishes after a delayed reader on Linux without statx only for the admitted file (replaced=%s)",
  async (replaced) => {
    // Evaluate the real identity owner's process-stable Linux policy on every test host.
    vi.resetModules();
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      await import("../infra/sqlite-worker-identity.js");
    } finally {
      platform.mockRestore();
    }
    const { registerOpenClawAgentDatabaseIdentity, readOpenClawAgentDatabaseIdentity } =
      await import("../state/openclaw-agent-db-identity.js");
    const { readSessionMembershipFactsInDatabase } =
      await import("../config/sessions/session-membership-facts.js");
    const directory = directories.make("membership-no-statx-");
    const filename = path.join(directory, "agent.sqlite");
    using admitted = new DatabaseSync(filename);
    admitted.exec("CREATE TABLE payload(value TEXT)");
    const stat = fs.statSync;
    let metadataRevision = 0n;
    vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      if (!args[1]?.bigint || String(args[0]) !== filename) {
        return stat(...args);
      }
      const file =
        args[1].throwIfNoEntry === false
          ? stat(args[0], { bigint: true, throwIfNoEntry: false })
          : stat(args[0], { bigint: true });
      if (file) {
        file.ctimeNs += metadataRevision;
        file.birthtimeNs = file.ctimeNs;
      }
      return file;
    });
    syncBuiltinESMExports();
    registerOpenClawAgentDatabaseIdentity(admitted);
    const original = readOpenClawAgentDatabaseIdentity({ db: admitted });
    const before = fs.statSync(filename, { bigint: true });
    const pendingRead = createDeferredCore();
    readFacts.mockImplementationOnce(async () => {
      await pendingRead.promise;
      using reader = new DatabaseSync(filename, { readOnly: true });
      registerOpenClawAgentDatabaseIdentity(reader);
      return readSessionMembershipFactsInDatabase({ agentId: "main", db: reader }, []);
    });
    const projection = createSessionMembershipProjection({
      env: { OPENCLAW_STATE_DIR: directory },
    });
    projection.updateTargets([{ ...target, ...original, storePath: filename, filename }]);
    const prepared = projection.prepare();
    try {
      // Hold the reader across the write/link retirement window that reclamation can open.
      admitted.exec("INSERT INTO payload VALUES ('retained')");
      admitted.close();
      const link = path.join(directory, "retained.sqlite");
      fs.linkSync(filename, link);
      if (replaced) {
        fs.unlinkSync(filename);
        using replacement = new DatabaseSync(filename);
        replacement.exec("CREATE TABLE payload(value TEXT)");
      }
      fs.unlinkSync(link);
      metadataRevision = 1_000_000_000n;
      const after = fs.statSync(filename, { bigint: true });
      expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
      expect(after.dev).toBe(before.dev);
      expect(after.ino === before.ino).toBe(!replaced);
      pendingRead.resolve();
      if (replaced) {
        await expect(prepared).rejects.toThrow(
          "Session membership store changed before publication",
        );
      } else {
        await prepared;
        expect(projection.ready(filename, sessionKey)).toBe(true);
        expect(projection.membership(filename, sessionKey)).toEqual([]);
      }
    } finally {
      pendingRead.resolve();
      projection.dispose();
      await Promise.allSettled([prepared]);
      vi.resetModules();
    }
  },
);

it.each(["member revocation", "owner reassignment"] as const)(
  "coalesces viewer preparation without replaying stale membership after %s",
  async (change) => {
    const deferred = createDeferredCore<SessionMembershipFacts>();
    readFacts.mockReturnValueOnce(deferred.promise);
    if (change === "member revocation") {
      readFacts.mockResolvedValueOnce(snapshot(target.identity, []));
    }
    const projection = createSessionMembershipProjection();
    projection.updateTargets([target]);
    try {
      const viewers = Array.from({ length: 50 }, () => projection.prepare());
      projection.invalidate({
        storePath: change === "member revocation" ? target.storePath : target.filename,
        sessionKey,
        facts:
          change === "member revocation"
            ? { kind: "member", sessionId: "shared-session", identityId: "alice", present: false }
            : {
                kind: "owner",
                sessionId: "shared-session",
                lifecycleRevision: null,
                owner: { actor: { type: "human", id: "bob" } },
              },
      });
      if (change === "member revocation") {
        expect(projection.membership(target.storePath, sessionKey)).toEqual([]);
      }
      deferred.resolve(snapshot(target.identity, ["alice"]));
      await Promise.all(viewers);
      expect(projection.membership(target.storePath, sessionKey)).toEqual(
        change === "member revocation" ? [] : ["alice"],
      );
      expect(readFacts).toHaveBeenCalledTimes(change === "member revocation" ? 2 : 1);
      if (change === "member revocation") {
        expect(projection.groupTargets().get("work")).toEqual([{ sessionKey, agentId: "main" }]);
        expect(projection.ready(target.filename, sessionKey)).toBe(true);
        projection.invalidate({
          storePath: target.filename,
          sessionKey,
          facts: { kind: "member", sessionId: "shared-session", identityId: "bob", present: true },
        });
        expect(projection.membership(target.storePath, sessionKey)).toEqual(["bob"]);
      }
      expect(projection.needsPreparation).toBe(false);
    } finally {
      projection.dispose();
    }
  },
);

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
