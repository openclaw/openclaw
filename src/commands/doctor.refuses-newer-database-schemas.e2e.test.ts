import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  autoMigrateLegacyStateDir,
  confirm,
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  readConfigFileSnapshot,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  updateCommand,
} from "./doctor.e2e-harness.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;
const newerSchemaError = /Doctor refused to continue.*database schema.*newer than this build/iu;
const runDoctor = () => doctorCommand(createDoctorRuntime());

function expectNoMigration() {
  expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
  expect(readConfigFileSnapshot).not.toHaveBeenCalled();
}

describe("doctor database schema preflight", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ doctorCommand } = await import("./doctor.js"));
    vi.clearAllMocks();
    mockDoctorConfigSnapshot();
  });

  it("refuses a newer shared database before offering an interactive update", async () => {
    writeSchemaVersion(
      resolveOpenClawStateSqlitePath(process.env),
      OPENCLAW_STATE_SCHEMA_VERSION + 1,
    );
    mockInteractiveGitUpdate({ status: "ok" });
    const statePath = resolveOpenClawStateSqlitePath(process.env);
    const original = fs.readFileSync(statePath);

    await expect(runDoctor()).rejects.toThrow(newerSchemaError);

    expect(confirm).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
    expectNoMigration();
    expect(fs.readFileSync(statePath)).toEqual(original);
    expect(fs.readdirSync(path.dirname(statePath))).toEqual([path.basename(statePath)]);
  });

  it("lets a successful interactive update replace Doctor with newer agent schemas", async () => {
    writeNewerAgentSchema();
    mockInteractiveGitUpdate({ status: "ok" });

    await expect(runDoctor()).resolves.toBeUndefined();

    expect(updateCommand).toHaveBeenCalledOnce();
    expectNoMigration();
  });

  it("refuses newer agent schemas after an interactive update reports already-current", async () => {
    writeNewerAgentSchema();
    mockInteractiveGitUpdate({ status: "skipped", reason: "already-current" });

    await expect(runDoctor()).rejects.toThrow(newerSchemaError);

    expect(updateCommand).toHaveBeenCalledOnce();
    expectNoMigration();
  });

  it("diagnoses an unreadable shared state database", async () => {
    const statePath = resolveOpenClawStateSqlitePath(process.env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "not a sqlite database");

    const failure = await doctorCommand(createDoctorRuntime(), { nonInteractive: true }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(statePath);
    expect(message).toContain("left unchanged");
    expect(message).toContain("restore this file from a verified backup");
    expect(message).toContain("Stop OpenClaw processes");
    expect(message).toMatch(/file is not a database/iu);
    expect(message).not.toContain("openclaw doctor --fix");
    expect(fs.readFileSync(statePath, "utf8")).toBe("not a sqlite database");
    expectNoMigration();
  });
});

function mockInteractiveGitUpdate(
  outcome: { status: "ok" } | { status: "skipped"; reason: "already-current" },
): void {
  delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  resolveOpenClawPackageRoot.mockResolvedValue("/repo");
  runCommandWithTimeout.mockResolvedValue({
    stdout: "/repo\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });
  updateCommand.mockImplementation(async ({ onResult }) => {
    onResult?.({ ...outcome, mode: "git", root: "/repo", steps: [], durationMs: 0 });
  });
}

function writeNewerAgentSchema(): void {
  // Establish a fresh installation before adding the incompatible agent database.
  openOpenClawStateDatabase();
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  writeSchemaVersion(agentPath, OPENCLAW_AGENT_SCHEMA_VERSION + 1);
  registerOpenClawAgentDatabase({ agentId: "main", path: agentPath });
}

function writeSchemaVersion(statePath: string, version: number): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(statePath);
  try {
    database.exec(`PRAGMA user_version = ${version};`);
  } finally {
    database.close();
  }
}
