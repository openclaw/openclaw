import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as registryListing from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
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
          database.db,
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
      const placements = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
        now: () => 1_000,
      });
      const identities = ["current", "unreadable", "absent", "claimed"].map((kind) => ({
        agentId: "main",
        sessionId: `session-${kind}`,
        sessionKey: `agent:main:${kind}`,
      }));
      const claim = placements.claimTurn({
        ...identities[3]!,
        owner: { kind: "local" },
        claimId: "live-claim",
        runId: "live-run",
      });
      const requested = identities.map((identity) => placements.startDispatch(identity));
      for (const identity of identities.slice(0, 2)) {
        await sessionAccessor.upsertSessionEntryCore(identity, {
          sessionId: identity.sessionId,
          updatedAt: 1,
        });
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
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

  it.each(["database", "directory"] as const)(
    "keeps ordinary %s discovery failures independent from incognito evidence",
    async (failure) => {
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
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey: currentIncognito.sessionKey },
          { sessionId: currentIncognito.sessionId, updatedAt: 1 },
        );
        const store =
          failure === "database"
            ? path.join(stateDir, "unreadable.sqlite")
            : path.join(stateDir, "not-a-directory", "shared.json");
        if (failure === "database") {
          fsSync.mkdirSync(store);
        } else {
          fsSync.writeFileSync(path.dirname(store), "synthetic non-directory");
        }
        const cfg: OpenClawConfig = { session: { store } };
        setRuntimeConfigSnapshot(cfg, cfg);

        const placements = [ordinary, currentIncognito, deletedIncognito];
        const resolve = await createWorkerPlacementSessionEvidenceResolver(placements);

        await expect(Promise.all(placements.map(resolve))).resolves.toEqual([
          "unknown",
          "current",
          "absent",
        ]);
      });
    },
  );

  it("keeps required-table loss local to one agent during real placement discovery", async () => {
    const stateDir = tempDirs.make("openclaw-placement-partial-table-loss-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const cfg: OpenClawConfig = { agents: { list: [{ id: "main" }, { id: "healthy" }] } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const broken = localPlacement("broken", "agent:main:broken");
      const healthy = localPlacement("healthy", "agent:healthy:healthy", "healthy");
      const absent = localPlacement("absent", "agent:healthy:absent", "healthy");
      const incognito = localPlacement(
        "private",
        "agent:healthy:dashboard:incognito-private",
        "healthy",
      );
      for (const placement of [broken, healthy, incognito]) {
        await sessionAccessor.upsertSessionEntryCore(placement, {
          sessionId: placement.sessionId,
          updatedAt: 1,
        });
      }
      // Join seeded disk maintenance before corrupting a store; retain native incognito state.
      for (const agentId of ["main", "healthy"]) {
        const seeded = openOpenClawAgentDatabase({ agentId });
        await closeOpenClawAgentDatabaseByPathAsync(seeded.path, agentId);
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      expect(
        readSessionIdentityEvidenceInDatabase(database, [broken]).map((row) => row.status),
      ).toEqual(["current"]);
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      database.db.exec("DROP TABLE session_nodes");

      const requested = [broken, healthy, absent, incognito];
      const resolve = await createWorkerPlacementSessionEvidenceResolver(requested);

      expect(evidenceWarnSpy).not.toHaveBeenCalled();
      expect(await Promise.all(requested.map(resolve))).toEqual([
        "unknown",
        "current",
        "absent",
        "current",
      ]);
    });
  });

  it("canonicalizes legacy default-main placements before batching", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-canonical-main-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
      const cfg: OpenClawConfig = {
        session: { store: storeTemplate },
        agents: { list: [{ id: "ops", default: true }] },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const placement = localPlacement("session-canonical-main", "agent:main:main", "ops");
      const canonicalKey = "agent:ops:main";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "ops", sessionKey: canonicalKey },
        { sessionId: placement.sessionId, updatedAt: 1 },
      );

      const resolve = await createWorkerPlacementSessionEvidenceResolver([placement]);

      await expect(resolve(placement)).resolves.toBe("current");
    });
  });

  it("keeps a listed deleted-main placement current after default-agent migration", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-legacy-main-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "ops", default: true }] },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      const placement = localPlacement("session-legacy-main", "agent:main:main", "ops");
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: placement.sessionKey },
        { sessionId: placement.sessionId, updatedAt: 1 },
      );

      const resolve = await createWorkerPlacementSessionEvidenceResolver([placement]);

      await expect(resolve(placement)).resolves.toBe("current");
    });
  });

  it("reports absence when the configured session database is genuinely missing", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-database-missing-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        resolvePlacementEvidence(localPlacement("session-missing", "agent:main:missing")),
      ).resolves.toBe("absent");
      expect(fsSync.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      expect(
        fsSync.existsSync(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
      ).toBe(false);
    });
  });

  it("keeps a placement when the agent database registry is unreadable", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-registry-unreadable-");
    fsSync.mkdirSync(path.join(stateDir, "state", "openclaw.sqlite"), { recursive: true });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        resolvePlacementEvidence(
          localPlacement("session-unreadable", "agent:retired:unreadable", "retired"),
        ),
      ).resolves.toBe("unknown");
    });
  });

  it.each(["configured", "fixed", "retired", "incognito-only"] as const)(
    "preserves registry failure boundaries for %s sessions",
    async (route) => {
      const stateDir = tempDirs.make("openclaw-placement-registry-boundary-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const storePath =
          route === "fixed" ? path.join(stateDir, "fixed", "shared.json") : undefined;
        const cfg: OpenClawConfig = {
          agents: { list: [{ id: "main" }] },
          ...(storePath ? { session: { store: storePath } } : {}),
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentId = route === "retired" ? "retired" : "main";
        const disk = localPlacement("disk", `agent:${agentId}:disk`, agentId);
        const incognito = localPlacement(
          "private",
          "agent:main:dashboard:incognito-registry-current",
        );
        const missing = localPlacement(
          "missing",
          "agent:main:dashboard:incognito-registry-missing",
        );
        if (route === "configured" || route === "fixed") {
          await sessionAccessor.upsertSessionEntryCore(
            { ...disk, storePath },
            { sessionId: disk.sessionId, updatedAt: 1 },
          );
        }
        await sessionAccessor.upsertSessionEntryCore(incognito, {
          sessionId: incognito.sessionId,
          updatedAt: 1,
        });
        const read = vi.fn(async () => ({
          result: { status: "unavailable" as const },
          assertCurrent() {},
        }));
        const registry = vi
          .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
          .mockReturnValue({ read, assertCurrent() {} });
        try {
          const requested =
            route === "incognito-only" ? [incognito, missing] : [disk, incognito, missing];
          const resolve = await createWorkerPlacementSessionEvidenceResolver(requested);
          expect(await Promise.all(requested.map(resolve))).toEqual(
            route === "configured"
              ? ["current", "current", "absent"]
              : route === "fixed"
                ? ["unknown", "current", "absent"]
                : route === "retired"
                  ? ["unknown", "unknown", "unknown"]
                  : ["current", "absent"],
          );
          expect(read).toHaveBeenCalledTimes(route === "fixed" || route === "retired" ? 1 : 0);
        } finally {
          registry.mockRestore();
        }
      });
    },
  );

  it("keeps a placement when its session database is migration-invalid", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-evidence-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const sessionId = "session-1";
      const sessionKey = "agent:main:main";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1 },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db.exec("PRAGMA user_version = 999;");
      closeOpenClawAgentDatabasesForTest();

      await expect(resolvePlacementEvidence(localPlacement(sessionId, sessionKey))).resolves.toBe(
        "unknown",
      );
    });
  });

  it("keeps strict fresh admission when no warm reader can continue a malformed store", async () => {
    const stateDir = tempDirs.make("openclaw-placement-fresh-malformed-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const current = localPlacement("current", "agent:main:current");
      const unreadable = localPlacement("unreadable", "agent:main:unreadable");
      const absent = localPlacement("absent", "agent:main:absent");
      for (const subject of [current, unreadable]) {
        await sessionAccessor.upsertSessionEntryCore(subject, {
          sessionId: subject.sessionId,
          updatedAt: 1,
        });
      }
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(
          "UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?",
        )
        .run("{", unreadable.sessionKey);
      await closeOpenClawAgentDatabasesAsync();
      const subjects = [current, unreadable, absent];
      const resolve = await createWorkerPlacementSessionEvidenceResolver(subjects);
      expect(await Promise.all(subjects.map(resolve))).toEqual(["unknown", "unknown", "unknown"]);
    });
  });

  it("warns instead of silently swallowing resolver pipeline failures", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-pipeline-failure-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const registry = vi
        .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
        .mockReturnValueOnce({
          assertCurrent() {},
          read: async () => {
            throw new Error("evidence pipeline exploded");
          },
        });
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
        const counters = [
          vi.spyOn(native.DatabaseSync.prototype, "prepare"),
          vi.spyOn(native.DatabaseSync.prototype, "exec"),
          ...(["get", "all", "run", "iterate"] as const).map((method) =>
            vi.spyOn(native.StatementSync.prototype, method),
          ),
        ];
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
            for (const counter of counters) {
              counter.mockClear();
            }
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
          for (const counter of counters) {
            counter.mockRestore();
          }
        }
      });
    },
  );
});
