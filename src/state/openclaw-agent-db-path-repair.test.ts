import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteDoctorAgentDatabasePathHealth } from "../commands/doctor-agent-database-paths.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function fixture() {
  const root = tempDirs.make("openclaw-doctor-sentinel-");
  const env = { OPENCLAW_STATE_DIR: root };
  const state = openOpenClawStateDatabase({ env });
  const register = (basename: string) => {
    const pathname = path.join(root, basename);
    state.db.prepare("INSERT INTO agent_databases VALUES ('main', ?, 26, 1, 0)").run(pathname);
    return pathname;
  };
  const registeredPaths = () => state.db.prepare("SELECT path FROM agent_databases").all();
  return { root, env, state, register, registeredPaths };
}

describe("Doctor agent database path repair", () => {
  it("removes sentinel registrations on every platform, deleting only empty files", () => {
    const f = fixture();
    const empty = openOpenClawAgentDatabase({
      env: f.env,
      agentId: "main",
      path: path.join(f.root, "(multiple).main.sqlite"),
    });
    const emptyPath = empty.path;
    closeOpenClawAgentDatabasesForTest();
    const populatedPath = f.register("(multiple).main.2.sqlite");
    const populated = openOpenClawAgentDatabase({
      env: f.env,
      agentId: "main",
      path: populatedPath,
    });
    populated.db.exec(
      "CREATE TABLE retained_payload (value TEXT); INSERT INTO retained_payload VALUES ('keep')",
    );
    closeOpenClawAgentDatabasesForTest();
    const populatedBytes = fs.readFileSync(populatedPath);
    const unreadablePath = f.register("(multiple).sqlite");
    fs.writeFileSync(unreadablePath, "not a database");
    f.register("(multiple).main.3.sqlite");
    const zeroBytePath = f.register("(multiple).main.4.sqlite");
    fs.writeFileSync(zeroBytePath, "");
    const journalPath = f.register("(multiple).main.5.sqlite");
    fs.writeFileSync(journalPath, "");
    fs.writeFileSync(`${journalPath}-wal`, "retained journal");
    f.register("ordinary.sqlite");

    const warnings = noteDoctorAgentDatabasePathHealth({ env: f.env, shouldRepair: true });

    expect(f.registeredPaths()).toEqual([{ path: path.join(f.root, "ordinary.sqlite") }]);
    expect(fs.existsSync(emptyPath)).toBe(false);
    expect(fs.existsSync(zeroBytePath)).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.readFileSync(`${journalPath}-wal`, "utf8")).toBe("retained journal");
    expect(fs.readFileSync(populatedPath)).toEqual(populatedBytes);
    expect(fs.readFileSync(unreadablePath, "utf8")).toBe("not a database");
    expect(warnings.join("\n")).toContain(populatedPath);
    expect(warnings.join("\n")).toContain(unreadablePath);
    expect(warnings.join("\n")).toContain(journalPath);
    expect(noteDoctorAgentDatabasePathHealth({ env: f.env, shouldRepair: true })).toEqual([]);
  });

  it("preserves the captured registry and files during active and candidate updates", () => {
    const f = fixture();
    const pathname = f.register("(multiple).sqlite");
    fs.writeFileSync(pathname, "");
    const before = f.registeredPaths();
    const run = createUpdateRun({ trigger: "cli" }, { env: f.env });
    expect(noteDoctorAgentDatabasePathHealth({ env: f.env, shouldRepair: true })).toEqual([
      expect.stringContaining(`update ${run.runId} is in progress`),
    ]);
    expect(f.registeredPaths()).toEqual(before);
    expect(fs.existsSync(pathname)).toBe(true);
    finishUpdateRun(run.runId, { status: "succeeded" }, { env: f.env });
    expect(
      noteDoctorAgentDatabasePathHealth({
        env: { ...f.env, OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" },
        shouldRepair: true,
      }),
    ).toEqual([expect.stringContaining("during update Doctor")]);
    expect(f.registeredPaths()).toEqual(before);
    expect(fs.existsSync(pathname)).toBe(true);
  });
});
