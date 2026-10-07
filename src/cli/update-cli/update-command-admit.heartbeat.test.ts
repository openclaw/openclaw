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

function fixture(scenario: Scenario) {
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
  const database = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
  try {
    database.exec(
      fs.readFileSync(new URL("../../state/openclaw-state-schema.sql", import.meta.url), "utf8"),
    );
    database.exec("PRAGMA user_version=19");
    database.exec("INSERT INTO schema_meta VALUES ('primary','global',19,NULL,'2026.9.8',1,1)");
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
  return { contextPath, snapshot };
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
