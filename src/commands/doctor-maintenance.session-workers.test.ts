import path from "node:path";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { markCanonicalSessionValidationPending } from "../config/sessions/session-canonical-key.js";
import { certifySessionCanonicalValidationPending } from "../config/sessions/session-canonical-validation-readiness.js";
import { hasPendingCanonicalSessionValidation } from "../config/sessions/session-canonical-validation.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
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
import { beginDoctorRepair } from "./doctor-maintenance.admission.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const withState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
  withOpenClawTestState({ scenario: "external-service", label: "doctor-workers" }, run);
async function withMaintenance<T>(run: () => T) {
  const maintenance = await beginDoctorRepair();
  if (!maintenance) {
    throw new Error("Expected Doctor maintenance ownership");
  }
  try {
    return await maintenance.run(run);
  } finally {
    await maintenance.release();
  }
}

it("certifies pending rows without changing them or retaining worker leases", async () => {
  await withState(async (state) => {
    setRuntimeConfigSnapshot({});
    const options = { agentId: "main", env: state.env };
    const scopes = ["first", "second"].map((name) => ({
      agentId: options.agentId,
      env: options.env,
      sessionId: `doctor-canonical-${name}`,
      sessionKey: `agent:main:doctor-canonical-${name}`,
    }));
    await withMaintenance(async () => {
      for (const scope of scopes) {
        await sessions.replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          lastRunError: `Preserve ${scope.sessionId}.`,
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
      runOpenClawAgentWriteTransaction(markCanonicalSessionValidationPending, options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(true);
      await certifySessionCanonicalValidationPending(options);
      expect(hasPendingCanonicalSessionValidation(database)).toBe(false);
      expect(rows()).toEqual(before);
    });
    await withMaintenance(() => {
      for (const scope of scopes) {
        expect(sessions.loadExactSessionEntryReadOnly(scope)?.entry.sessionId).toBe(
          scope.sessionId,
        );
      }
    });
  });
});

it.each([false, true])(
  "migrates and archives history, then drains workers (in-place: %s)",
  async (inPlace) => {
    await withState(async (state) => {
      const sharedStore = inPlace ? state.statePath("shared.sqlite") : undefined;
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: {} } },
        plugins: { enabled: false },
        ...(sharedStore ? { session: { store: sharedStore } } : {}),
      };
      await state.writeConfig(cfg);
      const sessionId = "doctor-migrated-history";
      const scope = (agentId: string) => ({
        agentId,
        env: state.env,
        sessionId,
        sessionKey: `agent:${agentId}:doctor`,
        storePath: sharedStore ?? path.join(state.sessionsDir(agentId), "sessions.json"),
      });
      const source = scope("main"),
        destination = scope("ops");
      const events = [
        { type: "session", id: sessionId, version: 3 },
        {
          type: "message",
          id: "history",
          parentId: null,
          message: { role: "user", content: "Preserve this history." },
        },
      ];
      await withMaintenance(async () => {
        if (sharedStore) {
          openOpenClawAgentDatabase({ agentId: "main", path: sharedStore, env: state.env });
        }
        await sessions.replaceSessionEntry(source, { sessionId, updatedAt: Date.now() });
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
        expect(sessions.loadExactSessionEntryReadOnly(source)).toBeUndefined();
        expect(sessions.loadExactSessionEntryReadOnly(destination)?.entry.sessionId).toBe(
          sessionId,
        );
        await expect(sessions.loadTranscriptEvents(destination)).resolves.toEqual(events);
        const deleted = await sessions.deleteSessionEntryLifecycle({
          agentId: destination.agentId,
          archiveTranscript: true,
          storePath: destination.storePath,
          target: { canonicalKey: destination.sessionKey, storeKeys: [destination.sessionKey] },
        });
        expect(deleted.deleted).toBe(true);
        expect(sessions.loadExactSessionEntryReadOnly(destination)).toBeUndefined();
        expect(deleted.archivedTranscripts).toHaveLength(1);
        expect(readSessionArchiveContentSync(deleted.archivedTranscripts[0]!.archivedPath)).toBe(
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        );
      });
      await withMaintenance(() => {
        expect(sessions.loadExactSessionEntryReadOnly(source)).toBeUndefined();
        expect(sessions.loadExactSessionEntryReadOnly(destination)).toBeUndefined();
      });
    });
  },
);

it("archives and restores exact cold history under Doctor maintenance", async () => {
  await withState(async (state) => {
    const fixture = await withMaintenance(async () => {
      const seeded = await createSessionColdStorageFixture(
        path.join(state.agentDir(), "openclaw-agent.sqlite"),
      );
      const events = sessions.loadTranscriptEventsSync(seeded.scope);
      await expect(
        runSessionColdStorageMaintenance({ config: maintenanceConfig(seeded.scope.storePath) }),
      ).resolves.toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      expect(() => sessions.loadTranscriptEventsSync(seeded.scope)).toThrow(
        expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
      );
      await restoreSessionColdTranscript(seeded.scope);
      expect(sessions.loadTranscriptEventsSync(seeded.scope)).toEqual(events);
      return seeded;
    });
    expect(fixture.snapshot()).toEqual(fixture.original);
  });
});
