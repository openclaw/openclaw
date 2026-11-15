import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as terminalNote from "../../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { retireHeartbeatWithDoctor } from "../../commands/doctor-heartbeat-retirement.js";
import { getDatabaseEngineInput } from "../../infra/database-engine/context.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import { parseUpdateAdmissionVerdict } from "../../infra/update-run-schema.js";
import { defaultRuntime } from "../../runtime.js";
import * as stateReadOnly from "../../state/openclaw-state-db-readonly.js";
import { withLegacyTemplateStateSchema } from "../../state/openclaw-state-db-schema-v36-template-names.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withStateMigrationBackupForTest } from "../../state/openclaw-state-schema.test-support.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import * as schemaPreflight from "./schema-preflight.js";
import { updateAdmitCommand } from "./update-command-admit.js";
import { snapshotUpdateFixtureFiles } from "./update-command-filesystem-snapshot.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const initialExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const source = "Source checklist.\n";
const operatorScratch = "Operator-owned checklist.\n";
const incompleteTasksMessage = "no complete name/interval/prompt entries";

type Scenario = {
  name: string;
  scratch: string;
  source?: string;
  invalidSource?: boolean;
  message?: string;
  retainedSource?: "symlink" | "link";
};

function fixture(scenario: Omit<Scenario, "name">, withDatabase = true) {
  const home = dirs.make("heartbeat-admission-");
  const state = path.join(home, "state");
  const workspace = path.join(home, "workspace");
  const root = path.join(home, "installed");
  for (const directory of [state, workspace, root, path.join(state, "state")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const configPath = path.join(state, "openclaw.json");
  const config = {
    agents: { entries: { main: { workspace, heartbeat: { every: "30m", target: "none" } } } },
  };
  writeFixtureJsonSync(configPath, config);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.8"}');
  const sourcePath = path.join(workspace, "HEARTBEAT.md");
  if (scenario.invalidSource) {
    fs.mkdirSync(sourcePath);
  } else {
    fs.writeFileSync(sourcePath, scenario.source ?? source);
  }
  for (const key of Object.keys(process.env).filter(isUpdateAdmissionAuthorityEnvKey)) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_OAUTH_DIR: undefined,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
    OPENCLAW_WORKSPACE_DIR: undefined,
    OPENCLAW_CONFIG_READONLY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    vi.stubEnv(key, value);
  }
  const context: UpdateAdmissionContext = {
    protocol: 1,
    installation: {
      root,
      canonicalRoot: fs.realpathSync(root),
      version: "2026.9.8",
      installKind: "package",
      packageManager: "npm",
    },
    target: { spec: "openclaw@latest", version: null, source: "registry", channel: "stable" },
    request: { yes: true, noRestart: false, acceptCapabilities: false, json: true },
    run: { id: "heartbeat-admission" },
    supervisor: { version: "2026.9.9", host: "fixture", pid: process.pid },
  };
  const contextPath = path.join(home, "context.json");
  writeFixtureJsonSync(contextPath, context);
  if (withDatabase) {
    using database = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
    database.exec("BEGIN");
    database.exec(
      withLegacyTemplateStateSchema(
        fs.readFileSync(new URL("../../state/openclaw-state-schema.sql", import.meta.url), "utf8"),
      ),
    );
    database.exec("PRAGMA user_version=20");
    database.exec("INSERT INTO schema_meta VALUES ('primary','global',20,NULL,'2026.9.8',1,1)");
    const storeKey = path.join(state, "cron", "jobs.json");
    const jobId = "july-monitor";
    const job = {
      id: jobId,
      name: "Existing monitor",
      agentId: "main",
      declarationKey: "heartbeat:main",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 1_800_000, anchorMs: 37 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "heartbeat" },
      delivery: { mode: "none" },
      state: {},
    };
    database
      .prepare(
        "INSERT INTO cron_jobs (store_key,job_id,declaration_key,name,enabled,agent_id,payload_kind,job_json,updated_at) VALUES (?,?,'heartbeat:main','Existing monitor',1,'main','heartbeat',?,1)",
      )
      .run(storeKey, jobId, JSON.stringify(job));
    database
      .prepare("INSERT INTO cron_job_scratch VALUES (?,?,?,?,NULL,1)")
      .run(storeKey, jobId, scenario.scratch, 4);
    database.exec("COMMIT");
  }
  const snapshot = () => snapshotUpdateFixtureFiles(home);
  return { config, configPath, contextPath, sourcePath, snapshot };
}

async function expectUnchangedHeartbeatAdmission(
  f: ReturnType<typeof fixture>,
  refusalMessage?: string,
) {
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const before = f.snapshot();
  await updateAdmitCommand(f.contextPath);
  expect(output).toHaveBeenCalledOnce();
  const verdict = parseUpdateAdmissionVerdict(output.mock.calls[0]?.[0]);
  expect(process.exitCode).toBe(refusalMessage ? 3 : 0);
  expect(verdict).toMatchObject({
    verdict: refusalMessage ? "refuse" : "admit",
    reasons: refusalMessage
      ? [
          {
            code: "heartbeat-migration",
            message: expect.stringContaining(refusalMessage),
          },
        ]
      : [],
  });
  expect(f.snapshot()).toEqual(before);
  return verdict;
}

it.each(["absent", "file", "unreadable"] as const)(
  "checks unresolved cron update admission (heartbeat source: %s)",
  async (sourceKind) => {
    const f = fixture({
      scratch: source,
      invalidSource: sourceKind === "unreadable",
    });
    writeFixtureJsonSync(f.configPath, {
      agents: { entries: { main: { workspace: path.dirname(f.sourcePath) } } },
    });
    if (sourceKind === "absent") {
      fs.unlinkSync(f.sourcePath);
    }
    {
      using db = new DatabaseSync(resolveOpenClawStateSqlitePath());
      const oldKey = path.join(
        path.dirname(process.env.OPENCLAW_STATE_DIR!),
        "old",
        "cron",
        "jobs.json",
      );
      db.prepare("UPDATE cron_jobs SET store_key = ?").run(oldKey);
      db.prepare("UPDATE cron_job_scratch SET store_key = ?").run(oldKey);
    }
    await expectUnchangedHeartbeatAdmission(
      f,
      sourceKind === "unreadable" ? "regular file" : undefined,
    );
  },
);

it.each<Scenario>([
  { name: "conflicting operator scratch", scratch: operatorScratch },
  { name: "matching operator scratch", scratch: source },
  { name: "completed external symlink", scratch: source, retainedSource: "symlink" },
  { name: "completed hard link", scratch: source, retainedSource: "link" },
  {
    name: "incomplete tasks in a retained source beside operator scratch",
    scratch: operatorScratch,
    source: "tasks:\n- name: retained\n  interval: 1h\n",
  },
  {
    name: "unreadable source shape",
    scratch: operatorScratch,
    invalidSource: true,
    message: "regular file",
  },
])("checks $name before update activation without changing input", async (scenario) => {
  const f = fixture(scenario);
  if (scenario.retainedSource) {
    writeFixtureJsonSync(
      f.configPath,
      await withStateMigrationBackupForTest({}, () => retireHeartbeatWithDoctor(f.config)),
    );
    const target = path.join(path.dirname(f.configPath), "outside.md");
    fs.writeFileSync(target, "Outside notes: do not import.\n");
    if (fs.existsSync(f.sourcePath)) {
      fs.unlinkSync(f.sourcePath);
    }
    fs[scenario.retainedSource === "link" ? "linkSync" : "symlinkSync"](target, f.sourcePath);
  }
  const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const verdict = await expectUnchangedHeartbeatAdmission(f, scenario.message);
  expect(verdict).toMatchObject({ protocol: 1 });
  expect(errors).not.toHaveBeenCalled();

  if (scenario.scratch === operatorScratch && !scenario.invalidSource) {
    const notes = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
    const next = await withStateMigrationBackupForTest({}, () =>
      retireHeartbeatWithDoctor(f.config),
    );
    expect(next.agents?.entries?.main?.heartbeat).toBeUndefined();
    expect(fs.readFileSync(f.sourcePath)).toEqual(Buffer.from(scenario.source ?? source));
    using database = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
    expect(database.prepare("SELECT * FROM cron_job_scratch").all()).toEqual([
      {
        store_key: path.join(path.dirname(f.configPath), "cron", "jobs.json"),
        job_id: "july-monitor",
        content: operatorScratch,
        revision: 4,
        source_sha256: null,
        updated_at_ms: 1,
      },
    ]);
    expect(database.prepare("SELECT job_id, payload_kind FROM cron_jobs").all()).toEqual([
      { job_id: "july-monitor", payload_kind: "agentTurn" },
    ]);
    for (const message of ["different cron scratch", "HEARTBEAT.md was retained for review"]) {
      expect(notes).toHaveBeenCalledWith(expect.stringContaining(message), "Doctor notices");
    }
  }
});

it.each([
  "supported",
  "reported defaults",
  "unsafe TMPDIR",
  "invalid projected model policy",
  "duplicate default markers",
  "retired July reasoning",
  "unrelated invalid field",
  "invalid heartbeat",
  "read-only",
  "future-written",
  "included",
  "changed source",
] as const)("inspects %s heartbeat config without changing live data", async (kind) => {
  const f = fixture({ scratch: source }, kind === "unsafe TMPDIR");
  const reported =
    kind === "reported defaults" ||
    kind === "unsafe TMPDIR" ||
    kind === "invalid projected model policy";
  const heartbeat = reported
    ? {
        every: "1h",
        activeHours: { start: "08:00", end: "22:00", timezone: "local" },
        model: "deepseek/deepseek-v4-flash",
        lightContext: true,
        isolatedSession: true,
      }
    : {
        every: kind === "invalid heartbeat" ? "private-invalid-value" : "30m",
        ...(kind === "retired July reasoning" ? { includeReasoning: true } : {}),
        target: "none",
      };
  const agents =
    kind === "duplicate default markers"
      ? {
          defaults: { heartbeat: { every: "1h" } },
          entries: { main: { default: true }, ops: { default: true } },
        }
      : reported
        ? {
            defaults: {
              heartbeat,
              ...(kind === "invalid projected model policy"
                ? { modelPolicy: { allow: ["private-invalid-value"] } }
                : {}),
            },
          }
        : { entries: { main: { heartbeat } } };
  if (kind === "included") {
    writeFixtureJsonSync(path.join(path.dirname(f.configPath), "agents.json"), agents);
  }
  writeFixtureJsonSync(f.configPath, {
    agents: kind === "included" ? { $include: "agents.json" } : agents,
    ...(reported ? { meta: { lastTouchedVersion: "2026.10.10" } } : {}),
    ...(kind === "retired July reasoning"
      ? { meta: { lastTouchedVersion: "2026.7.1-beta.1" } }
      : {}),
    ...(kind === "unrelated invalid field" ? { gateway: { port: "private-invalid-value" } } : {}),
    ...(kind === "future-written" ? { meta: { lastTouchedVersion: "9999.1.1" } } : {}),
  });
  vi.stubEnv("OPENCLAW_CONFIG_READONLY", kind === "read-only" ? "1" : undefined);
  vi.stubEnv("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS", undefined);
  if (kind === "unsafe TMPDIR") {
    const tmp = path.join(path.dirname(f.configPath), "unsafe-tmp");
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o777);
    vi.stubEnv("TMPDIR", tmp);
  }
  fs.writeFileSync(`${f.configPath}.bak`, "retained pre-upgrade backup\n");
  let before = f.snapshot();
  if (kind === "changed source") {
    const capture = schemaPreflight.captureTargetDatabaseSchemaContext;
    vi.spyOn(schemaPreflight, "captureTargetDatabaseSchemaContext").mockImplementationOnce(
      async (...args) => {
        writeFixtureJsonSync(f.configPath, { agents, gateway: { port: "private-invalid-value" } });
        before = f.snapshot();
        return capture(...args);
      },
    );
  }
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const preflight = vi.spyOn(schemaPreflight, "captureTargetDatabaseSchemaContext");

  await updateAdmitCommand(f.contextPath);

  expect(output).toHaveBeenCalledOnce();
  const verdict = parseUpdateAdmissionVerdict(output.mock.calls[0]?.[0]);
  const admitted =
    kind === "supported" ||
    kind === "retired July reasoning" ||
    (reported && kind !== "invalid projected model policy");
  expect(verdict).toMatchObject(
    admitted
      ? {
          verdict: "admit",
          reasons: [],
          warnings: [{ code: "config-warning", message: expect.stringContaining("legacy fields") }],
          facts: {
            checks: expect.arrayContaining([
              { name: "config", status: "warn" },
              { name: "database-schema", status: "ok" },
            ]),
          },
        }
      : {
          verdict: "refuse",
          reasons: [expect.objectContaining({ code: "invalid-config" })],
        },
  );
  expect(process.exitCode).toBe(admitted ? 0 : 3);
  if (!admitted) {
    expect(verdict?.facts.checks.map(({ name }) => name)).toEqual(["config", "node-runtime"]);
  }
  if (kind === "invalid projected model policy") {
    expect(verdict?.reasons[0]?.message).toContain("agents.defaults.modelPolicy.allow.0");
  }
  if (kind === "duplicate default markers") {
    expect(verdict?.reasons[0]?.message.match(/^- .+/gm)).toEqual([
      "- agents.entries: Invalid configuration field",
    ]);
    await expect(preflight.mock.results[0]?.value).rejects.toMatchObject({
      failureFacts: [{ affectedKey: "agents.entries", message: "Invalid configuration field" }],
    });
  }
  expect(JSON.stringify(output.mock.calls)).not.toContain("private-invalid-value");
  expect(errors).not.toHaveBeenCalled();
  expect(f.snapshot()).toEqual(before);
  expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(kind === "unsafe TMPDIR");
});

it.each([
  ["file", false],
  ["imported scratch", false],
  ["file", true],
  ["imported scratch", true],
] as const)(
  "checks task conversion in %s (incomplete: %s) before activation without mutating the source",
  async (location, incomplete) => {
    const content = incomplete
      ? "tasks:\n- name: inbox\n  interval: 1h\n"
      : "# Checklist\n\ntasks:\n- check the queue\n- review alerts\n";
    const f = fixture({ scratch: content }, location === "imported scratch");
    if (location === "file") {
      fs.writeFileSync(f.sourcePath, content);
    } else {
      fs.unlinkSync(f.sourcePath);
    }
    await expectUnchangedHeartbeatAdmission(f, incomplete ? incompleteTasksMessage : undefined);
  },
);

it.each([false, true])(
  "inspects configured PostgreSQL heartbeat scratch before activation (incomplete: %s)",
  async (incomplete) => {
    const f = fixture({
      scratch: incomplete ? "tasks:\n- name: inbox\n  interval: 1h\n" : source,
    });
    fs.unlinkSync(f.sourcePath);
    const anchorPath = resolveOpenClawStateSqlitePath();
    const storePath = path.join(path.dirname(anchorPath), "postgres-fixture.sqlite");
    fs.renameSync(anchorPath, storePath);
    const anchor = new DatabaseSync(anchorPath);
    anchor.exec("CREATE TABLE openclaw_engine_anchor (engine TEXT)");
    anchor.close();
    vi.stubEnv("TEST_DATABASE_DSN", "postgresql://127.0.0.1:1/heartbeat_admission");
    writeFixtureJsonSync(f.configPath, {
      ...f.config,
      database: {
        engine: "postgres",
        postgres: {
          connection: { source: "env", provider: "default", id: "TEST_DATABASE_DSN" },
        },
      },
    });
    vi.spyOn(schemaPreflight, "checkTargetDatabaseSchemasForContexts").mockResolvedValue({
      incompatible: [],
      indeterminate: [],
    });
    // Substitute only storage transport; run the real heartbeat queries against retained rows.
    const readStore: typeof stateReadOnly.withExistingOpenClawStateDatabaseReadOnly = (
      operation,
    ) => {
      const selectedPath = getDatabaseEngineInput("state") ? storePath : anchorPath;
      const db = new DatabaseSync(selectedPath, { readOnly: true });
      try {
        return operation({ db, path: selectedPath });
      } finally {
        db.close();
      }
    };
    // Cron path selection still reads its machine-state key through the native reader.
    vi.spyOn(stateReadOnly, "withExistingOpenClawStateDatabaseReadOnly").mockImplementation(
      readStore,
    );
    vi.spyOn(
      stateReadOnly,
      "withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync",
    ).mockImplementation(async (operation) => readStore(operation));
    await expectUnchangedHeartbeatAdmission(f, incomplete ? incompleteTasksMessage : undefined);
  },
);
