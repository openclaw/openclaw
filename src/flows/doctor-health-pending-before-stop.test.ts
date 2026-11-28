import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
import {
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db.js";
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

const children = vi.hoisted(() => ({ spawned: [] as ChildProcess[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const recorded = ((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    children.spawned.push(child);
    return child;
  }) as typeof actual.spawn;
  const mocked = { ...actual, spawn: recorded };
  return { ...mocked, default: mocked };
});

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

  it("leaves no store connection of its own open for the stop", async () => {
    const preflight = await prepare();
    await closeStores();
    // The serving Gateway holds the stores from another process.
    const gateway = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const held = process.argv.slice(1).map((p) => new DatabaseSync(p));
         for (const db of held) db.prepare("SELECT count(*) FROM sqlite_schema").get();
         process.stdout.write("held\\n");
         process.stdin.on("end", () => held.forEach((db) => db.close())).resume();`,
        databases.statePath,
        databases.agentPath("main"),
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      await once(gateway.stdout, "data");
      const before = children.spawned.length;
      const decisions = await decide(preflight);
      expect(decisions.get("config-flow.agent-databases")).toMatch(/^(?:none|work)$/u);
      // SQLite reader processes stay pooled with their stores open after their scope closes.
      const readers = children.spawned
        .slice(before)
        .filter((child) => child.spawnargs.some((arg) => arg.includes("sqlite-readonly")));
      expect(readers.length).toBeGreaterThan(0);
      // None the evaluation started is still running when it returns.
      expect(
        readers.filter((child) => child.exitCode === null && child.signalCode === null),
      ).toEqual([]);
      expect(isOpenClawStateDatabaseOpen(databases.statePath)).toBe(false);
      expect(isOpenClawAgentDatabaseOpen(databases.agentPath("main"))).toBe(false);
    } finally {
      gateway.stdin.end();
      await once(gateway, "exit");
    }
    // Once the Gateway closes the stores, nothing of this process holds them either: their
    // WAL sidecars go with the last connection, as they do when Doctor decides nothing early.
    expect(listSqliteSidecars(state.root)).toEqual([]);
  });
});
