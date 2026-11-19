import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { createCommandWithTimeoutResult } from "./doctor.e2e-harness.test-helpers.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;
const newerSchemaError = /Doctor refused to continue.*database schema.*newer than this build/iu;
const runDoctor = (options: Parameters<typeof doctorCommand>[1] = {}) =>
  doctorCommand(createDoctorRuntime(), options);

afterEach(() => {
  expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
  expect(readConfigFileSnapshot).not.toHaveBeenCalled();
});

beforeEach(async () => {
  vi.resetModules();
  ({ doctorCommand } = await import("./doctor.js"));
  vi.clearAllMocks();
  mockDoctorConfigSnapshot();
});

it("refuses a newer shared database before offering an interactive update", async () => {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
  writeSchemaVersion(statePath, OPENCLAW_STATE_SCHEMA_VERSION + 1);
  mockInteractiveGitUpdate({ status: "ok" });
  const original = fs.readFileSync(statePath);

  await expect(runDoctor()).rejects.toThrow(newerSchemaError);

  expect(confirm).not.toHaveBeenCalled();
  expect(updateCommand).not.toHaveBeenCalled();
  expect(fs.readFileSync(statePath)).toEqual(original);
  expect(fs.readdirSync(path.dirname(statePath))).toEqual([path.basename(statePath)]);
});

it.each([{ status: "ok" }, { status: "skipped", reason: "already-current" }] as const)(
  "hands off newer agent schemas only when the update succeeds ($status)",
  async (outcome) => {
    writeNewerAgentSchema();
    mockInteractiveGitUpdate(outcome);
    if (outcome.status === "ok") {
      await expect(runDoctor()).resolves.toBeUndefined();
    } else {
      await expect(runDoctor()).rejects.toThrow(newerSchemaError);
    }
    expect(updateCommand).toHaveBeenCalledOnce();
  },
);

it("diagnoses an unreadable shared state database", async () => {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "not a sqlite database");

  const failure = await runDoctor({ nonInteractive: true }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toContain(statePath);
  expect(message).toContain("left unchanged");
  expect(message).toContain("restore this file from a verified backup");
  expect(message).toContain("Stop OpenClaw processes");
  expect(message).toMatch(/file is not a database/iu);
  expect(message).not.toContain("openclaw doctor --fix");
  expect(fs.readFileSync(statePath, "utf8")).toBe("not a sqlite database");
});
function mockInteractiveGitUpdate(
  outcome: { status: "ok" } | { status: "skipped"; reason: "already-current" },
): void {
  delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  resolveOpenClawPackageRoot.mockResolvedValue("/repo");
  runCommandWithTimeout.mockResolvedValue(createCommandWithTimeoutResult("/repo\n"));
  updateCommand.mockImplementation(async ({ onResult }) => {
    onResult?.({ ...outcome, mode: "git", root: "/repo", steps: [], durationMs: 0 });
  });
}

function writeNewerAgentSchema(): void {
  openOpenClawStateDatabase(); // Fresh installation before adding the incompatible agent database.
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  writeSchemaVersion(agentPath, OPENCLAW_AGENT_SCHEMA_VERSION + 1);
  registerOpenClawAgentDatabase({ agentId: "main", path: agentPath });
}

function writeSchemaVersion(statePath: string, version: number): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(statePath);
  database.exec(`PRAGMA user_version = ${version};`);
}
