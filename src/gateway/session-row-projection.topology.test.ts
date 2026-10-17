import { symlinkSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { seedRow, waitForRead } from "./session-row-projection.read-fixture.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.for(["publication", "source", "dispose"] as const)(
  "fences cold store admission across a delayed worker reply: %s",
  async (change, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, late: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      let held = false;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (targets, consume, lane) =>
          readDatabases(
            targets,
            (owners) =>
              consume(
                owners.map((owner) => ({
                  ...owner,
                  async readStoreProjection(input) {
                    const result = await owner.readStoreProjection(input);
                    if (!held) {
                      held = true;
                      entered.resolve();
                      await release.promise;
                    }
                    return result;
                  },
                })),
              ),
            lane,
          ),
      );
      const scope = { agentId: "late", sessionKey: "agent:late:admission" };
      replaceSessionEntrySync(scope, { sessionId: "admission", updatedAt: 1, label: "Original" });
      const reading = projection.prepareMembership();
      const settled = Promise.allSettled([reading]);
      try {
        await waitForRead(
          entered.promise,
          reading,
          signal,
          "Cold admission bypassed the worker read",
        );
        const query = { agentId: scope.agentId, key: scope.sessionKey };
        expect(projection.capture(query)).toBeUndefined();
        if (change === "publication") {
          replaceSessionEntrySync(scope, {
            sessionId: "admission",
            updatedAt: 2,
            label: "Current",
          });
          replaceSessionEntrySync(
            { ...scope, sessionKey: "agent:late:created-during-admission" },
            { sessionId: "created-during-admission", updatedAt: 2 },
          );
        } else if (change === "source") {
          const pathname = resolveOpenClawAgentSqlitePath({ ...scope, env: state.env });
          const replacement = `${pathname}.replacement`;
          await copyFile(pathname, replacement);
          await rename(replacement, pathname);
        } else {
          projection.dispose();
        }
        release.resolve();
        if (change === "source") {
          await expect(reading).rejects.toThrow(/identity changed/);
          expect(projection.capture(query)).toBeUndefined();
        } else {
          await reading;
          if (change === "publication") {
            await projection.ensureMaterialized();
            expect(projection.snapshot(query).row?.label).toBe("Current");
            expect(
              projection.capture({ agentId: "late", key: "agent:late:created-during-admission" }),
            ).toBeDefined();
          } else {
            expect(projection.capture(query)).toBeUndefined();
          }
        }
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
      }
    });
  },
);

it("reconciles a resident reset while a topology store snapshot awaits its worker", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:topology-reset",
      storePath: database.path,
    };
    const entry = { sessionId: "topology-reset", updatedAt: 1, label: "Retained" };
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const readDatabases = history.withSessionHistoryWorkerDatabases;
    let held = false;
    vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
      (targets, consume, lane) =>
        readDatabases(
          targets,
          async (owners) => {
            if (!held) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return consume(owners);
          },
          lane,
        ),
    );
    sessionChanges.emit({ all: true, scope: "stores" });
    const pending = projection.prepareMembership();
    const settled = Promise.allSettled([pending]);
    try {
      await waitForRead(entered.promise, pending, signal, "Topology bypassed its store worker");
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      const captured = projection.capture(query);
      emitSessionIdentityMutation({
        kind: "reset",
        agentId: scope.agentId,
        databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
        previous: { sessionId: entry.sessionId, sessionKeys: [scope.sessionKey] },
        current: { sessionId: entry.sessionId, sessionKeys: [scope.sessionKey] },
      });
      expect(projection.capture(query)?.entry).toBeUndefined();
      expect(projection.isCurrent(captured!)).toBe(false);
      release.resolve();
      await pending;
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row).toMatchObject({
        sessionId: entry.sessionId,
        label: entry.label,
      });
    } finally {
      release.resolve();
      await settled;
      projection.dispose();
    }
  });
});

function holdTopologyRead() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const originalRead = stateReads.executeExistingOpenClawStateRead;
  let held = false;
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
    const reply = await originalRead(...args);
    if (args[1].type === "agentDatabaseDeletion.snapshot" && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  return { entered, release };
}

it("publishes an initially unseen retired-agent event from its default store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: path.join(state.root, "configured", "{agentId}", "sessions.json") },
    };
    setRuntimeConfigSnapshot(cfg);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const query = { agentId: "retired", key: "agent:retired:original" };
    const storePath = resolveSessionStorePathCore(undefined, {
      agentId: query.agentId,
      env: state.env,
    });
    try {
      replaceSessionEntrySync(
        { agentId: query.agentId, sessionKey: query.key, storePath },
        { sessionId: "retired-original", updatedAt: 1 },
      );
      sessionChanges.emit({ all: true, scope: "stores" });
      expect(projection.capture(query)).toBeUndefined();
      const broadcastToConnIds = vi.fn();
      await createLifecycleEventBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["subscriber"]) },
        chatAbortControllers: new Map(),
        getSessionRowProjection: () => projection,
      })({ agentId: query.agentId, sessionKey: query.key, reason: "reactivated" });
      expect(projection.selectEntries(query).map((row) => row.entry.sessionId)).toEqual([
        "retired-original",
      ]);
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: query.key,
          reason: "updated",
          session: expect.objectContaining({ sessionId: "retired-original" }),
        }),
        new Set(["subscriber"]),
        expect.anything(),
      );
    } finally {
      projection.dispose();
    }
  });
});

it("admits a committed update without host SQL while a marker awaits prepared membership", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, late: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const known = { agentId: "main", sessionKey: "agent:main:known" };
    const knownEntry = { sessionId: "known", lifecycleRevision: "known-original", updatedAt: 1 };
    replaceSessionEntrySync(known, knownEntry);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepareMembership = projection.prepareMembership.bind(projection);
    vi.spyOn(projection, "prepareMembership").mockImplementation(async () => {
      await prepareMembership();
      entered.resolve();
      await release.promise;
    });
    const markerScope = {
      agentId: "late",
      sessionKey: "agent:late:marker",
      sessionId: "marker",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "late", env: state.env }),
    };
    replaceSessionEntrySync(markerScope, { sessionId: markerScope.sessionId, updatedAt: 1 });
    sessionChanges.emit({ all: true, scope: "stores" });
    expect(projection.findBySessionId(markerScope)).toEqual([]);
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["subscriber"]) },
      sessionMessageSubscribers: { get: () => new Set<string>() },
      chatAbortControllers: new Map(),
      getSessionRowProjection: () => projection,
    });
    const marker = handler({
      sessionFile: formatSqliteSessionFileMarker(markerScope),
      message: { role: "assistant", content: "marker" },
      messageSeq: 1,
    });
    const tasks = [marker];
    const settled = Promise.allSettled(tasks);
    try {
      // Bind waits to the test signal so a stall still releases held topology work below.
      await waitForRead(entered.promise, marker, signal, "Marker membership did not prepare");
      expect(projection.needsMembershipPreparation()).toBe(false);
      sessionChanges.emit({ all: true, scope: "catalog" });
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      const sql = observeHostDataSql();
      try {
        tasks.push(
          handler({
            target: {
              ...known,
              sessionId: knownEntry.sessionId,
              storePath: resolveSessionStorePathCore(undefined, {
                agentId: known.agentId,
                env: state.env,
              }),
            },
            lifecycleRevision: knownEntry.lifecycleRevision,
            message: { role: "assistant", content: "committed" },
            messageSeq: 1,
          }),
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      release.resolve();
      await Promise.all(tasks);
      expect(broadcastToConnIds.mock.calls).toHaveLength(2);
      expect(
        broadcastToConnIds.mock.calls
          .filter(([name]) => name === "session.message")
          .map(([, payload]) => payload.sessionKey),
      ).toEqual(["agent:main:known"]);
      const markerNotice = broadcastToConnIds.mock.calls.find(
        ([name, payload]) =>
          name === "sessions.changed" && payload.sessionKey === "agent:late:marker",
      );
      expect(markerNotice?.[1]).toMatchObject({ sessionId: "marker", phase: "message" });
      expect(markerNotice?.[1]).not.toHaveProperty("message");
      expect(markerNotice?.[3]).toMatchObject({ prepareSessionProjection: expect.any(Function) });
    } finally {
      release.resolve();
      await Promise.allSettled(tasks);
      await settled;
      projection.dispose();
    }
  });
});

it.for([
  { kind: "lifecycle", change: "same-id-reset" },
  { kind: "lifecycle", change: "delete" },
  { kind: "lifecycle", change: "dispose" },
  { kind: "marker", change: "same-id-reset" },
  { kind: "marker", change: "dispose" },
  { kind: "marker", change: "alias-reset" },
] as const)(
  "refreshes current facts without retargeting unknown $kind payloads across $change",
  async ({ kind, change }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const projection = await createSessionRowProjection({
        cfg,
        getConfig: () => cfg,
        modelCatalog: [],
      });
      const { entered, release } = holdTopologyRead();
      const storePath = path.join(state.root, "deferred-events.sqlite");
      cfg = { ...cfg, session: { store: storePath } };
      setRuntimeConfigSnapshot(cfg);
      const query = { agentId: "main", key: "agent:main:deferred-event" };
      const scope = { agentId: query.agentId, sessionKey: query.key, storePath };
      const entry = {
        sessionId: "event-original",
        lifecycleRevision: "original",
        updatedAt: 1,
        label: "Current row",
      };
      replaceSessionEntrySync(scope, entry);
      let alias: string | undefined;
      if (change === "alias-reset") {
        const target = resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: query.agentId,
        });
        const aliasDirectory = path.join(state.root, "source-alias");
        symlinkSync(
          path.dirname(target.path),
          aliasDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
        alias = path.join(aliasDirectory, path.basename(target.path));
        openOpenClawAgentDatabase({ agentId: query.agentId, path: alias });
      }
      sessionChanges.emit({ all: true, scope: "config" });
      expect(projection.capture(query)).toBeUndefined();
      const broadcastToConnIds = vi.fn();
      const params = {
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["subscriber"]) },
        sessionMessageSubscribers: { get: () => new Set<string>() },
        chatAbortControllers: new Map(),
        getSessionRowProjection: () => projection,
      };
      const pending =
        kind === "lifecycle"
          ? createLifecycleEventBroadcastHandler(params)({
              sessionKey: query.key,
              agentId: query.agentId,
              reason: "swarm-note",
              swarmGroupId: "old-swarm",
              kind: "log",
              text: "Original private note",
              label: "Old event label",
              displayName: "Old event display",
              parentSessionKey: "agent:main:old-parent",
            })
          : createTranscriptUpdateBroadcastHandler(params)({
              sessionFile: formatSqliteSessionFileMarker({ ...scope, sessionId: entry.sessionId }),
              message: { role: "assistant", content: [{ type: "text", text: "Original event" }] },
              messageSeq: 1,
            });
      const settled = Promise.allSettled([pending]);
      try {
        await waitForRead(
          entered.promise,
          pending,
          signal,
          "Event did not await original topology",
        );
        if (change === "same-id-reset") {
          const next = {
            ...entry,
            sessionId: entry.sessionId,
            lifecycleRevision: "replacement",
            updatedAt: 2,
            label: "Replacement row",
          };
          replaceSessionEntrySync(scope, next);
          expect(loadSessionEntry(scope)).toMatchObject(next);
        } else if (change === "delete") {
          await deleteSessionEntryLifecycle({
            agentId: query.agentId,
            storePath,
            archiveTranscript: false,
            target: { canonicalKey: query.key, storeKeys: [query.key] },
          });
          expect(loadSessionEntry(scope)).toBeUndefined();
        } else if (change === "dispose") {
          projection.dispose();
        } else if (change === "alias-reset") {
          expect(alias).toBeDefined();
          replaceSessionEntrySync(
            { ...scope, storePath: alias },
            {
              ...entry,
              lifecycleRevision: "alias-reset",
              updatedAt: 2,
              label: "Replacement row",
            },
          );
        }
        release.resolve();
        if (change === "dispose" || change === "delete") {
          await settled;
          expect(broadcastToConnIds).not.toHaveBeenCalled();
        } else {
          await pending;
          expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            expect.objectContaining({
              sessionKey: query.key,
              sessionId: "event-original",
              label: "Replacement row",
              session: expect.objectContaining({
                lifecycleRevision: change === "alias-reset" ? "alias-reset" : "replacement",
              }),
              ...(kind === "lifecycle" ? { reason: "updated" } : { phase: "message" }),
            }),
            new Set(["subscriber"]),
            expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
          );
          const payload = broadcastToConnIds.mock.calls[0]?.[1];
          expect(payload).not.toHaveProperty("message");
          expect(JSON.stringify(payload)).not.toContain('"swarmGroupId":');
          expect(payload).not.toHaveProperty("text");
          expect(payload.displayName).not.toBe("Old event display");
          expect(payload.parentSessionKey).not.toBe("agent:main:old-parent");
        }
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
      }
    });
  },
);

it.for(["dispose", "source", "owner close"] as const)(
  "does not publish a topology snapshot after its %s changes while reading",
  async (change, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { identity: { name: "Original" } } } },
      };
      const query = { agentId: "main", key: "agent:main:topology" };
      seedRow(query, { sessionId: "topology", updatedAt: 1 });
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        getConfig: () => cfg,
        modelCatalog: [],
      });
      const verifiedDatabase =
        change === "owner close" ? openOpenClawStateDatabase({ env: state.env }) : undefined;
      const { entered, release } = holdTopologyRead();
      const captured = projection.capture(query);
      sessionChanges.emit({ all: true, scope: "stores" });
      const pending = projection.prepareMembership();
      const settled = Promise.allSettled([pending]);
      try {
        await waitForRead(
          entered.promise,
          pending,
          signal,
          "Topology snapshot did not reach its owner",
        );
        expect(projection.capture(query)).toBe(captured);
        if (change === "dispose") {
          projection.dispose();
        } else if (change === "owner close") {
          await closeOpenClawStateDatabaseByPathAsync(verifiedDatabase!.path);
          expect(verifiedDatabase!.db.isOpen).toBe(false);
        } else {
          const database = openOpenClawStateDatabase({ env: state.env });
          await closeOpenClawStateDatabaseByPathAsync(database.path);
          const replacement = `${database.path}.replacement`;
          await copyFile(database.path, replacement);
          await rename(replacement, database.path);
          openOpenClawStateDatabase({ env: state.env });
        }
        release.resolve();
        if (change === "source" || change === "owner close") {
          expect(await settled).toEqual([{ status: "rejected", reason: expect.any(Error) }]);
          if (change === "owner close") {
            await expect(projection.prepareMembership()).resolves.toBeUndefined();
            await projection.prepareSelection();
            expect(projection.selectEntries(query).map((row) => row.entry.sessionId)).toEqual([
              "topology",
            ]);
          } else {
            await expect(projection.prepareMembership()).rejects.toThrow();
            const successor = await createSessionRowProjection({ cfg, modelCatalog: [] });
            try {
              await successor.prepareMembership();
              await successor.prepareSelection();
              expect(successor.selectEntries(query).map((row) => row.entry.sessionId)).toEqual([
                "topology",
              ]);
            } finally {
              successor.dispose();
            }
          }
        } else {
          expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
          expect(projection.capture(query)).toBeUndefined();
          expect(projection.selectEntries()).toEqual([]);
        }
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
        releaseForeground();
      }
    });
  },
);

it.for(["chat.startup", "sessions.resolve"] as const)(
  "revalidates request authority after %s topology readiness",
  async (method, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const { entered, release } = holdTopologyRead();
      const releaseForeground = retainSessionListForegroundWork();
      sessionChanges.emit({ all: true, scope: "stores" });
      const respond = vi.fn();
      const revoked = new Error("Original request authority ended");
      let active = true;
      const handler =
        method === "chat.startup" ? chatHistoryHandlers[method]! : sessionReadHandlers[method]!;
      const pending = Promise.resolve(
        handler({
          req: { type: "req", id: "topology-authority", method },
          params:
            method === "chat.startup"
              ? { shortId: "87654321", agentId: "main" }
              : { key: "agent:main:missing" },
          client: null,
          context,
          respond,
          isWebchatConnect: () => false,
          sessionMutationAuthorization: {
            assertCurrent() {
              if (!active) {
                throw revoked;
              }
            },
            assertTargetCurrent() {},
          },
        }),
      );
      const settled = Promise.allSettled([pending]);
      try {
        await waitForRead(
          entered.promise,
          pending,
          signal,
          "Request did not await topology readiness",
        );
        active = false;
        release.resolve();
        expect(await settled).toEqual([{ status: "rejected", reason: revoked }]);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
        releaseForeground();
      }
    });
  },
);

it("retains physical sentinels and stable store precedence after a primary update", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { entries: { main: {} } },
      session: { scope: "global" as const },
    };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    for (const storePath of [primary, secondary]) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: "global" },
        { sessionId: storePath === primary ? "primary" : "secondary", updatedAt: Date.now() },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      projection.describe({ agentId: "main", key: "global", storePath: primary });
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath: secondary }).row
          ?.sessionId,
      ).toBe("secondary");
      const selected = projection.describe({ agentId: "main", key: "global" })!;
      expect(projection.selectEntries().filter(ready).length).toBe(2);
      expect(
        projection
          .findBySessionId({
            agentId: "main",
            sessionId: selected.entry.sessionId,
            federated: true,
          })
          .map((row) => row.key),
      ).toEqual(["global"]);
      const shadowedId = selected.entry.sessionId === "primary" ? "secondary" : "primary";
      expect(
        projection.findBySessionId({ agentId: "main", sessionId: shadowedId, federated: true }),
      ).toEqual([]);
      replaceSessionEntrySync(
        { ...selected.storeTarget, sessionKey: "global" },
        { ...selected.entry, label: "updated" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: "global" }).row?.sessionId).toBe(
        selected.entry.sessionId,
      );
      expect(projection.snapshot({ agentId: "main", key: "global" }).row?.label).toBe("updated");
      const childKey = "agent:main:qualified-child";
      replaceSessionEntrySync(
        { ...selected.storeTarget, sessionKey: childKey },
        {
          sessionId: "qualified-child",
          updatedAt: Date.now(),
          parentSessionKey: "global",
        },
      );
      await projection.ensureMaterialized();
      expect(
        projection.snapshot({
          agentId: "main",
          key: "global",
          storePath: selected.storeTarget.storePath,
        }).row?.childSessions,
      ).toEqual([childKey]);
      const otherPath = selected.storeTarget.storePath === primary ? secondary : primary;
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath: otherPath }).row
          ?.childSessions,
      ).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });
});
