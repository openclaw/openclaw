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
  const open = (basename: string) =>
    openOpenClawAgentDatabase({ env, agentId: "main", path: path.join(root, basename) });
  const repair = (overrides: NodeJS.ProcessEnv = {}) =>
    noteDoctorAgentDatabasePathHealth({ env: { ...env, ...overrides }, shouldRepair: true });
  return { root, env, register, registeredPaths, open, repair };
}

describe("Doctor agent database path repair", () => {
  it("removes sentinel registrations on every platform, deleting only empty files", () => {
    const f = fixture();
    const emptyPath = f.open("(multiple).main.sqlite").path;
    closeOpenClawAgentDatabasesForTest();
    const populatedPath = f.register("(multiple).main.2.sqlite");
    const populated = f.open(path.basename(populatedPath));
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

    const warnings = f.repair().join("\n");

    expect(f.registeredPaths()).toEqual([{ path: path.join(f.root, "ordinary.sqlite") }]);
    expect(fs.existsSync(emptyPath)).toBe(false);
    expect(fs.existsSync(zeroBytePath)).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.readFileSync(`${journalPath}-wal`, "utf8")).toBe("retained journal");
    expect(fs.readFileSync(populatedPath)).toEqual(populatedBytes);
    expect(fs.readFileSync(unreadablePath, "utf8")).toBe("not a database");
    expect(warnings).toContain(populatedPath);
    expect(warnings).toContain(unreadablePath);
    expect(warnings).toContain(journalPath);
    expect(f.repair()).toEqual([]);
  });

  it("preserves the captured registry and files during active and candidate updates", () => {
    const f = fixture();
    const pathname = f.register("(multiple).sqlite");
    fs.writeFileSync(pathname, "");
    const before = f.registeredPaths();
    const run = createUpdateRun({ trigger: "cli" }, { env: f.env });
    expect(f.repair()).toEqual([expect.stringContaining(`update ${run.runId} is in progress`)]);
    expect(f.registeredPaths()).toEqual(before);
    expect(fs.existsSync(pathname)).toBe(true);
    finishUpdateRun(run.runId, { status: "succeeded" }, { env: f.env });
    expect(f.repair({ OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" })).toEqual([
      expect.stringContaining("during update Doctor"),
    ]);
    expect(f.registeredPaths()).toEqual(before);
    expect(fs.existsSync(pathname)).toBe(true);
  });
});
