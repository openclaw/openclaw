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
import { readSessionIdentityEvidenceInDatabase as readEvidence } from "../config/sessions/session-accessor.sqlite-entry-availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { createWorkerPlacementSessionEvidenceResolver as createResolver } from "./server-worker-placement-session-evidence.js";
import * as sessionStoreKey from "./session-store-key.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import { createPlacementSessionRetirement } from "./worker-environments/placement-session-retirement.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { localPlacement as createLocalPlacement } from "./worker-environments/placement-suite.test-support.js";

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
  return { ...createLocalPlacement(sessionId), sessionKey, agentId };
}

async function resolvePlacementEvidence(placement: WorkerSessionPlacementRecord) {
  const resolve = await createResolver([placement]);
  return resolve(placement);
}

function withEvidenceState(run: (stateDir: string) => Promise<void>) {
  const stateDir = tempDirs.make("openclaw-placement-evidence-");
  return withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () => run(stateDir));
}

function configureStore(store: string, agents?: OpenClawConfig["agents"]) {
  const cfg: OpenClawConfig = { session: { store }, ...(agents ? { agents } : {}) };
  setRuntimeConfigSnapshot(cfg, cfg);
}

function writeSession(
  identity: Parameters<typeof sessionAccessor.upsertSessionEntryCore>[0] & { sessionId: string },
  entry: Partial<Parameters<typeof sessionAccessor.upsertSessionEntryCore>[1]> = {},
) {
  return sessionAccessor.upsertSessionEntryCore(identity, {
    sessionId: identity.sessionId,
    updatedAt: 1,
    ...entry,
  });
}

function mixedSubjects() {
  return [
    localPlacement("disk", "agent:main:disk"),
    localPlacement("private", "agent:main:dashboard:incognito-current"),
    localPlacement("missing", "agent:main:dashboard:incognito-missing"),
  ] as const;
}

describe("worker placement session evidence", () => {
  it.each([
    { count: 12, prompt: "saved prompt ".repeat(16_384) },
    { count: 401, prompt: "" },
  ])(
    "reads bounded metadata without duplicating exact-current payloads for $count placements",
    ({ count, prompt }) =>
      withEvidenceState(async () => {
        setRuntimeConfigSnapshot({});
        const placements = Array.from({ length: count }, (_, index) =>
          localPlacement(`exact-current-${index}`, `agent:main:exact-current-${index}`),
        );
        for (const placement of placements) {
          await writeSession(placement, { skillsSnapshot: { prompt, skills: [] } });
        }
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        readEvidence(database, placements);
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
          expect(readEvidence(database, placements).map((row) => row.status)).toEqual(
            placements.map(() => "current"),
          );
          expect(statements.rowCounts.exact).toBe(count);
          expect(statements.textBytes.exact).toBeLessThan(count * 512);
          expect(statements.textBytes.fallback, JSON.stringify(statements)).toBeLessThan(16_384);
        } finally {
          statements.restore();
        }
      }),
  );

  it("retires absent ownerless placements while retaining valid, unreadable, and claimed sessions", () =>
    withEvidenceState(async () => {
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
        await writeSession(identity);
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      // Retain an admitted reader so one later corrupt row does not block unrelated evidence.
      expect(readEvidence(database, identities.slice(0, 2)).map((row) => row.status)).toEqual([
        "current",
        "current",
      ]);
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?")
        .run("{", identities[1]!.sessionKey);
      const forceDestroyEnvironment = vi.fn();
      const retirement = createPlacementSessionRetirement({
        placements,
        environments: { get: () => undefined },
        forceDestroyEnvironment,
        createSessionEvidenceResolver: createResolver,
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
    }));

  it("keeps ordinary database discovery failures independent from incognito evidence", () =>
    withEvidenceState(async (stateDir) => {
      const placements = mixedSubjects();
      const store = path.join(stateDir, "unreadable.sqlite");
      fsSync.mkdirSync(store);
      configureStore(store);
      await writeSession(placements[1]);
      const resolve = await createResolver(placements);
      await expect(Promise.all(placements.map(resolve))).resolves.toEqual([
        "unknown",
        "current",
        "absent",
      ]);
    }));

  it.each(["ops", "main"])(
    "resolves a migrated default-main placement persisted under %s",
    (agentId) =>
      withEvidenceState(async (stateDir) => {
        configureStore(path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"), {
          entries: { ops: {} },
        });
        const placement = localPlacement("session-canonical-main", "agent:main:main", "ops");
        await writeSession({
          agentId,
          sessionKey: `agent:${agentId}:main`,
          sessionId: placement.sessionId,
        });
        await expect(resolvePlacementEvidence(placement)).resolves.toBe("current");
      }),
  );

  it("preserves placement evidence when the registry is unreadable", () =>
    withEvidenceState(async (stateDir) => {
      fsSync.mkdirSync(path.join(stateDir, "state", "openclaw.sqlite"), { recursive: true });
      setRuntimeConfigSnapshot({});
      await expect(
        resolvePlacementEvidence(
          localPlacement("session-missing", "agent:retired:missing", "retired"),
        ),
      ).resolves.toBe("unknown");
    }));

  it("preserves registry failure boundaries for fixed sessions", () =>
    withEvidenceState(async (stateDir) => {
      const storePath = path.join(stateDir, "fixed", "shared.json");
      configureStore(storePath, { entries: { main: {} } });
      const requested = mixedSubjects();
      const [disk, incognito] = requested;
      await writeSession({ ...disk, storePath });
      await writeSession(incognito);
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
        const resolve = await createResolver(requested);
        expect(await Promise.all(requested.map(resolve))).toEqual(["unknown", "current", "absent"]);
        expect(read).toHaveBeenCalledOnce();
      } finally {
        registry.mockRestore();
      }
    }));

  it("keeps strict fresh admission for a migration-invalid session database", () =>
    withEvidenceState(async () => {
      setRuntimeConfigSnapshot({});
      const current = localPlacement("current", "agent:main:current");
      await writeSession(current);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db.exec("PRAGMA user_version = 999;");
      closeOpenClawAgentDatabasesForTest();
      const resolve = await createResolver([current]);
      expect(await resolve(current)).toBe("unknown");
    }));

  it("warns instead of silently swallowing resolver pipeline failures", () =>
    withEvidenceState(async (stateDir) => {
      configureStore(path.join(stateDir, "fixed", "shared.json"));
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
    }));

  it.each(["cold", "warm"] as const)(
    "resolves a %s multi-agent disk batch without caller-thread SQLite",
    (mode) =>
      withEvidenceState(async () => {
        setRuntimeConfigSnapshot({});
        const placements = Array.from({ length: 20 }, (_, index) => {
          const agentId = index % 2 === 0 ? "main" : "ops";
          const sessionId = `session-${index}`;
          const sessionKey = `agent:${agentId}:placement-${index}`;
          return localPlacement(sessionId, sessionKey, agentId);
        });
        for (const placement of placements) {
          await writeSession(placement);
        }
        // Drain fixture maintenance before independently admitting warm readers.
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
        const resolveOwner = vi.spyOn(sessionStoreKey, "resolveSessionStoreAgentId");
        const observation = observeMainThreadSql();
        try {
          observation.calibrate();
          const resolve = await createResolver(placements);
          await expect(Promise.all(placements.map(resolve))).resolves.toEqual(
            placements.map(() => "current"),
          );
          observation.expectIdle();
          expect(resolveOwner).not.toHaveBeenCalled();
        } finally {
          resolveOwner.mockRestore();
          observation.restore();
        }
      }),
  );
});
