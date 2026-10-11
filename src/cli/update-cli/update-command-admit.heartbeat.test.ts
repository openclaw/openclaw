import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import { parseUpdateAdmissionVerdict } from "../../infra/update-run-schema.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as schemaPreflight from "./schema-preflight.js";
import { updateAdmitCommand } from "./update-command-admit.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const initialExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const source = "Source checklist.\n";
const operatorScratch = "Operator-owned checklist.\n";

type Scenario = {
  name: string;
  scratch: string;
  invalidSource?: boolean;
  message?: string;
};

function fixture(scenario: Scenario, withDatabase = true) {
  const home = dirs.make("heartbeat-admission-");
  const state = path.join(home, "state");
  const workspace = path.join(home, "workspace");
  const root = path.join(home, "installed");
  for (const directory of [state, workspace, root, path.join(state, "state")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const configPath = path.join(state, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { entries: { main: { workspace, heartbeat: { every: "30m", target: "none" } } } },
    }),
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.8"}');
  const sourcePath = path.join(workspace, "HEARTBEAT.md");
  if (scenario.invalidSource) {
    fs.mkdirSync(sourcePath);
  } else {
    fs.writeFileSync(sourcePath, source);
  }
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
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
  fs.writeFileSync(contextPath, JSON.stringify(context));
  if (withDatabase) {
    const database = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
    try {
      database.exec(
        fs.readFileSync(new URL("../../state/openclaw-state-schema.sql", import.meta.url), "utf8"),
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
    } finally {
      database.close();
    }
  }
  const snapshot = () =>
    fs
      .readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return [
          path.relative(home, filename),
          fs.readFileSync(filename).toString("hex"),
          fs.statSync(filename).mode,
        ];
      });
  return { configPath, contextPath, snapshot };
}

it.each<Scenario>([
  {
    name: "conflicting operator scratch",
    scratch: operatorScratch,
    message: "different cron scratch",
  },
  { name: "matching operator scratch", scratch: source },
  {
    name: "unreadable source shape",
    scratch: operatorScratch,
    invalidSource: true,
    message: "regular file",
  },
])("checks $name before update activation without changing input", async (scenario) => {
  const f = fixture(scenario);
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const before = f.snapshot();

  await updateAdmitCommand(f.contextPath);

  expect(output).toHaveBeenCalledOnce();
  const verdict = parseUpdateAdmissionVerdict(output.mock.calls[0]?.[0]);
  expect(verdict).not.toBeNull();
  expect(process.exitCode).toBe(scenario.message ? 3 : 0);
  expect(verdict).toMatchObject({
    protocol: 1,
    verdict: scenario.message ? "refuse" : "admit",
    reasons: scenario.message
      ? [
          expect.objectContaining({
            code: "heartbeat-migration",
            message: expect.stringContaining(scenario.message),
          }),
        ]
      : [],
  });
  expect(errors).not.toHaveBeenCalled();
  expect(f.snapshot()).toEqual(before);
});

it.each([
  "supported",
  "retired July reasoning",
  "unrelated invalid field",
  "invalid heartbeat",
  "read-only",
  "future-written",
  "included",
  "changed source",
] as const)("inspects %s heartbeat config without changing live data", async (kind) => {
  const f = fixture({ name: kind, scratch: source }, false);
  const agents = {
    entries: {
      main: {
        heartbeat: {
          every: kind === "invalid heartbeat" ? "private-invalid-value" : "30m",
          ...(kind === "retired July reasoning" ? { includeReasoning: true } : {}),
          target: "none",
        },
      },
    },
  };
  if (kind === "included") {
    fs.writeFileSync(path.join(path.dirname(f.configPath), "agents.json"), JSON.stringify(agents));
  }
  fs.writeFileSync(
    f.configPath,
    JSON.stringify({
      agents: kind === "included" ? { $include: "agents.json" } : agents,
      ...(kind === "retired July reasoning"
        ? { meta: { lastTouchedVersion: "2026.7.1-beta.1" } }
        : {}),
      ...(kind === "unrelated invalid field" ? { gateway: { port: "private-invalid-value" } } : {}),
      ...(kind === "future-written" ? { meta: { lastTouchedVersion: "9999.1.1" } } : {}),
    }),
  );
  vi.stubEnv("OPENCLAW_CONFIG_READONLY", kind === "read-only" ? "1" : undefined);
  vi.stubEnv("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS", undefined);
  fs.writeFileSync(`${f.configPath}.bak`, "retained pre-upgrade backup\n");
  let before = f.snapshot();
  if (kind === "changed source") {
    const capture = schemaPreflight.captureTargetDatabaseSchemaContext;
    vi.spyOn(schemaPreflight, "captureTargetDatabaseSchemaContext").mockImplementationOnce(
      async (...args) => {
        fs.writeFileSync(
          f.configPath,
          JSON.stringify({ agents, gateway: { port: "private-invalid-value" } }),
        );
        before = f.snapshot();
        return capture(...args);
      },
    );
  }
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

  await updateAdmitCommand(f.contextPath);

  expect(output).toHaveBeenCalledOnce();
  const verdict = parseUpdateAdmissionVerdict(output.mock.calls[0]?.[0]);
  const admitted = kind === "supported" || kind === "retired July reasoning";
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
  expect(JSON.stringify(output.mock.calls)).not.toContain("private-invalid-value");
  expect(errors).not.toHaveBeenCalled();
  expect(f.snapshot()).toEqual(before);
  expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
});
