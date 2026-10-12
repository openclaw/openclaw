import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { createSessionInitialization } from "../../sessions/session-initialization.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "settles typed reset and native reclamation without replacing a successor (%s)",
  async (successor) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const reset = {
        ...fixture.scope,
        sessionKey: "agent:main:reset-companion",
        sessionId: "reset-companion",
      };
      const entry = { sessionId: reset.sessionId, lifecycleRevision: "before", updatedAt: 1 };
      replaceSessionEntrySync(reset, entry);
      writeSessionProgressCard(fixture.database.db, reset.sessionKey, {
        markdown: "Previous task",
      });
      const next = successor
        ? { sessionId: "successor", lifecycleRevision: "successor", updatedAt: 3 }
        : { ...entry, lifecycleRevision: "after", updatedAt: 2 };
      const inject = vi.fn(() => replaceSessionEntrySync(reset, next));
      if (successor) {
        const capture = execution.captureOpenClawAgentDatabaseExecution;
        vi.spyOn(execution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
          (...args) => {
            const owner = capture(...args);
            return {
              ...owner,
              get fileIdentity() {
                return owner.fileIdentity;
              },
              runExisting: (source, operation, options) =>
                owner.runExisting(
                  source,
                  (worker) =>
                    operation({
                      execute: async (command, commandOptions) => {
                        const result = await worker.execute(command, commandOptions);
                        if (command.type === "session.nativeBindings.delete") {
                          inject();
                        }
                        return result;
                      },
                    }),
                  options,
                ),
            };
          },
        );
      }
      let committed = false;
      const notifications: boolean[] = [];
      const resetIdentities: string[] = [];
      const stopIdentity = onSessionIdentityMutation((change) => {
        if (change.kind === "reset" && change.current.sessionKeys.includes(reset.sessionKey)) {
          resetIdentities.push(change.kind);
        }
      });
      const stop = onSessionLifecycleEvent((event) => {
        if (event.sessionKey === reset.sessionKey && event.reason === "progress-card-reset") {
          notifications.push(committed);
        }
      });
      const sql = successor ? undefined : observeHostDataSql();
      try {
        await expect(
          withPluginRuntimeRegistryScope(fixture.registry, () =>
            applySessionEntryLifecycleMutation({
              agentId: fixture.scope.agentId,
              env: fixture.scope.env,
              storePath: fixture.scope.storePath,
              skipMaintenance: true,
              removals: [{ sessionKey: fixture.scope.sessionKey }],
              upserts: [
                {
                  sessionKey: reset.sessionKey,
                  entry: { ...entry, lifecycleRevision: "after", updatedAt: 2 },
                  resetBoundary: { context: "clear", reason: "reset", cwd: "/synthetic/workspace" },
                },
              ],
              onLifecycleCommitted: () => {
                committed = true;
              },
            }),
          ),
        ).resolves.toMatchObject({ removedSessionKeys: [fixture.scope.sessionKey] });
        if (sql) {
          expect(
            sql.queries.filter((query) =>
              /\b(?:session_nodes|session_windows|transcript_events|session_progress_cards)\b/i.test(
                query,
              ),
            ),
          ).toEqual([]);
        }
      } finally {
        sql?.restore();
        stop();
        stopIdentity();
      }
      expect(fixture.readEntry()).toBeUndefined();
      expect(fixture.readBinding()).toBeUndefined();
      expect(readExactSessionEntryRow(fixture.database, reset.sessionKey)?.entry).toMatchObject(
        next,
      );
      expect(inject).toHaveBeenCalledTimes(successor ? 1 : 0);
      expect(resetIdentities).toEqual(successor ? [] : ["reset"]);
      const reader = new DatabaseSync(fixture.database.path, { readOnly: true });
      try {
        expect(readSessionProgressCard(reader, reset.sessionKey)).toBeNull();
      } finally {
        reader.close();
      }
      expect(notifications).toEqual([true]);
    });
  },
);

it("reclaims lifecycle artifacts with the native veto off the caller thread", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const published = vi.fn();
    const stop = onSessionIdentityMutation((change) => {
      if (change.previous.sessionKeys.includes(fixture.scope.sessionKey)) {
        published(change.kind);
      }
    });
    let granted = false;
    probe.admission(admission, (request, grant, callback) => {
      const facts = isRecord(request.facts) ? request.facts.publication : undefined;
      if (
        request.stage === "commit" &&
        isRecord(facts) &&
        facts.kind === "session-native-binding"
      ) {
        granted = true;
      }
      callback(request, grant);
    });
    const sql = observeHostDataSql();
    try {
      await expect(fixture.cleanup()).resolves.toMatchObject({ removedEntries: 1 });
      expect(granted).toBe(true);
      // Other-owner live authority reads remain outside the moved A transaction.
      expect(
        sql.queries.filter((query) =>
          /\b(?:session_nodes|session_windows|transcript_events)\b/i.test(query),
        ),
      ).toEqual([]);
      expect(
        sql.queries.filter((query) =>
          /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(
            query,
          ),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
      stop();
    }
    expect(fixture.readEntry()).toEqual(undefined);
    expect(fixture.readBinding()).toEqual(undefined);
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual([]);
    expect(published.mock.calls).toEqual([["delete"]]);
  });
});

it.each([false, true])(
  "settles maintenance participants only for rows actually reclaimed (changed: %s)",
  async (changed) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const before = fixture.readEntry();
      assert(before);
      const binding = fixture.readBinding();
      const successor = { ...before, label: "updated after maintenance planning" };
      if (changed) {
        replaceSessionEntrySync(fixture.scope, successor);
      }
      const sql = observeHostDataSql();
      try {
        await expect(fixture.maintain(before)).resolves.toMatchObject({ pruned: changed ? 0 : 1 });
        expect(
          sql.queries.filter((query) =>
            /\b(?:session_nodes|session_windows|transcript_events)\b/i.test(query),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(fixture.readEntry()).toEqual(changed ? successor : undefined);
      expect(fixture.readBinding()).toEqual(changed ? binding : undefined);
    });
  },
);

it.each([false, true])(
  "retains rollback authority without a same-database grant reread (binding: %s)",
  async (withBinding) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      if (!withBinding) {
        fixture.registry.agentHarnesses.length = 0;
      }
      const entry = fixture.readEntry();
      assert(entry);
      let grantDatabasePath: string | undefined;
      let agentGrants = 0;
      let authorityReads = 0;
      let otherOwnerAuthorityReads = 0;
      let revoked = true;
      const refusal = new Error("synthetic rollback authority revoked");
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) => {
          let databasePath: string | undefined;
          const owned = create((request, grant) => {
            const previous = grantDatabasePath;
            const identity = isRecord(request.facts) ? request.facts.identity : undefined;
            grantDatabasePath =
              isRecord(identity) && typeof identity.nativeLocation === "string"
                ? identity.nativeLocation
                : databasePath;
            if (grantDatabasePath === fixture.database.path) {
              agentGrants++;
            }
            try {
              callback(request, grant);
            } finally {
              grantDatabasePath = previous;
            }
          }, attachment);
          const bind = owned.bindDatabaseAuthority.bind(owned);
          owned.bindDatabaseAuthority = (authority) => {
            databasePath = authority.databasePath;
            bind(authority);
          };
          return owned;
        },
      );
      const initializer = createSessionInitialization(
        { ...fixture.scope, lifecycleRevision: entry.lifecycleRevision },
        () => {
          expect(grantDatabasePath).not.toBe(fixture.database.path);
          fixture.readEntry();
          authorityReads++;
          if (grantDatabasePath === fixture.shared.path) {
            otherOwnerAuthorityReads++;
          }
          if (revoked) {
            throw refusal;
          }
        },
        { config: {}, agentId: fixture.scope.agentId, entry },
      );
      try {
        await expect(initializer.rollback(() => fixture.remove())).rejects.toBe(refusal);
        expect(fixture.readEntry()).toEqual(entry);
        expect(fixture.readBinding()).toBeDefined();
        revoked = false;
        await expect(initializer.rollback(() => fixture.remove())).resolves.toMatchObject({
          deleted: true,
        });
        expect(authorityReads).toBeGreaterThan(0);
        expect(agentGrants).toBeGreaterThan(0);
        expect(fixture.readEntry()).toBeUndefined();
        expect(() => initializer.handle.assertCurrent()).toThrow(
          "Session initialization is rolling back",
        );
        if (withBinding) {
          expect(fixture.readBinding()).toBeUndefined();
          expect(otherOwnerAuthorityReads).toBeGreaterThan(0);
        } else {
          expect(fixture.readBinding()).toBeDefined();
        }
      } finally {
        initializer.close();
      }
    });
  },
);
