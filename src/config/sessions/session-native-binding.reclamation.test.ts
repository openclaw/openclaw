import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
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
      expect(readSessionProgressCard(fixture.database.path, reset.sessionKey)).toBeNull();
      expect(notifications).toEqual([true]);
    });
  },
);

it.each([false, true])(
  "reclaims lifecycle artifacts with the native veto off the caller thread (rollback: %s)",
  async (rollback) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const before = fixture.readEntry();
      const binding = fixture.readBinding();
      const history = loadTranscriptEventsSync(fixture.scope);
      const refusal = new Error("synthetic reclamation commit refusal");
      const published = vi.fn();
      const stop = onSessionIdentityMutation((change) => {
        if (change.previous.sessionKeys.includes(fixture.scope.sessionKey)) {
          published(change.kind);
        }
      });
      let granted = false;
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            const facts = isRecord(request.facts) ? request.facts.publication : undefined;
            if (
              request.stage === "commit" &&
              isRecord(facts) &&
              facts.kind === "session-native-binding"
            ) {
              granted = true;
              if (rollback) {
                throw refusal;
              }
            }
            callback(request, grant);
          }, attachment),
      );
      const sql = observeHostDataSql();
      try {
        if (rollback) {
          await expect(fixture.cleanup()).rejects.toBe(refusal);
        } else {
          await expect(fixture.cleanup()).resolves.toMatchObject({ removedEntries: 1 });
        }
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
      expect(fixture.readEntry()).toEqual(rollback ? before : undefined);
      expect(fixture.readBinding()).toEqual(rollback ? binding : undefined);
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(rollback ? history : []);
      expect(published.mock.calls).toEqual(rollback ? [] : [["delete"]]);
    });
  },
);

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
