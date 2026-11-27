import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import * as processRole from "../infra/database-engine/admission-scope.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createTrialPending, resolvePrefix, writeTrial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { withLiveStateReads } from "./artifact-preserving-state-reads.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db-cache.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { upgradeStateOnGatewayStart } from "./state-upgrade-startup.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

it.each([
  { name: "without a key", apiKey: undefined, layout: "inline", trial: false },
  { name: "with a key", apiKey: "synthetic-provider-key", layout: "inline", trial: false },
  { name: "beside an external config", apiKey: undefined, layout: "external", trial: false },
  { name: "inside the workspace", apiKey: undefined, layout: "workspace", trial: false },
  { name: "with a missing include", apiKey: undefined, layout: "missing", trial: false },
  { name: "during a managed trial", apiKey: undefined, layout: "inline", trial: true },
])(
  "reopens published state after provider config admission $name",
  async ({ apiKey, layout, trial }) => {
    vi.spyOn(processRole, "getDatabaseProcessRole").mockReturnValue("gateway");
    const root = dirs.make("state-upgrade-reader-");
    const stateDir = path.join(root, "state");
    const configDir = layout === "external" ? path.join(root, "config") : stateDir;
    const workspace = path.join(stateDir, "workspace");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
      OPENCLAW_LAUNCHER_IPC: trial ? "1" : undefined,
    };
    const models = {
      providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] } },
    };
    const include = layout === "external" ? "models.json" : "workspace/models.json";
    const includePath = path.join(configDir, include);
    if (layout !== "inline" && layout !== "missing") {
      fs.writeFileSync(includePath, JSON.stringify(models));
    }
    const authored = JSON.stringify({
      gateway: { mode: "local" },
      agents: { defaults: { workspace } },
      models: layout === "inline" ? models : { $include: include },
    });
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, authored);
    fs.mkdirSync(path.join(stateDir, "state"));
    {
      using db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(getOpenClawStatePredecessorSchema(41));
      db.exec(`PRAGMA user_version = 41;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 41, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);`);
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "auth.sharedStore",
        JSON.stringify({ location: "state-db" }),
        1,
      );
    }
    const target = path.join("releases", "startup-release", "openclaw");
    const manifestFile = path.join(resolvePrefix(env), "releases", "startup-release", ".restore");
    if (trial) {
      fs.mkdirSync(path.join(resolvePrefix(env), target), { recursive: true });
      const pending = await createTrialPending(
        {
          runId: "startup-trial",
          target,
          previous: stateDir,
          version: VERSION,
          buildId: resolveRuntimeServiceBuildId() ?? undefined,
        },
        resolvePrefix(env),
      );
      await writeTrial({ ...pending, phase: "trial" }, resolvePrefix(env));
    }

    await withLiveStateReads(async () => {
      if (layout === "missing") {
        await expect(
          upgradeStateOnGatewayStart(env, ({ mode }) => mode === "local"),
        ).rejects.toMatchObject({
          code: 78,
        });
        using original = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
        expect(original.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 41,
        });
        expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(authored);
        return;
      }
      await upgradeStateOnGatewayStart(env, ({ mode }) => mode === "local");
      expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
      expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(authored);
      if (layout !== "inline") {
        expect(fs.readFileSync(includePath, "utf8")).toBe(JSON.stringify(models));
      }
      if (trial) {
        const encoded = fs.readFileSync(manifestFile, "utf8");
        const manifest = JSON.parse(encoded);
        expect(manifest.runId).toBe("startup-trial");
        const previous = manifest.files.find(
          (entry: { live: string }) =>
            entry.live === path.join(stateDir, "state", "openclaw.sqlite"),
        ).preimage;
        using original = new DatabaseSync(previous, { readOnly: true });
        expect(original.prepare("PRAGMA user_version").get()?.user_version).toBe(41);
        await upgradeStateOnGatewayStart(env, () => true);
        expect(fs.readFileSync(manifestFile, "utf8")).toBe(encoded);
      } else {
        expect(fs.existsSync(manifestFile)).toBe(false);
      }
      // Startup reopens the published database in WAL mode before preparing secrets.
      using runtime = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      runtime.exec("PRAGMA journal_mode = WAL");
      await expect(prepareSharedAuthStoreOwnership(env)).resolves.toEqual({ location: "state-db" });
    });
  },
);

it.each([
  { admits: true, pendingCronAccount: false, olderRestore: false },
  { admits: false, pendingCronAccount: false, olderRestore: false },
  { admits: true, pendingCronAccount: true, olderRestore: false },
  { admits: true, pendingCronAccount: true, olderRestore: true },
])(
  "publishes the trial plan for a current schema (admitted=$admits, pending cron account=$pendingCronAccount, older restore=$olderRestore)",
  async ({ admits, pendingCronAccount, olderRestore }) => {
    const stateDir = dirs.make("state-upgrade-empty-restore-");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_LAUNCHER_IPC: "1",
    };
    openClientCredentialCustody(env, { createIfMissing: true })?.close();
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, '{"gateway":{"mode":"local"}}');
    fs.mkdirSync(path.join(stateDir, "state"));
    const file = path.join(stateDir, "state", "openclaw.sqlite");
    const legacyJob = {
      id: "legacy-job",
      name: "Legacy job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      delivery: { mode: "none" },
      payload: { kind: "agentTurn", message: "Fixture" },
      inferenceBinding: {
        version: 1,
        provider: "openai",
        profileId: "openai:retired",
        authorizationId: "a".repeat(64),
        authRequirement: "api-key",
        source: "auto",
      },
    };
    {
      using db = new DatabaseSync(file);
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 1);`);
      runSqliteImmediateTransactionSync(db, () =>
        bindFreshClientCredentialStore(db, { env, path: file }),
      );
      if (pendingCronAccount) {
        db.prepare(
          `INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, updated_at)
           VALUES ('cron-default', ?, ?, 1, 'agentTurn', ?, 1)`,
        ).run(legacyJob.id, legacyJob.name, JSON.stringify(legacyJob));
      }
    }
    const original = fs.readFileSync(file);
    const target = path.join("releases", "empty-release", "openclaw");
    fs.mkdirSync(path.join(resolvePrefix(env), target), { recursive: true });
    const pending = await createTrialPending(
      {
        runId: "empty-trial",
        target,
        previous: stateDir,
        version: VERSION,
        buildId: resolveRuntimeServiceBuildId() ?? undefined,
      },
      resolvePrefix(env),
    );
    await writeTrial({ ...pending, phase: "trial" }, resolvePrefix(env));
    const manifest = path.join(resolvePrefix(env), "releases", "empty-release", ".restore");
    const currentJob = olderRestore ? { ...legacyJob, name: "Current legacy job" } : legacyJob;
    if (olderRestore) {
      await upgradeStateOnGatewayStart(env, () => true);
      using live = new DatabaseSync(file);
      live
        .prepare("UPDATE cron_jobs SET name = ?, enabled = 1, job_json = ?")
        .run(currentJob.name, JSON.stringify(currentJob));
      await writeTrial({ ...pending, phase: "trial", runId: "next-trial" }, resolvePrefix(env));
    }
    await upgradeStateOnGatewayStart(env, () => admits);
    if (pendingCronAccount) {
      const { inferenceBinding: _legacyBinding, ...definition } = currentJob;
      using migrated = new DatabaseSync(file, { readOnly: true });
      expect(migrated.prepare("SELECT job_json FROM cron_jobs").get()?.job_json).toBe(
        JSON.stringify({
          ...definition,
          enabled: false,
          inferenceAccountPauseReason:
            "Paused because the current model no longer matches the saved account’s provider. Review its model and account before enabling it.",
        }),
      );
      const restore = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const preimage = restore.files.find(
        (entry: { live: string }) => entry.live === file,
      )?.preimage;
      expect(preimage).toEqual(expect.any(String));
      using previous = new DatabaseSync(preimage, { readOnly: true });
      expect(previous.prepare("SELECT job_json FROM cron_jobs").get()?.job_json).toBe(
        JSON.stringify(legacyJob),
      );
      const backups = fs
        .readdirSync(path.dirname(file))
        .filter((name) => name.startsWith("openclaw.sqlite.pre-"));
      if (olderRestore) {
        const doctorBackup = backups.find((name) => name !== path.basename(preimage));
        expect(backups).toHaveLength(2);
        expect(doctorBackup).toBeDefined();
        using fresh = new DatabaseSync(path.join(path.dirname(file), doctorBackup!), {
          readOnly: true,
        });
        expect(fresh.prepare("SELECT job_json FROM cron_jobs").get()?.job_json).toBe(
          JSON.stringify(currentJob),
        );
      } else {
        expect(backups).toEqual([path.basename(preimage)]);
      }
      return;
    }
    if (admits) {
      expect(JSON.parse(fs.readFileSync(manifest, "utf8"))).toEqual({
        v: 1,
        runId: "empty-trial",
        files: [],
      });
    } else {
      expect(fs.existsSync(manifest)).toBe(false);
    }
    expect(fs.readFileSync(file)).toEqual(original);
  },
);
