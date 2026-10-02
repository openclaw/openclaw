import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { formatCliFailureLines } from "../cli/failure-output.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot-source.js";
import * as driver from "../infra/update-run-driver.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as databasePreflight from "./doctor-database-preflight.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import {
  guardUpdateDoctorSchemaUpgrade,
  preflightUpdateDoctorCli,
  preflightUpdatePackageLifecycle,
} from "./doctor-update-schema-guard.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Scenario = {
  version?: string;
  platform?: "win32" | "darwin";
  liveness?: "alive" | "dead" | "unknown";
  previousDriver?: boolean;
  noDriver?: boolean;
  identityUnavailable?: boolean;
  invocation?: "cli" | "flow" | "package";
  finished?: boolean;
  update?: boolean;
  databaseKind?: "state" | "agent";
};

async function inspectDoctor(scenario: Scenario) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const recorded = { host: "update-fixture", pid: 4000, startIdentity: "100" };
    const run = createUpdateRun({
      trigger: "cli",
      before: { version: scenario.version ?? "2026.9.4" },
      origin: scenario.noDriver
        ? {}
        : scenario.previousDriver
          ? {
              driver: { ...recorded, pid: 4001 },
              previousDrivers: [recorded],
            }
          : { driver: recorded },
    });
    if (scenario.identityUnavailable) {
      recordUpdateRunStep(run.runId, { step: "driver:identity-unavailable", status: "completed" });
    }
    if (scenario.finished) {
      finishUpdateRun(run.runId, { status: "failed", reason: "fixture-finished" });
    }
    await closeStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath();
    const before = fs.readFileSync(databasePath);
    const snapshotPath = state.path("diagnostic.sqlite");
    const cleanup = () => {
      fs.unlinkSync(snapshotPath);
      return true;
    };
    // Native private-directory creation is platform-owned and separately proved.
    // Supply its closed, task-owned image while simulating Windows policy here.
    const snapshotRead = vi
      .spyOn(sqliteSnapshot, "prepareSqliteReadOnlyLocation")
      .mockImplementation(async () => {
        fs.copyFileSync(databasePath, snapshotPath);
        return {
          location: snapshotPath,
          cleanup,
          cleanupAsync: async () => cleanup(),
        };
      });
    // These are prepared preflight facts, not a synthetic migration or a claim
    // that the current test database has the shipped schema's full layout.
    const schemas: DoctorDatabasePreflight = {
      incompatible: [],
      indeterminate: [],
      pendingMigrations: [
        {
          kind: scenario.databaseKind ?? "state",
          path: databasePath,
          foundVersion: 17,
          supportedVersion: 19,
        },
      ],
    };
    vi.spyOn(databasePreflight, "prepareDoctorDatabasePreflight").mockResolvedValue(schemas);
    vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(null);
    vi.spyOn(driver, "readUpdateRunDriver").mockReturnValue(recorded);
    mockProcessPlatform(scenario.platform ?? "win32");
    vi.spyOn(driver, "inspectUpdateRunDriver").mockImplementation((observed) =>
      observed.pid === recorded.pid ? (scenario.liveness ?? "alive") : "dead",
    );
    for (const [name, value] of Object.entries(
      buildUpdateDoctorEnv({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
        deferConfiguredPluginInstallRepair: true,
        serviceRepairPolicy: "external",
      }),
    )) {
      vi.stubEnv(name, value);
    }
    if (scenario.update === false) {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    }
    let error: unknown;
    let result: DoctorDatabasePreflight | undefined;
    try {
      if (scenario.invocation === "package") {
        await preflightUpdatePackageLifecycle();
      } else {
        result =
          scenario.invocation === "flow"
            ? await guardUpdateDoctorSchemaUpgrade({ schemas })
            : await preflightUpdateDoctorCli({});
      }
    } catch (caught) {
      error = caught;
    }
    for (const call of snapshotRead.mock.results) {
      if (call.type === "return") {
        await expect(call.value).resolves.toMatchObject({ location: expect.any(String) });
      }
    }
    expect(fs.readFileSync(databasePath)).toEqual(before);
    return { error, result, schemas };
  });
}

const refusalScenarios: (Scenario & { name: string })[] = [
  { name: "package lifecycle before repair", invocation: "package" },
  { name: "live driver", liveness: "alive" },
  { name: "unobservable driver", liveness: "unknown" },
  { name: "live retained parent", previousDriver: true },
  { name: "missing driver identity", noDriver: true },
  { name: "unrecorded adopter with dead parent", identityUnavailable: true, liveness: "dead" },
];
it.each(refusalScenarios)(
  "refuses the released Windows ledger incompatibility before writes ($name)",
  async (scenario) => {
    const { error } = await inspectDoctor(scenario);
    expect(error).toMatchObject({
      code: "update-schema-bump-unfenced",
      updaterVersion: "2026.9.4",
      message: expect.stringContaining("The blocked schema change was not applied"),
    });
    // The unchanged 9.4 canary keeps only the last 512 characters of each of
    // forty lines. The reason and usable recovery must survive that boundary.
    const parentOutput = formatCliFailureLines({
      title: "CLI failed",
      error,
      argv: ["node", "openclaw", "doctor", "--fix", "--non-interactive"],
      env: {},
    })
      .join("\n")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.slice(-512))
      .slice(-40)
      .join("\n");
    expect(parentOutput).toContain(
      "Doctor refused update-time schema repair driven by OpenClaw 2026.9.4:",
    );
    expect(parentOutput).toContain("openclaw gateway stop && npm install -g openclaw@");
    expect(parentOutput).toContain(
      "original service account, package prefix, profile, and state/config overrides",
    );
  },
);

const allowedScenarios: (Scenario & { name: string })[] = [
  { name: "current package updater", invocation: "package", version: "2026.9.6" },
  { name: "other shipped package updater", invocation: "package", version: "2026.9.2" },
  { name: "independent package installation", invocation: "package", update: false },
  { name: "current driver", version: "2026.9.6" },
  { name: "other platform", platform: "darwin" },
  { name: "dead driver", liveness: "dead" },
  { name: "finished driver", finished: true },
  { name: "independent Doctor", update: false },
  { name: "agent-only migration", databaseKind: "agent" },
  { name: "direct flow with separate caller admission", invocation: "flow" },
];
it.each(allowedScenarios)("preserves existing Doctor admission for $name", async (scenario) => {
  const { error, result, schemas } = await inspectDoctor(scenario);
  expect(error).toBeUndefined();
  expect(result).toBe(
    scenario.update === false || scenario.invocation === "package" ? undefined : schemas,
  );
});
