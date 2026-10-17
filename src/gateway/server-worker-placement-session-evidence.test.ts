import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";

const evidenceWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/placement-session-evidence"
        ? { ...logger, warn: evidenceWarnSpy }
        : logger;
    },
  };
});
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { readSessionIdentityEvidenceInDatabase } from "../config/sessions/session-accessor.sqlite-entry-availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as registryListing from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createWorkerPlacementSessionEvidenceResolver } from "./server-worker-placement-session-evidence.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import { createPlacementSessionRetirement } from "./worker-environments/placement-session-retirement.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  evidenceWarnSpy.mockClear();
  tempDirs.cleanup();
});

function localPlacement(
  sessionId: string,
  sessionKey: string,
  agentId = "main",
): Extract<WorkerSessionPlacementRecord, { state: "local" }> {
  return {
    sessionId,
    sessionKey,
    agentId,
    state: "local",
    executionMode: "worker-turn",
    generation: 1,
    turnClaim: null,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
  };
}

async function resolvePlacementEvidence(placement: WorkerSessionPlacementRecord) {
  const resolve = await createWorkerPlacementSessionEvidenceResolver([placement]);
  return resolve(placement);
}

describe("worker placement session evidence", () => {
  it.each([
    { count: 12, prompt: "saved prompt ".repeat(16_384) },
    { count: 401, prompt: "" },
  ])(
    "reads bounded metadata without duplicating exact-current payloads for $count placements",
    async ({ count, prompt }) => {
      const stateDir = tempDirs.make("openclaw-placement-exact-first-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        setRuntimeConfigSnapshot({});
        const placements = Array.from({ length: count }, (_, index) =>
          localPlacement(`exact-current-${index}`, `agent:main:exact-current-${index}`),
        );
        for (const placement of placements) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId: placement.agentId, sessionKey: placement.sessionKey },
            {
              sessionId: placement.sessionId,
              updatedAt: 1,
              skillsSnapshot: { prompt, skills: [] },
            },
          );
        }
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        readSessionIdentityEvidenceInDatabase(database, placements);
        const statements = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(database.db),
          ["exact", "fallback"],
          (sql) => {
            const normalized = sql.toLowerCase().replaceAll(/\s+/g, " ");
            if (!normalized.includes('from "session_nodes"')) {
              return null;
            }
            if (normalized.includes('where "session_key" in')) {
              return "exact";
            }
            return normalized.includes('where "current_session_id" in') ? "fallback" : null;
          },
        );
        try {
          expect(
            readSessionIdentityEvidenceInDatabase(database, placements).map((row) => row.status),
          ).toEqual(placements.map(() => "current"));
          expect(statements.rowCounts.exact).toBe(count);
          expect(statements.textBytes.exact).toBeLessThan(count * 512);
          expect(
            statements.textBytes.fallback,
            JSON.stringify({
              queries: statements.counts.fallback,
              rows: statements.rowCounts.fallback,
              bytes: statements.textBytes.fallback,
            }),
          ).toBeLessThan(16_384);
        } finally {
          statements.restore();
        }
      });
    },
  );

  it("retires absent ownerless placements while retaining valid, unreadable, and claimed sessions", async () => {
    const stateDir = tempDirs.make("openclaw-placement-evidence-retirement-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      const placements = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
        now: () => 1_000,
      });
      const identities = ["current", "unreadable", "absent", "claimed"].map((kind) => ({
        agentId: "main",
        sessionId: `session-${kind}`,
        sessionKey: `agent:main:${kind}`,
      }));
      const claim = await placements.claimTurn({
        ...identities[3]!,
        owner: { kind: "local" },
        claimId: "live-claim",
        runId: "live-run",
      });
      const requested: WorkerSessionPlacementRecord[] = [];
      for (const identity of identities) {
        requested.push(await placements.startDispatch(identity));
      }
      for (const identity of identities.slice(0, 2)) {
        await sessionAccessor.upsertSessionEntryCore(identity, {
          sessionId: identity.sessionId,
          updatedAt: 1,
        });
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      // Retain an admitted reader so one later corrupt row does not block unrelated evidence.
      expect(
        readSessionIdentityEvidenceInDatabase(database, identities.slice(0, 2)).map(
          (row) => row.status,
        ),
      ).toEqual(["current", "current"]);
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run("{", identities[1]!.sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(identities[1]!.sessionKey);
      const forceDestroyEnvironment = vi.fn();
      const retirement = createPlacementSessionRetirement({
        placements,
        environments: { get: () => undefined },
        forceDestroyEnvironment,
        createSessionEvidenceResolver: createWorkerPlacementSessionEvidenceResolver,
        reportChanges: (operation) => operation(),
        warn: vi.fn(),
      });

      await retirement.reconcile();

      expect(placements.get(identities[0]!.sessionId)).toEqual(requested[0]);
      expect(placements.get(identities[1]!.sessionId)).toEqual(requested[1]);
      expect(placements.get(identities[2]!.sessionId)).toBeUndefined();
      expect(placements.get(identities[3]!.sessionId)).toMatchObject({
        state: "requested",
        generation: requested[3]!.generation,
        turnClaim: { owner: "local", claimId: claim.claimId, runId: claim.runId },
      });
      expect(forceDestroyEnvironment).not.toHaveBeenCalled();
    });
  });

  it("keeps ordinary database discovery failures independent from incognito evidence", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-read-failed-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const ordinary = localPlacement("session-read-failed", "agent:main:read-failed");
      const currentIncognito = localPlacement(
        "session-incognito-current",
        "agent:main:dashboard:incognito-current",
      );
      const deletedIncognito = localPlacement(
        "session-incognito-deleted",
        "agent:main:dashboard:incognito-deleted",
      );
      const store = path.join(stateDir, "unreadable.sqlite");
      fsSync.mkdirSync(store);
      const cfg: OpenClawConfig = { session: { store } };
      setRuntimeConfigSnapshot(cfg, cfg);
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: currentIncognito.sessionKey },
        { sessionId: currentIncognito.sessionId, updatedAt: 1 },
      );
      const placements = [ordinary, currentIncognito, deletedIncognito];
      const resolve = await createWorkerPlacementSessionEvidenceResolver(placements);
      await expect(Promise.all(placements.map(resolve))).resolves.toEqual([
        "unknown",
        "current",
        "absent",
      ]);
    });
  });

  it.each(["ops", "main"])(
    "resolves a migrated default-main placement persisted under %s",
    async (agentId) => {
      const stateDir = tempDirs.make("openclaw-placement-session-canonical-main-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const cfg: OpenClawConfig = {
          session: {
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { entries: { ops: {} } },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const placement = localPlacement("session-canonical-main", "agent:main:main", "ops");
        await sessionAccessor.upsertSessionEntryCore(
          { agentId, sessionKey: `agent:${agentId}:main` },
          { sessionId: placement.sessionId, updatedAt: 1 },
        );
        await expect(resolvePlacementEvidence(placement)).resolves.toBe("current");
      });
    },
  );

  it("preserves placement evidence when the registry is unreadable", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-registry-");
    fsSync.mkdirSync(path.join(stateDir, "state", "openclaw.sqlite"), { recursive: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      await expect(
        resolvePlacementEvidence(
          localPlacement("session-missing", "agent:retired:missing", "retired"),
        ),
      ).resolves.toBe("unknown");
    });
  });

  it("preserves registry failure boundaries for fixed sessions", async () => {
    const stateDir = tempDirs.make("openclaw-placement-registry-boundary-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const storePath = path.join(stateDir, "fixed", "shared.json");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const disk = localPlacement("disk", "agent:main:disk");
      const incognito = localPlacement(
        "private",
        "agent:main:dashboard:incognito-registry-current",
      );
      const missing = localPlacement("missing", "agent:main:dashboard:incognito-registry-missing");
      await sessionAccessor.upsertSessionEntryCore(
        { ...disk, storePath },
        { sessionId: disk.sessionId, updatedAt: 1 },
      );
      await sessionAccessor.upsertSessionEntryCore(incognito, {
        sessionId: incognito.sessionId,
        updatedAt: 1,
      });
      const read = vi.fn(async () => ({
        result: { status: "unavailable" as const },
        assertCurrent() {},
        followRegistration() {
          throw new Error("Unavailable placement registry reads cannot follow registration");
        },
      }));
      const prepareRegistry = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
      const registry = vi
        .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
        .mockImplementation((...args) => ({
          ...prepareRegistry(...args),
          read,
          assertCurrent() {},
        }));
      try {
        const requested = [disk, incognito, missing];
        const resolve = await createWorkerPlacementSessionEvidenceResolver(requested);
        expect(await Promise.all(requested.map(resolve))).toEqual(["unknown", "current", "absent"]);
        expect(read).toHaveBeenCalledOnce();
      } finally {
        registry.mockRestore();
      }
    });
  });

  it("keeps strict fresh admission for a migration-invalid session database", async () => {
    const stateDir = tempDirs.make("openclaw-placement-fresh-invalid-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      const current = localPlacement("current", "agent:main:current");
      await sessionAccessor.upsertSessionEntryCore(current, {
        sessionId: current.sessionId,
        updatedAt: 1,
      });
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db.exec("PRAGMA user_version = 999;");
      closeOpenClawAgentDatabasesForTest();
      const resolve = await createWorkerPlacementSessionEvidenceResolver([current]);
      expect(await resolve(current)).toBe("unknown");
    });
  });

  it("warns instead of silently swallowing resolver pipeline failures", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-pipeline-failure-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      const prepareRegistry = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
      const registry = vi
        .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
        .mockImplementationOnce((...args) => ({
          ...prepareRegistry(...args),
          assertCurrent() {},
          read: async () => {
            throw new Error("evidence pipeline exploded");
          },
        }));
      const placement = localPlacement(
        "session-pipeline-failure",
        "agent:retired:pipeline-failure",
        "retired",
      );

      await expect(resolvePlacementEvidence(placement)).resolves.toBe("unknown");
      expect(evidenceWarnSpy).toHaveBeenCalledOnce();
      expect(evidenceWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("session evidence resolution failed"),
        { error: expect.objectContaining({ message: "evidence pipeline exploded" }) },
      );
      registry.mockRestore();
    });
  });

  it.each(["cold", "warm"] as const)(
    "resolves a %s multi-agent disk batch without caller-thread SQLite",
    async (mode) => {
      const stateDir = tempDirs.make("openclaw-placement-session-evidence-batch-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        setRuntimeConfigSnapshot({});
        const placements = Array.from({ length: 20 }, (_, index) => {
          const agentId = index % 2 === 0 ? "main" : "ops";
          const sessionId = `session-${index}`;
          const sessionKey = `agent:${agentId}:placement-${index}`;
          return localPlacement(sessionId, sessionKey, agentId);
        });
        for (const placement of placements) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId: placement.agentId, sessionKey: placement.sessionKey },
            { sessionId: placement.sessionId, updatedAt: 1 },
          );
        }
        // Fixture writes schedule maintenance; join its worker and lease cleanup
        // before measuring the read. Warm readers are then admitted independently.
        await closeOpenClawAgentDatabasesAsync();
        if (mode === "warm") {
          const databases = new Map(
            ["main", "ops"].map((agentId) => [agentId, openOpenClawAgentDatabase({ agentId })]),
          );
          expect(
            sessionAccessor
              .readSessionIdentityEvidenceBatch(
                placements.map((placement) => ({
                  ...placement,
                  storePath: databases.get(placement.agentId)!.path,
                })),
              )
              .map((row) => row.status),
          ).toEqual(placements.map(() => "current"));
        }

        registryListing.invalidateRegisteredAgentDatabasesMemo({ env: process.env });
        const native = requireNodeSqlite();
        const calibration = new native.DatabaseSync(":memory:");
        calibration.exec("CREATE TABLE calibration (value INTEGER)");
        const cachedInsert = calibration.prepare("INSERT INTO calibration VALUES (?)");
        const cachedRead = calibration.prepare("SELECT value FROM calibration");
        const observation = observeMainThreadSql();
        const counters = observation.calls;
        try {
          try {
            calibration.exec("DELETE FROM calibration");
            cachedInsert.run(1);
            cachedRead.get();
            cachedRead.all();
            expect([...cachedRead.iterate()]).toHaveLength(1);
            expect(counters.slice(2).every((counter) => counter.mock.calls.length > 0)).toBe(true);
            calibration.prepare("SELECT 1").get();
            expect(counters.every((counter) => counter.mock.calls.length > 0)).toBe(true);
          } finally {
            calibration.close();
            observation.clear();
          }
          const resolve = await createWorkerPlacementSessionEvidenceResolver(placements);
          await expect(Promise.all(placements.map(resolve))).resolves.toEqual(
            placements.map(() => "current"),
          );
          expect(
            counters.map((counter) => counter.mock.calls.length),
            JSON.stringify(counters.slice(0, 2).map((counter) => counter.mock.calls)),
          ).toEqual([0, 0, 0, 0, 0, 0]);
        } finally {
          observation.restore();
        }
      });
    },
  );
});
