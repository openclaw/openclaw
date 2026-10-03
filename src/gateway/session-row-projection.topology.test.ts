import { symlinkSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { applyOpenClawDatabaseVerificationResults } from "../state/openclaw-database-verify.impl.js";
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

afterEach(() => vi.restoreAllMocks());

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
        expect.objectContaining({ sessionKey: query.key, reason: "reactivated" }),
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
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, marker, "Marker membership did not prepare"),
        signal,
      );
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
      expect(
        broadcastToConnIds.mock.calls.filter(([name]) => name === "session.message"),
      ).toHaveLength(2);
    } finally {
      release.resolve();
      await Promise.allSettled(tasks);
      await settled;
      projection.dispose();
    }
  });
});

it.for(
  (["lifecycle", "marker"] as const).flatMap((kind) =>
    (
      [
        "unchanged",
        "replace",
        "same-id-reset",
        "delete",
        "physical-store",
        "dispose",
        "unrelated-store",
        "new-store-registration",
        "alias-reset",
      ] as const
    ).map((change) => ({ kind, change })),
  ),
)(
  "keeps an unknown $kind event with its original generation across $change",
  async ({ kind, change }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const unrelated =
        change === "unrelated-store"
          ? {
              agentId: "main",
              sessionKey: "agent:main:unrelated",
              storePath: path.join(state.root, "unrelated.sqlite"),
            }
          : undefined;
      if (unrelated) {
        replaceSessionEntrySync(unrelated, {
          sessionId: "event-original",
          lifecycleRevision: "unrelated-original",
          updatedAt: 1,
        });
      }
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
      const entry = { sessionId: "event-original", lifecycleRevision: "original", updatedAt: 1 };
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
              reason: "reactivated",
            })
          : createTranscriptUpdateBroadcastHandler(params)({
              sessionFile: formatSqliteSessionFileMarker({ ...scope, sessionId: entry.sessionId }),
              message: { role: "assistant", content: [{ type: "text", text: "Original event" }] },
              messageSeq: 1,
            });
      const settled = Promise.allSettled([pending]);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Event did not await original topology",
          ),
          signal,
        );
        if (change === "replace" || change === "same-id-reset") {
          const next = {
            ...entry,
            sessionId: change === "replace" ? "event-replacement" : entry.sessionId,
            lifecycleRevision: "replacement",
            updatedAt: 2,
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
        } else if (change === "physical-store") {
          const target = resolveSqliteTargetFromSessionStorePath(storePath, {
            agentId: query.agentId,
          });
          await closeOpenClawAgentDatabaseByPathAsync(target.path, target.agentId);
          await rename(target.path, `${target.path}.original`);
          await copyFile(`${target.path}.original`, target.path);
        } else if (change === "dispose") {
          projection.dispose();
        } else if (change === "new-store-registration") {
          openOpenClawAgentDatabase({
            agentId: query.agentId,
            path: path.join(state.root, "newly-registered.sqlite"),
            env: state.env,
          });
        } else if (unrelated) {
          replaceSessionEntrySync(unrelated, {
            sessionId: entry.sessionId,
            lifecycleRevision: "unrelated-reset",
            updatedAt: 2,
          });
        } else if (change === "alias-reset") {
          expect(alias).toBeDefined();
          replaceSessionEntrySync(
            { ...scope, storePath: alias },
            {
              ...entry,
              lifecycleRevision: "alias-reset",
              updatedAt: 2,
            },
          );
        }
        release.resolve();
        const result = await settled;
        if (change === "unchanged" || change === "new-store-registration" || unrelated) {
          expect(result).toEqual([{ status: "fulfilled", value: undefined }]);
          expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
          expect(broadcastToConnIds.mock.calls[0]?.[0]).toBe(
            kind === "lifecycle" ? "sessions.changed" : "session.message",
          );
          expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ sessionKey: query.key });
        } else {
          expect(broadcastToConnIds).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await settled;
        projection.dispose();
      }
    });
  },
);

it.for(["identity scopes", "dispose", "source"] as const)(
  "does not publish a topology snapshot after its %s changes while reading",
  async (change, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let cfg: OpenClawConfig = {
        agents: { entries: { main: { identity: { name: "Original" } } } },
      };
      const query = { agentId: "main", key: "agent:main:topology" };
      replaceSessionEntrySync(
        { agentId: query.agentId, sessionKey: query.key },
        { sessionId: "topology", updatedAt: 1 },
      );
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        getConfig: () => cfg,
        modelCatalog: [],
      });
      const { entered, release } = holdTopologyRead();
      const captured = projection.capture(query);
      sessionChanges.emit({ all: true, scope: "stores" });
      const pending = projection.prepareMembership();
      const settled = Promise.allSettled([pending]);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Topology snapshot did not reach its owner",
          ),
          signal,
        );
        expect(projection.capture(query)).toBe(captured);
        if (change === "identity scopes") {
          cfg = {
            ...cfg,
            gateway: { auth: { identityScopes: { "reader@example.test": ["operator.read"] } } },
          };
          sessionChanges.emit({ all: true, scope: "config" });
        } else if (change === "dispose") {
          projection.dispose();
        } else {
          const database = openOpenClawStateDatabase({ env: state.env });
          await closeOpenClawStateDatabaseByPathAsync(database.path);
          const replacement = `${database.path}.replacement`;
          await copyFile(database.path, replacement);
          await rename(replacement, database.path);
          openOpenClawStateDatabase({ env: state.env });
        }
        release.resolve();
        if (change === "source") {
          expect(await settled).toEqual([{ status: "rejected", reason: expect.any(Error) }]);
          await expect(projection.prepareMembership()).rejects.toThrow();
          const successor = await createSessionRowProjection({ cfg, modelCatalog: [] });
          try {
            await successor.prepareMembership();
            expect(successor.selectEntries(query).map((row) => row.entry.sessionId)).toEqual([
              "topology",
            ]);
          } finally {
            successor.dispose();
          }
        } else {
          expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
          if (change === "identity scopes") {
            expect(projection.state.cfg).toBe(cfg);
            expect(projection.selectEntries().map((row) => row.entry.sessionId)).toEqual([
              "topology",
            ]);
          } else {
            expect(projection.capture(query)).toBeUndefined();
            expect(projection.selectEntries()).toEqual([]);
          }
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
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Request did not await topology readiness",
          ),
          signal,
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

it("starts a new topology read after healthy integrity confirmation without reviving its old reply", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const query = { agentId: "main", key: "agent:main:verified-topology" };
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key },
      {
        sessionId: "verified-topology",
        updatedAt: 1,
      },
    );
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const database = openOpenClawStateDatabase({ env: state.env });
    const { entered, release } = holdTopologyRead();
    sessionChanges.emit({ all: true, scope: "stores" });
    const pending = projection.prepareMembership();
    const settled = Promise.allSettled([pending]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Topology snapshot did not reach its owner",
        ),
        signal,
      );
      await applyOpenClawDatabaseVerificationResults({
        env: state.env,
        targets: [
          {
            kind: "state",
            label: "OpenClaw state database",
            path: database.path,
            check: "quick",
          },
        ],
        results: [
          { path: database.path, ok: false, error: "stale terminal result", terminal: true },
        ],
      });
      expect(database.db.isOpen).toBe(false);
      release.resolve();
      expect(await settled).toEqual([{ status: "rejected", reason: expect.any(Error) }]);
      await expect(projection.prepareMembership()).resolves.toBeUndefined();
      expect(projection.selectEntries(query).map((row) => row.entry.sessionId)).toEqual([
        "verified-topology",
      ]);
    } finally {
      release.resolve();
      await settled;
      projection.dispose();
      releaseForeground();
    }
  });
});

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
      expect(projection.selectEntries().filter(ready).length).toBe(2);
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath: secondary }).row
          ?.sessionId,
      ).toBe("secondary");
      const selected = projection.describe({ agentId: "main", key: "global" })!;
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
