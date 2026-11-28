import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { migrateLegacyAcpSessionMetadata } from "../infra/state-migrations.acp-session-metadata.js";
import { migrateDaemonRuntimePins } from "../infra/state-migrations.daemon-runtime-pins.js";
import { prepareDoctorAgentDatabaseDiscovery } from "../infra/state-migrations.doctor-discovery.js";
import { detectLegacyStateMigrations } from "../infra/state-migrations.doctor.js";
import { migrateOrphanedSessionKeys } from "../infra/state-migrations.session-store.js";
import { migrateSharedAuthStore } from "../infra/state-migrations.shared-auth-store.js";
import { migrateHistoricalTranscriptDirectives } from "../infra/state-migrations.transcript-directives.js";
import { interruptedRunFixture } from "../infra/update-run-fixture.test-support.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as storeFiles from "../test-utils/store-snapshot.test-support.js";
import {
  traceConfigFlowPendingInputs,
  type DoctorConfigFlowPendingParams,
} from "./doctor-config-flow-pending.js";
import type {
  DoctorMaintenancePending,
  DoctorMaintenancePendingCheck,
} from "./doctor-maintenance-pending.js";
import { retireSkillWorkshopProposals } from "./doctor-skill-workshop-retire-proposals.js";

// The migration graph steps that run on every Doctor pass, in graph order.
const LEGACY_STATE_STEPS = [
  "config-machine-state",
  "transcript-directives",
  "orphan-session-keys",
  "shared-auth-store",
  "delivery-queues",
  "workspace-aliases",
  "skill-workshop",
  "acp-session-metadata",
] as const;

const handles: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.close();
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

/** A home with its own state directory and a current config naming one agent. */
function makeInstall(config: Record<string, unknown> = {}) {
  const home = tempDirs.make("config-flow-pending-");
  const stateDir = path.join(home, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ gateway: { mode: "local" }, ...config }),
  );
  return { home, stateDir, env };
}

/** Creates the state database, closes it and removes its sidecars, as a stopped Gateway leaves it. */
async function createStateDatabase(env: NodeJS.ProcessEnv) {
  const databasePath = openOpenClawStateDatabase({ env }).path;
  await closeOpenClawStateDatabaseAsync();
  storeFiles.removeEmptySqliteSidecars(env.OPENCLAW_STATE_DIR!);
  return databasePath;
}

/** Holds a store open as the serving Gateway does, so its WAL sidecars exist. */
function holdOpen(databasePath: string) {
  const gateway = new DatabaseSync(databasePath);
  gateway.prepare("SELECT count(*) FROM sqlite_schema").get();
  handles.push(gateway);
}

async function decide(id: string, params: DoctorConfigFlowPendingParams) {
  const answer = new Map(await traceAll(params)).get(`config-flow.${id}`);
  if (!answer) {
    throw new Error(`config-flow input ${id} was not traced`);
  }
  return answer;
}

async function traceAll(params: DoctorConfigFlowPendingParams) {
  const traced: Array<[string, DoctorMaintenancePending]> = [];
  const trace = async (step: string, check?: DoctorMaintenancePendingCheck) => {
    const pending = check ? await check() : "work";
    traced.push([step, pending]);
    return pending !== "none";
  };
  await traceConfigFlowPendingInputs(trace, params);
  return traced;
}

describe("doctor config-flow pending", () => {
  it("traces every input and keeps the step at work while an input has no check", async () => {
    const { stateDir, env } = makeInstall();
    holdOpen(await createStateDatabase(env));
    const agentDatabaseMigrationDiscovery = await prepareDoctorAgentDatabaseDiscovery({}, env);
    const before = storeFiles.snapshotStoreFiles(stateDir);

    const traced = new Map(
      await traceAll({ env, integrityCheck: "quick", agentDatabaseMigrationDiscovery }),
    );

    // One trace per owner, in the order the flow reaches them, then the step.
    expect([...traced.keys()]).toEqual([
      ...[
        "state-write-admission",
        "legacy-state-dir",
        "legacy-config",
        "state-schema",
        "retired-state",
        "session-entry-state",
        "plugin-convergence",
        "plugin-obligations",
        "cron",
        "legacy-state-detection",
        "agent-databases",
        ...LEGACY_STATE_STEPS.map((step) => `legacy-state-steps.${step}`),
        "a2ui-widgets",
        "relative-session-stores",
        "update-history",
        "config-repairs",
      ].map((id) => `config-flow.${id}`),
      "config-flow",
    ]);
    // An input without a read-only predicate is work, so the step cannot answer none.
    expect(traced.get("config-flow.config-repairs")).toBe("work");
    expect(traced.get("config-flow.agent-databases")).toBe("none");
    expect(traced.get("config-flow.update-history")).toBe("none");
    expect(traced.get("config-flow")).toBe("work");
    expect(storeFiles.changedStoreFiles(before, storeFiles.snapshotStoreFiles(stateDir))).toEqual(
      [],
    );
  });

  it("answers work when state write admission would harden or quarantine files", async () => {
    const { env } = makeInstall();
    const databasePath = await createStateDatabase(env);
    expect(await decide("state-write-admission", { env, integrityCheck: "quick" })).toBe("none");
    fs.chmodSync(databasePath, 0o644);
    expect(await decide("state-write-admission", { env, integrityCheck: "quick" })).toBe("work");
    fs.rmSync(databasePath);
    fs.writeFileSync(`${databasePath}-wal`, "");
    expect(await decide("state-write-admission", { env, integrityCheck: "quick" })).toBe("work");
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(true);
  });

  it("answers work for a pending legacy state directory", async () => {
    const home = tempDirs.make("config-flow-pending-home-");
    const env = { HOME: home };
    expect(await decide("legacy-state-dir", { env, integrityCheck: "quick" })).toBe("none");
    fs.mkdirSync(path.join(home, ".clawdbot"));
    expect(await decide("legacy-state-dir", { env, integrityCheck: "quick" })).toBe("work");
  });

  it("answers work for a legacy config shape and none for the current one", async () => {
    const current = makeInstall();
    expect(await decide("legacy-config", { env: current.env, integrityCheck: "quick" })).toBe(
      "none",
    );
    // `routing` is a retired root key the preflight migrates.
    const legacy = makeInstall({ routing: { transcribeAudio: { command: ["whisper"] } } });
    expect(await decide("legacy-config", { env: legacy.env, integrityCheck: "quick" })).toBe(
      "work",
    );
  });

  it("answers work while a retired state file remains", async () => {
    const { stateDir, env } = makeInstall();
    expect(await decide("retired-state", { env, integrityCheck: "quick" })).toBe("none");
    fs.mkdirSync(path.join(stateDir, "acp"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "acp", "event-ledger.json"), "{}");
    expect(await decide("retired-state", { env, integrityCheck: "quick" })).toBe("work");
  });

  it("answers work for a retired cron store and none without one", async () => {
    const { stateDir, env } = makeInstall();
    // The partition selection and job reads go through the held state database.
    holdOpen(await createStateDatabase(env));
    const before = storeFiles.snapshotStoreFiles(stateDir, { ignoreReadSidecars: true });
    expect(await decide("cron", { env, integrityCheck: "quick" })).toBe("none");
    expect(
      storeFiles.changedStoreFiles(
        before,
        storeFiles.snapshotStoreFiles(stateDir, { ignoreReadSidecars: true }),
      ),
    ).toEqual([]);
    fs.mkdirSync(path.join(stateDir, "cron"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }));
    expect(await decide("cron", { env, integrityCheck: "quick" })).toBe("work");
  });

  describe("plugin obligations", () => {
    it("answers none with no recorded obligation and every configured plugin available", async () => {
      const { env } = makeInstall();
      holdOpen(await createStateDatabase(env));
      expect(await decide("plugin-obligations", { env, integrityCheck: "quick" })).toBe("none");
    });

    it("answers work while any obligation is recorded", async () => {
      const { env } = makeInstall();
      holdOpen(await createStateDatabase(env));
      await recordDeferredPluginMigrations({
        env,
        pending: [
          {
            pluginId: "retained-owner",
            reason: "The plugin has not reported completion.",
            command: "openclaw update repair",
          },
        ],
      });
      expect(await decide("plugin-obligations", { env, integrityCheck: "quick" })).toBe("work");
    });

    it("answers work for a recorded obligation even without a config file", async () => {
      const { stateDir, env } = makeInstall();
      fs.rmSync(path.join(stateDir, "openclaw.json"));
      holdOpen(await createStateDatabase(env));
      expect(await decide("plugin-obligations", { env, integrityCheck: "quick" })).toBe("none");
      await recordDeferredPluginMigrations({
        env,
        pending: [
          {
            pluginId: "retained-owner",
            reason: "The plugin has not reported completion.",
            command: "openclaw update repair",
          },
        ],
      });
      expect(await decide("plugin-obligations", { env, integrityCheck: "quick" })).toBe("work");
    });

    it("answers work for a configured plugin that is not installed", async () => {
      const { env } = makeInstall({ plugins: { entries: { "absent-owner": { enabled: true } } } });
      holdOpen(await createStateDatabase(env));
      expect(await decide("plugin-obligations", { env, integrityCheck: "quick" })).toBe("work");
    });
  });

  it("answers undecidable without creating sidecars when no connection holds the store", async () => {
    const { stateDir, env } = makeInstall();
    await createStateDatabase(env);
    const agentDatabaseMigrationDiscovery = await prepareDoctorAgentDatabaseDiscovery({}, env);
    await closeOpenClawStateDatabaseAsync();
    storeFiles.removeEmptySqliteSidecars(stateDir);
    const before = storeFiles.snapshotStoreFiles(stateDir);
    const params = { env, integrityCheck: "quick" as const, agentDatabaseMigrationDiscovery };

    for (const id of [
      "legacy-config",
      "session-entry-state",
      "plugin-convergence",
      "plugin-obligations",
      "cron",
      "legacy-state-detection",
      "agent-databases",
      ...LEGACY_STATE_STEPS.map((step) => `legacy-state-steps.${step}`),
      "relative-session-stores",
      "update-history",
    ]) {
      expect([id, await decide(id, params)]).toEqual([id, "undecidable"]);
    }
    expect(storeFiles.listSqliteSidecars(stateDir)).toEqual([]);
    expect(storeFiles.changedStoreFiles(before, storeFiles.snapshotStoreFiles(stateDir))).toEqual(
      [],
    );
  });

  describe("legacy state steps", () => {
    /** Holds the state database and every discovered agent database, as a serving Gateway does. */
    async function heldParams(env: NodeJS.ProcessEnv): Promise<DoctorConfigFlowPendingParams> {
      await releaseStores(env);
      holdOpen(path.join(env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"));
      const agentDatabaseMigrationDiscovery = await prepareDoctorAgentDatabaseDiscovery({}, env);
      for (const target of agentDatabaseMigrationDiscovery.discovery.targets) {
        holdOpen(target.path);
      }
      return { env, integrityCheck: "quick", agentDatabaseMigrationDiscovery };
    }

    /** Closes every connection, as a stopped Gateway leaves the stores. */
    async function releaseStores(env: NodeJS.ProcessEnv) {
      for (const handle of handles.splice(0)) {
        handle.close();
      }
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      storeFiles.removeEmptySqliteSidecars(env.OPENCLAW_STATE_DIR!);
    }

    /** Decides one step and proves the check changed no store file. */
    async function decideStep(step: (typeof LEGACY_STATE_STEPS)[number], env: NodeJS.ProcessEnv) {
      const params = await heldParams(env);
      const before = storeFiles.snapshotStoreFiles(env.OPENCLAW_STATE_DIR!, {
        ignoreReadSidecars: true,
      });
      const answer = await decide(`legacy-state-steps.${step}`, params);
      expect(
        storeFiles.changedStoreFiles(
          before,
          storeFiles.snapshotStoreFiles(env.OPENCLAW_STATE_DIR!, { ignoreReadSidecars: true }),
        ),
      ).toEqual([]);
      return answer;
    }

    it("decides runtime pins and machine-owned config fields from their own receipts", async () => {
      const { stateDir, env } = makeInstall();
      await createStateDatabase(env);
      // No completed runtime pin receipt yet: the handoff still runs.
      expect(await decideStep("config-machine-state", env)).toBe("work");
      await closeOpenClawStateDatabaseAsync();
      expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
      expect(await decideStep("config-machine-state", env)).toBe("none");
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({ gateway: { mode: "local" }, cron: { store: "~/cron.json" } }),
      );
      expect(await decideStep("config-machine-state", env)).toBe("work");
    });

    it("decides transcript directives per agent database without inspecting leases", async () => {
      const { env } = makeInstall();
      await createStateDatabase(env);
      openOpenClawAgentDatabase({ agentId: "main", env });
      // A database whose migration cursor was never written still needs the pass.
      expect(await decideStep("transcript-directives", env)).toBe("work");
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      expect((await migrateHistoricalTranscriptDirectives({ env })).warnings).toEqual([]);
      expect(await decideStep("transcript-directives", env)).toBe("none");
    });

    it("decides orphaned session keys from the migration's own pass", async () => {
      const { stateDir, env } = makeInstall({ agents: { entries: { ops: {} } } });
      await createStateDatabase(env);
      expect(await decideStep("orphan-session-keys", env)).toBe("none");
      const storePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ main: { sessionId: "s", updatedAt: 1 } }));
      expect(await decideStep("orphan-session-keys", env)).toBe("work");
      const migrated = await migrateOrphanedSessionKeys({
        cfg: { agents: { entries: { ops: {} } } },
        env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(migrated.changes).toEqual([`Canonicalized 1 orphaned session key(s) in ${storePath}`]);
      expect(await decideStep("orphan-session-keys", env)).toBe("none");
    });

    it("decides the shared auth store from the detection the writer acts on", async () => {
      const { stateDir, env } = makeInstall();
      await createStateDatabase(env);
      // Without an ownership record the main agent's store still owns shared credentials.
      expect(await decideStep("shared-auth-store", env)).toBe("work");
      await closeOpenClawStateDatabaseAsync();
      const detected = await detectLegacyStateMigrations({
        cfg: { gateway: { mode: "local" } },
        env,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      await migrateSharedAuthStore({ detected: detected.sharedAuthStore, stateDir, env });
      await closeOpenClawStateDatabaseAsync();
      expect(await decideStep("shared-auth-store", env)).toBe("none");
    });

    it("decides delivery queues from retired files and pending legacy entries", async () => {
      const { stateDir, env } = makeInstall();
      await createStateDatabase(env);
      expect(await decideStep("delivery-queues", env)).toBe("none");
      fs.mkdirSync(path.join(stateDir, "delivery-queue"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "delivery-queue", "entry.json"), "{}");
      expect(await decideStep("delivery-queues", env)).toBe("work");
    });

    it("retires nothing beside a held healthy store without opening it for writing", async () => {
      const { stateDir, env } = makeInstall({ agents: { entries: { main: {} } } });
      await createStateDatabase(env);
      await heldParams(env);
      const before = storeFiles.snapshotStoreFiles(stateDir, { ignoreReadSidecars: true });
      expect(
        await retireSkillWorkshopProposals({ config: { agents: { entries: { main: {} } } }, env }),
      ).toEqual({ changes: [], warnings: [] });
      // A writable open re-admits the store and removes its clean-close seal.
      expect(
        storeFiles.changedStoreFiles(
          before,
          storeFiles.snapshotStoreFiles(stateDir, { ignoreReadSidecars: true }),
        ),
      ).toEqual([]);
    });

    it("decides Skill Workshop retirement from the retired tables, files and exports", async () => {
      const { stateDir, env } = makeInstall({ agents: { entries: { main: {} } } });
      await createStateDatabase(env);
      const config = { agents: { entries: { main: {} } } };
      expect(await decideStep("skill-workshop", env)).toBe("none");
      // An older release's retired table.
      openOpenClawStateDatabase({ env }).db.exec(
        "CREATE TABLE skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY) STRICT",
      );
      expect(await decideStep("skill-workshop", env)).toBe("work");
      await closeOpenClawStateDatabaseAsync();
      expect((await retireSkillWorkshopProposals({ config, env })).changes).toEqual([
        "Retired the Skill Workshop proposal tables.",
      ]);
      expect(await decideStep("skill-workshop", env)).toBe("none");
      fs.mkdirSync(path.join(stateDir, "skill-workshop", "proposals"), { recursive: true });
      expect(await decideStep("skill-workshop", env)).toBe("work");
    });

    it("decides ACP session metadata from the migration's own pass", async () => {
      const cfg = { agents: { entries: { ops: {} } }, plugins: { enabled: false } };
      const { stateDir, env } = makeInstall(cfg);
      await createStateDatabase(env);
      expect(await decideStep("acp-session-metadata", env)).toBe("none");
      const storePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
      const sessionKey = "agent:ops:acp:binding:discord:default:af00112233445566";
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "session",
            updatedAt: 100,
            acp: {
              backend: "acpx",
              agent: "fixture",
              mode: "persistent",
              state: "idle",
              lastActivityAt: 100,
              runtimeSessionName: "legacy-runtime",
            },
          },
        }),
      );
      expect(await decideStep("acp-session-metadata", env)).toBe("work");
      await closeOpenClawStateDatabaseAsync();
      const migrated = await migrateLegacyAcpSessionMetadata({
        cfg,
        env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(migrated).toMatchObject({ warnings: [] });
      expect(migrated.changes).toHaveLength(1);
      expect(await decideStep("acp-session-metadata", env)).toBe("none");
    });
  });

  it("answers work for an interrupted update the reconciliation would settle", async () => {
    const { env } = makeInstall();
    holdOpen(await createStateDatabase(env));
    expect(await decide("update-history", { env, integrityCheck: "quick" })).toBe("none");
    const run = interruptedRunFixture(
      { env },
      { version: "2026.9.4", buildId: "interrupted-candidate" },
    );
    expect(await decide("update-history", { env, integrityCheck: "quick" })).toBe("work");
    run.finish({ status: "succeeded" });
    expect(await decide("update-history", { env, integrityCheck: "quick" })).toBe("none");
  });

  it("leaves the agent database plan undecidable without the preflight's discovery", async () => {
    const { env } = makeInstall();
    expect(await decide("agent-databases", { env, integrityCheck: "quick" })).toBe("undecidable");
  });
});
