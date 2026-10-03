import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  writeExecApprovalsConfigRow,
  readExecApprovalsConfigRow,
} from "../infra/exec-approvals-sqlite.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  runApprovalsCommand,
  loggedOutput,
  resetExecApprovalsCliMocks,
  callGatewayFromCli,
} from "./exec-approvals-cli.test-support.js";

describe("local approvals reconciliation", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      cleanup();
    });
  });
  beforeEach(resetExecApprovalsCliMocks);

  it("previews without mutation, then explicitly keeps current policy through the registered command", async () => {
    const stateDir = tempDirs.make("approvals-reconcile-cli-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const db = openOpenClawStateDatabase().db;
    writeExecApprovalsConfigRow({
      db,
      file: { version: 1, defaults: { security: "deny" }, agents: {} },
    });
    const originalRow = readExecApprovalsConfigRow(db);
    const sourcePath = path.join(stateDir, "exec-approvals.json");
    const legacy = JSON.stringify({
      version: 1,
      defaults: { security: "full" },
      socket: { token: "synthetic-cli-secret" },
      agents: {},
    });
    fs.writeFileSync(sourcePath, legacy);

    await runApprovalsCommand(["approvals", "reconcile", "--json"]);
    expect(JSON.parse(loggedOutput())).toMatchObject({ pending: true, policyMatches: false });
    expect(loggedOutput()).not.toContain("synthetic-cli-secret");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(legacy);
    expect(readExecApprovalsConfigRow(db)).toEqual(originalRow);

    resetExecApprovalsCliMocks();
    await runApprovalsCommand(["approvals", "reconcile", "--keep-current", "--json"]);
    expect(JSON.parse(loggedOutput())).toMatchObject({
      warnings: [],
      changes: [expect.stringContaining("Preserved current SQLite")],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(readExecApprovalsConfigRow(db)).toEqual(originalRow);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    const archive = fs
      .readdirSync(stateDir)
      .find((name) => name.startsWith("exec-approvals.json.migrated."));
    expect(fs.readFileSync(path.join(stateDir, archive!), "utf8")).toBe(legacy);
  });

  it("does not recommend keeping a missing current policy", async () => {
    const stateDir = tempDirs.make("approvals-reconcile-no-current-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const sourcePath = path.join(stateDir, "exec-approvals.json");
    const legacy = JSON.stringify({ version: 1, defaults: { security: "deny" } });
    fs.writeFileSync(sourcePath, legacy);
    await runApprovalsCommand(["approvals", "reconcile"]);
    expect(loggedOutput()).toContain("No valid current SQLite policy");
    expect(loggedOutput()).not.toContain("reconcile --keep-current");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(legacy);
    expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
  });

  it("does not bootstrap SQLite when no legacy policy exists", async () => {
    const stateDir = tempDirs.make("approvals-reconcile-absent-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    await runApprovalsCommand(["approvals", "reconcile", "--json"]);
    expect(JSON.parse(loggedOutput())).toMatchObject({ pending: false });
    expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
  });
});
