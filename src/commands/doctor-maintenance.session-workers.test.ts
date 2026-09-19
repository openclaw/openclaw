import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { certifySessionCanonicalValidationPending } from "../config/sessions/session-canonical-validation-readiness.js";
import {
  hasPendingCanonicalSessionValidation,
  seedCanonicalSessionValidation,
} from "../config/sessions/session-canonical-validation.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const quietRuntime = { log() {}, error() {}, exit() {} };

describe("Doctor maintenance with session workers", () => {
  it("certifies pending canonical rows under Doctor without changing them or retaining worker leases", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-canonical-worker" },
      async (state) => {
        const options = { agentId: "main", env: state.env };
        const scopes = ["first", "second"].map((name) => ({
          agentId: options.agentId,
          env: options.env,
          sessionId: `doctor-canonical-${name}`,
          sessionKey: `agent:main:doctor-canonical-${name}`,
        }));
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: quietRuntime,
        });
        try {
          await maintenance!.run(async () => {
            for (const scope of scopes) {
              await replaceSessionEntry(scope, {
                sessionId: scope.sessionId,
                updatedAt: 1,
                lastRunError: `Preserve the exact row for ${scope.sessionId}.`,
              });
            }
            const database = openOpenClawAgentDatabase(options);
            const rows = () =>
              executeSqliteQuerySync(
                database.db,
                getNodeSqliteKysely<Pick<DB, "session_nodes">>(database.db)
                  .selectFrom("session_nodes")
                  .selectAll()
                  .orderBy("session_key"),
              ).rows;
            const before = rows();
            expect(before).toHaveLength(2);
            runOpenClawAgentWriteTransaction(seedCanonicalSessionValidation, options);
            expect(hasPendingCanonicalSessionValidation(database)).toBe(true);

            await certifySessionCanonicalValidationPending(options);

            expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
            expect(rows()).toEqual(before);
          });
        } finally {
          await maintenance?.release();
        }
        const next = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: quietRuntime,
        });
        try {
          next!.run(() => {
            for (const scope of scopes) {
              expect(loadExactSessionEntryReadOnly(scope)?.entry.sessionId).toBe(scope.sessionId);
            }
          });
        } finally {
          await next?.release();
        }
      },
    );
  });

  it.each([false, true])(
    "preserves migrated history, archives deletion, and drains workers before another repair (in-place: %s)",
    async (inPlace) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-session-workers" },
        async (state) => {
          const sharedStore = inPlace ? state.statePath("shared.sqlite") : undefined;
          const cfg: OpenClawConfig = {
            agents: { entries: { ops: {} } },
            plugins: { enabled: false },
            ...(sharedStore ? { session: { store: sharedStore } } : {}),
          };
          await state.writeConfig(cfg);
          const sessionId = "doctor-migrated-history";
          const source = {
            agentId: "main",
            env: state.env,
            sessionId,
            sessionKey: "agent:main:doctor",
            storePath: sharedStore ?? path.join(state.sessionsDir("main"), "sessions.json"),
          };
          const destination = {
            ...source,
            agentId: "ops",
            sessionKey: "agent:ops:doctor",
            storePath: sharedStore ?? path.join(state.sessionsDir("ops"), "sessions.json"),
          };
          const events = [
            { type: "session", id: sessionId, version: 3 },
            {
              type: "message",
              id: "doctor-history-message",
              parentId: null,
              message: { role: "user", content: "Preserve this history through Doctor repair." },
            },
          ];
          const maintenance = await beginDoctorMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: quietRuntime,
          });
          try {
            await maintenance!.run(async () => {
              if (sharedStore) {
                openOpenClawAgentDatabase({ agentId: "main", path: sharedStore, env: state.env });
              }
              await replaceSessionEntry(source, { sessionId, updatedAt: Date.now() });
              await replaceTranscriptEvents(source, events);
              await waitForSessionTranscriptIndexReconcile({
                agentId: "main",
                env: state.env,
                ...(sharedStore ? { path: sharedStore } : {}),
              });

              await noteSessionTranscriptHealth({
                cfg,
                env: state.env,
                shouldRepair: true,
                postSessionPluginMigrationPlanBound: true,
              });
              expect(loadExactSessionEntryReadOnly(source)).toBeUndefined();
              expect(loadExactSessionEntryReadOnly(destination)?.entry.sessionId).toBe(sessionId);
              await expect(loadTranscriptEvents(destination)).resolves.toEqual(events);

              const deleted = await deleteSessionEntryLifecycle({
                agentId: destination.agentId,
                archiveTranscript: true,
                storePath: destination.storePath,
                target: {
                  canonicalKey: destination.sessionKey,
                  storeKeys: [destination.sessionKey],
                },
              });
              expect(deleted.deleted).toBe(true);
              expect(loadExactSessionEntryReadOnly(destination)).toBeUndefined();
              expect(deleted.archivedTranscripts).toHaveLength(1);
              expect(
                readSessionArchiveContentSync(deleted.archivedTranscripts[0]!.archivedPath),
              ).toBe(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
            });
          } finally {
            await maintenance?.release();
          }

          const next = await beginDoctorMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: quietRuntime,
          });
          try {
            next!.run(() => {
              expect(loadExactSessionEntryReadOnly(source)).toBeUndefined();
              expect(loadExactSessionEntryReadOnly(destination)).toBeUndefined();
            });
          } finally {
            await next?.release();
          }
        },
      );
    },
  );

  it("archives and restores exact cold history while Doctor holds maintenance ownership", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-cold-workers" },
      async (state) => {
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: quietRuntime,
        });
        let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
        try {
          fixture = await maintenance!.run(async () => {
            const seeded = await createSessionColdStorageFixture(
              path.join(state.agentDir(), "openclaw-agent.sqlite"),
            );
            const events = loadTranscriptEventsSync(seeded.scope);
            await expect(
              runSessionColdStorageMaintenance({
                config: maintenanceConfig(seeded.scope.storePath),
              }),
            ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
            expect(readSessionColdTranscript(seeded.database(), historicalId)).toBeDefined();
            expect(() => loadTranscriptEventsSync(seeded.scope)).toThrow(
              expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
            );

            await restoreSessionColdTranscript(seeded.scope);
            expect(readSessionColdTranscript(seeded.database(), historicalId)).toBeUndefined();
            expect(loadTranscriptEventsSync(seeded.scope)).toEqual(events);
            expect(seeded.snapshot()).toEqual(seeded.original);
            return seeded;
          });
        } finally {
          await maintenance?.release();
        }
        expect(fixture.snapshot()).toEqual(fixture.original);
      },
    );
  });
});
