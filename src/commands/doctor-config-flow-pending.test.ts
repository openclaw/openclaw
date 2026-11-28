import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { prepareDoctorAgentDatabaseDiscovery } from "../infra/state-migrations.doctor-discovery.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
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
        "legacy-state-steps",
        "a2ui-widgets",
        "relative-session-stores",
        "update-history",
        "config-repairs",
      ].map((id) => `config-flow.${id}`),
      "config-flow",
    ]);
    // An input without a read-only predicate is work, so the step cannot answer none.
    for (const step of ["legacy-state-steps", "update-history", "config-repairs"]) {
      expect([step, traced.get(`config-flow.${step}`)]).toEqual([step, "work"]);
    }
    expect(traced.get("config-flow.agent-databases")).toBe("none");
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
      "relative-session-stores",
    ]) {
      expect([id, await decide(id, params)]).toEqual([id, "undecidable"]);
    }
    expect(storeFiles.listSqliteSidecars(stateDir)).toEqual([]);
    expect(storeFiles.changedStoreFiles(before, storeFiles.snapshotStoreFiles(stateDir))).toEqual(
      [],
    );
  });

  it("leaves the agent database plan undecidable without the preflight's discovery", async () => {
    const { env } = makeInstall();
    expect(await decide("agent-databases", { env, integrityCheck: "quick" })).toBe("undecidable");
  });
});
