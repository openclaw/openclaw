import { ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../../scripts/lib/package-lifecycle-marker.mjs";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { runtimeProcessScriptEntrypoints } from "../../infra/runtime-process-manifest.js";
import type { UpdateAdmissionContext } from "../../infra/update-admission-contract.js";
import type { UpdateAdmissionVerdict } from "../../infra/update-run-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { writeJsonFixture, writeNpmPackageInstall } from "./update-cli-package.test-support.js";
import { isLegacyUpdateDoctorCommand } from "./update-command-transport.test-support.js";

export type CandidateAdmissionFixture = ReturnType<
  typeof import("../update-cli-fixture.test-support.js").createUpdateCliFixture
> &
  typeof import("../update-cli-mocks.test-support.js") &
  typeof import("../update-cli-modules.test-support.js") &
  typeof import("../update-cli-assertions.test-support.js") & {
    makeTempDir: (prefix: string) => string;
  };

export function createCandidateAdmissionFixtures(f: CandidateAdmissionFixture) {
  const prepareCandidateAdmissionFixture = async (params: {
    marker: boolean;
    verdict: UpdateAdmissionVerdict;
    exitCode?: number;
    pendingLifecycle?: boolean;
    nodeEngine?: string;
  }) => {
    const { pkgRoot, nodeModules } = await f.setupInstalledPackageRoot(
      f.createCaseDir("candidate-admission"),
      "1.0.0",
    );
    const stages: string[] = [];
    const contexts: UpdateAdmissionContext[] = [];
    const events: string[] = [];
    const databaseExistsAtAdmission: boolean[] = [];
    f.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (
        argv.at(-1) === "--version" &&
        argv.some(
          (argument) =>
            path.basename(argument) === runtimeProcessScriptEntrypoints.updateNativeGate.fileName ||
            path.parse(argument).name ===
              path.parse(runtimeProcessEntrypoints.updateNativeGate.distWorkerPath).name,
        )
      ) {
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
    f.mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    f.readPackageVersion.mockImplementation(async (root) =>
      String(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version),
    );
    const originalSpawn = expectDefined(f.spawn.getMockImplementation(), "default child transport");
    f.spawn.mockImplementation((command: string, args: string[], options: SpawnOptions) => {
      if (args.at(-4) !== "update" || args.at(-3) !== "admit" || args.at(-2) !== "--context") {
        return originalSpawn(command, args, options);
      }
      const contextPath = expectDefined(args.at(-1), "candidate admission context");
      contexts.push(JSON.parse(fsSync.readFileSync(contextPath, "utf8")) as UpdateAdmissionContext);
      events.push("admission");
      databaseExistsAtAdmission.push(
        fsSync.existsSync(resolveOpenClawStateSqlitePath(options.env)),
      );
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const exitCode = params.exitCode ?? (params.verdict.verdict === "admit" ? 0 : 3);
      queueMicrotask(() => {
        child.stdout?.emit("data", JSON.stringify(params.verdict));
        child.emit("exit", exitCode);
        child.emit("close", exitCode);
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
