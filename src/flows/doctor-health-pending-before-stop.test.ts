import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareDoctorDatabasePreflight,
  type DoctorDatabasePreflight,
} from "../commands/doctor-database-preflight.js";
import type { DoctorPendingDecisions } from "../commands/doctor-maintenance-pending.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { databaseFixture } from "../state/database-preflight-fixtures.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  changedStoreFiles,
  listSqliteSidecars,
  removeEmptySqliteSidecars,
  snapshotStoreFiles,
} from "../test-utils/store-snapshot.test-support.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.test-support.js";
import { decideDoctorPendingBeforeStop } from "./doctor-health-pending-before-stop.js";

// Doctor --fix decides every step's and contribution's pending answer before it stops the
// Gateway. These run that evaluation on a healthy install: beside connections that hold the
// stores, as a serving Gateway does, and with nothing holding them, as a Gateway stopped by
// hand leaves them. It must only read in both.

const STEPS = [
  "legacy-state-dir",
  "client-credentials",
  "state-database-repair",
  "database-migrations",
  "state-schema",
  "runtime-checks",
  "config-flow.agent-databases",
  "config-flow",
  "external-config",
  "maintenance-ready",
  "boot-lifecycle",
  "sqlite-nocow",
  "service-definition",
];

// Steps whose checks read SQLite through `decideDoctorPendingFromLiveStores`.
const LIVE_STORE_STEPS = ["database-migrations", "config-flow.agent-databases", "boot-lifecycle"];

async function closeStores() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}

function captureTrace() {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe("Doctor pending decisions before the stop", () => {
  let state: OpenClawTestState;
  let databases: ReturnType<typeof databaseFixture>;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  // Doctor hands in the preflight its archive preparation read before the stop.
  const prepare = () => prepareDoctorDatabasePreflight();
  const decide = async (preflight: DoctorDatabasePreflight) => {
    const decisions: DoctorPendingDecisions = new Map();
    await decideDoctorPendingBeforeStop({
      options: { repair: true, yes: true, nonInteractive: true },
      runtime,
      root: null,
      preflight,
      automaticHeartbeatRepair: false,
      decisions,
    });
    return decisions;
  };

  beforeEach(async () => {
    state = await createOpenClawTestState({ layout: "home", prefix: "openclaw-doctor-prestop-" });
    const cfg: OpenClawConfig = {
      gateway: { mode: "local", auth: { mode: "token", token: "prestop-test-token-0123456789" } },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    fs.mkdirSync(state.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(state.workspaceDir, "AGENTS.md"), "# Agent\n");
    databases = databaseFixture(state.stateDir, state.env);
    databases.state();
    databases.agent("main");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeStores();
    await state.cleanup();
  });

  it("decides every step and contribution once beside held stores and changes no file", async () => {
    const preflight = await prepare();
    // Fold the fixture's own writes into the database files, so a changed file is a write.
    databases.state().db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    databases.agent("main").db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const trace = captureTrace();
    const before = snapshotStoreFiles(state.root);

    const decisions = await decide(preflight);

    expect(changedStoreFiles(before, snapshotStoreFiles(state.root))).toEqual([]);
    const contributions = resolveDoctorHealthContributions().map(
      (contribution) => `contribution.${contribution.id}`,
    );
    expect([...decisions.keys()]).toEqual(expect.arrayContaining([...STEPS, ...contributions]));
    // Stores held open decide; none of the live-store reads is left undecidable.
    for (const step of LIVE_STORE_STEPS) {
      expect([step, decisions.get(step)]).toEqual([
        step,
        expect.stringMatching(/^(?:none|work)$/u),
      ]);
    }
    const lines = trace.filter((line) => line.includes("doctor.pending"));
    // One line per decision, then the summary.
    expect(lines.filter((line) => / at=before-stop /u.test(line))).toHaveLength(decisions.size);
    const summary = lines.find((line) => /doctor\.pending-before-stop [0-9.]+ms /u.test(line));
    const counts = { none: 0, work: 0, undecidable: 0 };
    for (const answer of decisions.values()) {
      counts[answer] += 1;
    }
    expect(summary).toContain(
      ` decisions=${decisions.size} none=${counts.none} work=${counts.work} undecidable=${counts.undecidable} `,
    );
    expect(summary).toContain(" notNone=client-credentials:work,");
    expect(summary).not.toContain(" failed=");
  });

  it("answers undecidable for stores nobody holds and creates no file", async () => {
    const preflight = await prepare();
    await closeStores();
    removeEmptySqliteSidecars(state.root);
    expect(listSqliteSidecars(state.root)).toEqual([]);
    const before = snapshotStoreFiles(state.root);

    const decisions = await decide(preflight);

    expect(changedStoreFiles(before, snapshotStoreFiles(state.root))).toEqual([]);
    for (const step of LIVE_STORE_STEPS) {
      expect([step, decisions.get(step)]).toEqual([step, "undecidable"]);
    }
  });

  it("finds work an owner would repair inside the stop", async () => {
    const preflight = await prepare();
    expect((await decide(preflight)).get("state-database-repair")).toBe("none");
    // Modes the state database repair hardens on every run.
    fs.chmodSync(databases.statePath, 0o644);

    const decisions = await decide(preflight);

    expect(decisions.get("state-database-repair")).toBe("work");
    expect(fs.statSync(databases.statePath).mode & 0o777).toBe(0o644);
  });
});
