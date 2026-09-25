import { ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import type { Mock } from "vitest";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../../scripts/lib/package-lifecycle-marker.mjs";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { UpdateAdmissionContext } from "../../infra/update-admission-contract.js";
import type { UpdateAdmissionVerdict } from "../../infra/update-run-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import {
  writeJsonFixture,
  writeNpmPackageInstall,
  type createUpdateCliPackageFixtures,
  type createCurrentProcessFreshDoctorFixture,
} from "./update-cli-package.test-support.js";
import { isLegacyUpdateDoctorCommand } from "./update-command-transport.test-support.js";

type PackageFixtures = ReturnType<typeof createUpdateCliPackageFixtures>;
export type CandidateAdmissionFixture = {
  createCaseDir: (prefix: string) => string;
  makeTempDir: (prefix: string) => string;
  fixtureRoot: string;
  baseSnapshot: ConfigFileSnapshot;
  setupInstalledPackageRoot: PackageFixtures["setupInstalledPackageRoot"];
  mockNpmGlobalCommands: PackageFixtures["mockNpmGlobalCommands"];
  mockCurrentProcessFreshDoctor: ReturnType<typeof createCurrentProcessFreshDoctorFixture>;
  mockPackageInstallStatus: (root: string) => void;
  mockPackageInstallAtCaseDir: (prefix?: string, version?: string) => Promise<string>;
  mockOwnedGitService: (root?: string) => void;
  primeNpmChannelTag: (tag: string, version: string | null) => void;
  primeServiceCommand: (args: Array<string | undefined>, env?: NodeJS.ProcessEnv) => void;
  profileStateDir: (profile?: string) => string;
  gatewayFixturePid: number;
  readPackageVersion: Mock;
  spawn: Mock;
  serviceLoaded: Mock;
  serviceStop: Mock;
  serviceStart: Mock;
  serviceRestart: Mock;
  mockGetSelfAndAncestorPidsSync: Mock<() => Set<number>>;
  pluginAvailabilityPreflight: Mock;
  candidateValidation: Mock;
  nodeVersionSatisfiesEngine: Mock;
  databasePreflightMocks: { preflightOpenClawDatabaseSchemas: Mock };
  readConfigFileSnapshot: typeof import("../../config/config.js").readConfigFileSnapshot;
  replaceConfigFile: typeof import("../../config/config.js").replaceConfigFile;
  fetchNpmPackageTargetStatus: typeof import("../../infra/update-check-package-target.js").fetchNpmPackageTargetStatus;
  resolveGatewayInstallEntrypoint: typeof import("../../daemon/gateway-entrypoint.js").resolveGatewayInstallEntrypoint;
  listUpdateRuns: typeof import("../../infra/update-run-ledger.js").listUpdateRuns;
  updateGitCheckout: typeof import("../../infra/update-runner-git.js").updateGitCheckout;
  defaultRuntime: typeof import("../../runtime.js").defaultRuntime;
  ExitError: typeof import("../../runtime.js").ExitError;
  updateCommand: typeof import("./update-command.js").updateCommand;
  invokeUpdateCli: typeof import("../update-cli-invocation.test-support.js").invokeUpdateCli;
  packageInstallCommandCall: () => [string[], Record<string, unknown>] | undefined;
  doctorCommandCall: () => unknown;
  freshRestartCalls: () => readonly unknown[];
  lastWriteJsonCall: () => unknown;
  getErrorOutput: () => string;
  getTriageFailures: () => readonly unknown[];
  expectNoSideEffects: (...effects: unknown[]) => void;
};

export function createCandidateAdmissionFixtures(f: CandidateAdmissionFixture) {
  const {
    setupInstalledPackageRoot,
    createCaseDir,
    mockNpmGlobalCommands,
    mockCurrentProcessFreshDoctor,
    readPackageVersion,
    spawn,
  } = f;

  const prepareCandidateAdmissionFixture = async (params: {
    marker: boolean;
    verdict: UpdateAdmissionVerdict;
    exitCode?: number;
    installed?: boolean;
    pendingLifecycle?: boolean;
    nodeEngine?: string;
  }) => {
    const { pkgRoot, nodeModules } = await setupInstalledPackageRoot(
      createCaseDir("candidate-admission"),
      "1.0.0",
    );
    const stages: string[] = [];
    const contexts: UpdateAdmissionContext[] = [];
    const events: string[] = [];
    const databaseExistsAtAdmission: boolean[] = [];
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[1] === "--input-type=module" && argv.at(-1) === "--version") {
        events.push("runtime-provision");
        return createCommandResult({ cleanup: "normal" });
      }
      if (argv[1]?.endsWith("preinstall-package-manager-warning.mjs")) {
        events.push("preinstall");
      } else if (argv[1]?.endsWith("postinstall-bundled-plugins.mjs")) {
        events.push("postinstall");
      } else if (isLegacyUpdateDoctorCommand(argv)) {
        events.push("doctor");
      }
      if (argv[0] !== "npm" || argv[1] !== "i") {
        return undefined;
      }
      await writeNpmPackageInstall(argv, pkgRoot);
      const prefix = expectDefined(argv[argv.indexOf("--prefix") + 1], "stage prefix");
      const stage = path.join(
        prefix,
        process.platform === "win32" ? "node_modules" : "lib/node_modules",
        "openclaw",
      );
      stages.push(stage);
      await writeJsonFixture(path.join(stage, "package.json"), {
        name: "openclaw",
        version: "9999.0.0",
        engines: { node: params.nodeEngine ?? ">=22.19.0" },
        openclaw: {
          ...(params.marker ? { updateAdmissionProtocol: 1 } : {}),
          schemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        },
      });
      if (params.pendingLifecycle) {
        await fs.writeFile(path.join(stage, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH), "pending\n");
      }
      return undefined;
    });
    mockCurrentProcessFreshDoctor({
      packageRoot: pkgRoot,
      candidateAdmission: params.marker && !params.installed,
    });
    readPackageVersion.mockImplementation(async (root) =>
      String(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version),
    );
    const originalSpawn = expectDefined(spawn.getMockImplementation(), "default child transport");
    spawn.mockImplementation((command: string, args: string[], options: SpawnOptions) => {
      if (args[1] !== "update" || args[2] !== "admit") {
        return originalSpawn(command, args, options);
      }
      const contextPath = expectDefined(
        args[args.indexOf("--context") + 1],
        "candidate admission context",
      );
      contexts.push(JSON.parse(fsSync.readFileSync(contextPath, "utf8")) as UpdateAdmissionContext);
      events.push("admission");
      databaseExistsAtAdmission.push(
        fsSync.existsSync(resolveOpenClawStateSqlitePath(options.env)),
      );
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout?.emit("data", JSON.stringify(params.verdict));
        child.emit("exit", params.exitCode ?? (params.verdict.verdict === "admit" ? 0 : 3));
        child.emit("close", params.exitCode ?? (params.verdict.verdict === "admit" ? 0 : 3));
      });
      return child;
    });
    return { pkgRoot, stages, contexts, events, databaseExistsAtAdmission };
  };

  const candidateAdmissionVerdict = (
    check?: "config" | "database-schema" | "node-runtime",
  ): UpdateAdmissionVerdict => ({
    protocol: 1,
    verdict: check ? "refuse" : "admit",
    reasons: check
      ? [
          {
            code: check === "config" ? "invalid-config" : `${check}-preflight`,
            message: `Candidate refused ${check}.`,
            nextAction: `Resolve the candidate's ${check} finding.`,
          },
        ]
      : [],
    warnings: [],
    facts: {
      candidateVersion: "9999.0.0",
      installedVersion: "1.0.0",
      checks: ["config", "database-schema", "node-runtime", "plugin-availability"].map((name) => ({
        name,
        status: name === check ? "refuse" : "ok",
      })),
    },
  });

  return { prepareCandidateAdmissionFixture, candidateAdmissionVerdict };
}
