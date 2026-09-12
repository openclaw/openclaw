import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listExistingAgentDatabaseTargets } from "./doctor-session-sqlite-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("Doctor agent database admission", () => {
  it("reports a refused agent without changing either copy and clears after file repair", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-agent-admission-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true }, cleaner: {} } },
    };
    const ownerPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const copyPath = path.join(stateDir, "agents", "cleaner", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.copyFileSync(ownerPath, copyPath, fs.constants.COPYFILE_EXCL);
    const { DatabaseSync } = requireNodeSqlite();
    const copy = new DatabaseSync(copyPath);
    copy.prepare("UPDATE schema_meta SET app_version = ?").run("divergent-fixture");
    copy.close();
    const before = [fs.readFileSync(ownerPath), fs.readFileSync(copyPath)];
    const checks = (await resolveDoctorContributionHealthChecks()).filter(
      (check) => check.id === "core/doctor/agent-database-admission",
    );
    const context = {
      mode: "doctor" as const,
      cfg,
      env,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    };
    const findings = (await Promise.all(checks.map((check) => check.detect(context)))).flat();

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/agent-database-admission",
        severity: "warning",
        target: "cleaner",
        requirement: "agent-database-ownership-mismatch",
        message: expect.stringContaining("main"),
        fixHint: expect.stringContaining("quarantine"),
      }),
    ]);
    expect(findings[0]?.message).toContain("cleaner");
    expect(findings[0]?.message).toContain(copyPath);
    expect([fs.readFileSync(ownerPath), fs.readFileSync(copyPath)]).toEqual(before);

    await assertOpenClawDatabasesReady({ config: cfg, env, operation: "gateway-startup" });
    expect(listExistingAgentDatabaseTargets(cfg, env).map((target) => target.agentId)).toEqual([
      "main",
    ]);
    const legacyStore = path.join(stateDir, "agents", "cleaner", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(legacyStore), { recursive: true });
    fs.writeFileSync(legacyStore, "{}\n");
    expect(() =>
      assertSessionStoreMigrationComplete({ cfg, env, operation: "doctor" }),
    ).not.toThrow();
    expect(fs.readFileSync(legacyStore, "utf8")).toBe("{}\n");

    fs.renameSync(copyPath, `${copyPath}.operator-backup`);
    const repaired = (await Promise.all(checks.map((check) => check.detect(context)))).flat();
    expect(repaired).toEqual([]);
    expect(fs.readFileSync(ownerPath)).toEqual(before[0]);
    expect(fs.readFileSync(`${copyPath}.operator-backup`)).toEqual(before[1]);
  });
});
