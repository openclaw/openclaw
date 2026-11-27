import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DoctorMaintenancePendingCheck } from "../commands/doctor-maintenance-pending.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import * as systemdExec from "../daemon/systemd-exec.js";
import { buildSystemdUnit } from "../daemon/systemd-unit.js";
import {
  closeDatabases,
  databaseFixture,
} from "../state/database-preflight-fixtures.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  changedStoreFiles,
  listSqliteSidecars,
  removeEmptySqliteSidecars,
  snapshotStoreFiles,
} from "../test-utils/store-snapshot.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

// Every Doctor step records a `pending` decision through `traceDoctorMaintenancePending`
// before it runs, and that decision must only read. This runs `doctor --fix` on a healthy
// install and, before each step's check, closes every store connection so the check meets
// the stores as a stopped Gateway leaves them: no WAL sidecars. A check that creates or
// changes a file under the state directory, including the sidecars a read-only SQLite open
// leaves behind, fails here. A step added later is covered once it records its decision.

const { mocks } = await import("./doctor-health.test-support.js");

type Decision = { step: string; sidecarsBefore: string[]; changed: string[] };
const observed = vi.hoisted(() => ({
  root: undefined as string | undefined,
  decisions: [] as Decision[],
}));

vi.mock("../commands/doctor-maintenance-pending.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/doctor-maintenance-pending.js")>();
  return {
    ...actual,
    traceDoctorMaintenancePending: async (step: string, check?: DoctorMaintenancePendingCheck) => {
      const root = observed.root;
      if (!check || !root) {
        return actual.traceDoctorMaintenancePending(step, check);
      }
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      // Doctor's earlier read-only opens can leave empty sidecars; with every connection
      // closed, remove them as SQLite's last writable close would.
      removeEmptySqliteSidecars(root);
      const sidecarsBefore = listSqliteSidecars(root);
      const before = snapshotStoreFiles(root);
      const work = await actual.traceDoctorMaintenancePending(step, check);
      observed.decisions.push({
        step,
        sidecarsBefore,
        changed: changedStoreFiles(before, snapshotStoreFiles(root)),
      });
      return work;
    },
  };
});

afterEach(() => {
  observed.root = undefined;
  observed.decisions = [];
  mocks.servicePlatform = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function prepareStoppedSystemdGateway(state: {
  home: string;
  path: (...parts: string[]) => string;
}) {
  const sourcePath = state.path(".config", "systemd", "user", "openclaw-gateway.service");
  const command = {
    programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
    environment: {
      HOME: state.home,
      PATH: "/usr/bin:/bin",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    },
    sourcePath,
    definitionPaths: [sourcePath],
  };
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, buildSystemdUnit(command));
  const service = createMockGatewayService({
    isLoaded: async () => true,
    readCommand: async () => command,
    readRuntime: async () => ({
      status: "stopped",
      state: "inactive",
      subState: "dead",
      systemd: { managerUid: process.geteuid?.() ?? 2001 },
    }),
    readDefinitionMutationCapability: async () => ({ kind: "sealed", reason: "system-owned" }),
  });
  mocks.service.mockReturnValue(service);
  mocks.servicePlatform = "linux";
  mocks.config.mockReturnValue({});
  mocks.packageRoot.mockReturnValue(process.cwd());
  // Contribution checks run in their own test; this one covers the steps around them.
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  const exited = { code: 0, stderr: "", termination: "exit" as const };
  vi.spyOn(systemdExec, "execSystemctl").mockResolvedValue({ ...exited, stdout: "not-found" });
  vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue({
    ...exited,
    stdout:
      "LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=330s\n",
  });
}

it("decides every step of doctor --fix without creating or changing a file", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const databases = databaseFixture(state.stateDir, state.env);
    databases.state();
    databases.agent("main");
    closeDatabases();
    prepareStoppedSystemdGateway(state);
    observed.root = state.stateDir;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

    const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
    expect(runtime.exit, output).not.toHaveBeenCalled();
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    expect(observed.decisions.map(({ step }) => step)).toEqual(
      expect.arrayContaining([
        "state-database-repair",
        "database-migrations",
        "state-schema",
        "runtime-checks",
        "external-config",
        "maintenance-ready",
        "boot-lifecycle",
      ]),
    );
    expect(observed.decisions.filter(({ sidecarsBefore }) => sidecarsBefore.length > 0)).toEqual(
      [],
    );
    expect(observed.decisions.filter(({ changed }) => changed.length > 0)).toEqual([]);
  });
});
