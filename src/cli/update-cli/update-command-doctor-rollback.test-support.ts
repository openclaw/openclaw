import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/io.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as stateSchemas from "../../infra/update-candidate-state.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { runFixtureGit } from "../../infra/update-runner-git-candidate.test-support.js";
import { updateGitCheckout } from "../../infra/update-runner-git.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { VERSION } from "../../version.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

type FreshProcess =
  typeof import("./update-command-post-core.js").continuePostCoreUpdateInFreshProcess;
type Restart = typeof import("./update-command-service.js").maybeRestartService;
type VerifyGateway = typeof import("./update-command-verification.js").verifyUpdatedGateway;

async function createGitRollbackFixture(base: string) {
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    vi.stubEnv(key, undefined);
  }
  const remote = path.join(base, "remote");
  const root = path.join(base, "checkout");
  await fs.mkdir(remote);
  await runFixtureGit(remote, "init", "--initial-branch=main");
  await runFixtureGit(remote, "config", "user.name", "OpenClaw Test");
  await runFixtureGit(remote, "config", "user.email", "openclaw@example.com");
  await fs.writeFile(
    path.join(remote, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION, packageManager: "pnpm@12.0.0" }),
  );
  await fs.writeFile(path.join(remote, "openclaw.mjs"), "export {};\n");
  await fs.writeFile(path.join(remote, ".gitignore"), "dist/\nnode_modules/\n.artifacts/\n");
  await runFixtureGit(remote, "add", ".");
  await runFixtureGit(remote, "commit", "-m", "fixture");
  await runFixtureGit(base, "clone", "--quiet", remote, root);
  await runFixtureGit(root, "config", "user.name", "OpenClaw Test");
  await runFixtureGit(root, "config", "user.email", "openclaw@example.com");
  await fs.writeFile(path.join(root, "local-commit.txt"), "retained local commit\n");
  await runFixtureGit(root, "add", ".");
  await runFixtureGit(root, "commit", "-m", "local fixture");
  const beforeSha = await runFixtureGit(root, "rev-parse", "HEAD");
  const writeRuntime = async (destination: string, buildId: string) => {
    const sha = await runFixtureGit(destination, "rev-parse", "HEAD");
    const dist = path.join(destination, "dist");
    await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha, buildId })),
      fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
      fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
      fs.writeFile(
        path.join(dist, "entry.js"),
        `export const build = ${JSON.stringify(buildId)};\n`,
      ),
      fs.writeFile(path.join(dist, "control-ui", "index.html"), "<html></html>"),
    ]);
  };
  await writeRuntime(root, "previous-build");
  let transaction: PackageUpdateTransaction | undefined;
  const result = await updateGitCheckout({
    gitRoot: root,
    startedAt: Date.now(),
    timeoutMs: 5000,
    defaultCommandEnv: undefined,
    runCommand: async (argv, options) => {
      if (argv[0] !== "pnpm") {
        return runCommandWithTimeout(argv, options);
      }
      if (argv[1] === "build") {
        await writeRuntime(options.cwd!, "candidate-build");
      }
      return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
    },
    opts: {
      inspectGitTarget: async () => {},
      beforeGitMutation: async () => {},
      validateCandidate: async () => {},
      runGitDoctor: async (cwd) => ({
        name: "openclaw doctor",
        command: "fixture doctor",
        cwd,
        durationMs: 0,
        exitCode: 0,
      }),
      onTransaction: (retained) => {
        transaction = retained;
      },
    },
  });
  expect(result.status).toBe("ok");
  expect(result.after?.sha).toBe(beforeSha);
  expect(result.after?.buildId).toBe("candidate-build");
  if (!transaction) {
    throw new Error("Git activation did not retain its runtime for finalization recovery");
  }
  return { root, result, transaction };
}

export function registerDoctorRestorationRollbackTests(
  harness: {
    freshProcess: { mockImplementationOnce: (implementation: FreshProcess) => unknown };
    stopCandidate: { mockResolvedValueOnce: (result: PreManagedServiceStop) => unknown };
    restartCandidate: { mockImplementationOnce: (implementation: Restart) => unknown };
    verifyGateway: { mockImplementation: (implementation: VerifyGateway) => unknown };
  },
  makeTempDir: (prefix: string) => string,
) {
  it.each([
    { transport: "exception", differentService: false },
    { transport: "child-result", differentService: false },
    { transport: "exception", differentService: true },
    { transport: "stale-git-graph", differentService: false },
  ] as const)(
    "restores and verifies the previous package after post-update verification failure ($transport, differentService=$differentService)",
    async ({ transport, differentService }) => {
      const base = makeTempDir("update-doctor-restoration-");
      let packageRoot: string;
      let launcher: string | undefined;
      let updateResult: UpdateRunResult;
      let transaction: PackageUpdateTransaction | undefined;
      if (transport === "stale-git-graph") {
        const fixture = await createGitRollbackFixture(base);
        packageRoot = fixture.root;
        transaction = fixture.transaction;
        updateResult = fixture.result;
      } else {
        const fixture = await createPackageSwapFixture(base);
        packageRoot = fixture.packageRoot;
        launcher = fixture.launcher;
        await writePackageRoot(fixture.params.stage.packageRoot, "9999.1.1");
        const swap = await swapStagedPackageInstall({
          ...fixture.params,
          onTransaction: (retained) => {
            transaction = retained;
          },
        });
        expect(swap.status).toBe("committed");
        updateResult = {
          status: "ok",
          mode: "npm",
          root: packageRoot,
          before: { version: "1.0.0" },
          after: { version: "9999.1.1" },
          steps: [],
          durationMs: 1,
        };
      }
      const serviceRoot = differentService ? path.join(base, "service-a") : packageRoot;
      const installedVersion = transport === "stale-git-graph" ? VERSION : "1.0.0";
      const serviceVersion = differentService ? "0.9.0" : installedVersion;
      if (differentService) {
        await writePackageRoot(serviceRoot, serviceVersion);
      }
      if (!transaction) {
        throw new Error("Expected a retained package transaction");
      }
      const rollback = vi.spyOn(transaction, "rollback");
      // The synthetic package omits workers; keep real schema inspection in source.
      const readSchemas = stateSchemas.readUpdateStateSchemaVersions;
      vi.spyOn(stateSchemas, "readUpdateStateSchemaVersions").mockImplementation((params) =>
        readSchemas(params.root === packageRoot ? { ...params, root: undefined } : params),
      );
      const stateDir = path.join(base, "state");
      await fs.mkdir(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, "{}\n");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      };
      const configSnapshot = await createConfigIO({
        env,
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const schemaVersions = await stateSchemas.readUpdateStateSchemaVersions({
        stateDir,
        config: {},
        env,
      });
      const facts =
        transport === "stale-git-graph"
          ? []
          : [
              {
                check: "gateway-restoration",
                code: "doctor-gateway-rpc-verification-failed",
                message: "rpc-verification: candidate build did not answer",
              },
              {
                check: "gateway-restoration",
                code: "stale-gateway-recovery-command",
                message: "openclaw gateway status --deep",
              },
            ];
      const error =
        transport === "stale-git-graph"
          ? new Error(
              "Cannot find module 'dist/io.write-previous.mjs' imported from 'dist/io.factory-previous.mjs'",
            )
          : new UpdateDoctorError(
              "Doctor Gateway restoration failed during rpc-verification. Run openclaw gateway status --deep.",
              facts,
            );
      harness.freshProcess.mockImplementationOnce(async () => {
        if (transport !== "child-result") {
          throw error;
        }
        return { resumed: false, exitCode: 1, error: error.message, failureFacts: facts };
      });
      const before: PreManagedServiceStop = {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: env,
        serviceIdentity: {
          version: serviceVersion,
          ...(transport === "stale-git-graph" ? { buildId: "previous-build" } : {}),
        },
        serviceUpdateVerdict: {
          kind: "owned",
          root: serviceRoot,
          fingerprint: "fixture",
          refreshDefinition: false,
          requiresInstallRootRefresh: differentService,
        },
      };
      harness.stopCandidate.mockResolvedValueOnce(before);
      let observedGateway: { version: string | null; buildId: string | null } | undefined;
      if (transport === "stale-git-graph") {
        harness.verifyGateway.mockImplementation(
          async ({ result, expectedVersion, expectedBuildId }) => {
            if (!observedGateway) {
              throw new Error("Fixture Gateway was not restarted before verification");
            }
            const matches =
              observedGateway.version === expectedVersion &&
              observedGateway.buildId === expectedBuildId;
            result.verification = {
              serviceRunning: true,
              runningVersion: observedGateway.version ?? undefined,
              runningBuildId: observedGateway.buildId ?? undefined,
              versionMatch: matches,
              readyz: true,
              settled: true,
              channelsReady: true,
              pluginErrors: [],
            };
            return {
              ok: matches,
              score: matches ? 7 : 0,
              summary: matches ? "healthy" : "fixture runtime mismatch",
            };
          },
        );
      }
      harness.restartCandidate.mockImplementationOnce(async (params) => {
        expect(params.requireRunningServiceAfterRestart).toBe(true);
        expect(params.result.after?.version).toBe(installedVersion);
        expect(params.expectedGatewayIdentity).toEqual(before.serviceIdentity);
        expect(
          JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version,
        ).toBe(installedVersion);
        if (launcher) {
          expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
        } else {
          expect(await fs.readFile(path.join(packageRoot, "dist", "entry.js"), "utf8")).toBe(
            'export const build = "previous-build";\n',
          );
          expect(await runFixtureGit(packageRoot, "rev-parse", "HEAD")).toBe(
            updateResult.before?.sha,
          );
          observedGateway = {
            version: await readPackageVersion(packageRoot),
            buildId: await readBuiltGatewayBuildId(packageRoot),
          };
        }
        recordUpdateRunVerification(
          run.runId,
          {
            serviceRunning: true,
            runningVersion: serviceVersion,
            ...(transport === "stale-git-graph" ? { runningBuildId: "previous-build" } : {}),
            versionMatch: true,
            settled: true,
            readyz: true,
          },
          { env },
        );
        params.onVerified?.(Date.now());
        return "ok";
      });
      let failure: UpdateCommandFailure | undefined;
      try {
        await finishUpdate({
          mutationStarted: true,
          result: updateResult,
          root: packageRoot,
          packageTransaction: transaction,
          schemaVersions,
          previousVerified: true,
          installKindChanged: false,
          configSnapshot,
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          preManagedServiceStop: before,
          preUpdatePluginInstallRecords: {},
          updateStepTimeoutMs: 1000,
          opts: { json: true, run },
          startedAt: Date.now(),
          controlPlaneUpdateSentinelMeta: null,
        });
      } catch (caught) {
        if (!(caught instanceof UpdateCommandFailure)) {
          throw caught;
        }
        failure = caught;
      }
      expect(failure?.exitCode).toBe(1);
      expect(rollback).toHaveBeenCalledOnce();
      expect(harness.stopCandidate).toHaveBeenCalledOnce();
      expect(harness.restartCandidate).toHaveBeenCalledOnce();
      expect(failure?.result.root).toBe(packageRoot);
      expect(failure?.result.after?.version).toBe(installedVersion);
      expect(failure?.result.recovery).toMatchObject({
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        service: "healthy",
        version: serviceVersion,
      });
      expect(failure?.result.steps.flatMap((step) => step.failureFacts ?? [])).toEqual(facts);
      const recorded = getUpdateRun(run.runId, { env });
      expect(recorded?.status).toBe("rolled-back");
      expect(recorded?.verification).toMatchObject({
        serviceRunning: true,
        runningVersion: serviceVersion,
        versionMatch: true,
      });
      if (!recorded) {
        throw new Error("Expected terminal rollback report");
      }
      const report = renderUpdateRunReport(recorded);
      expect(report.headline).toContain(
        `rolled back to ${transport === "stale-git-graph" ? updateResult.before?.sha?.slice(0, 8) : installedVersion}`,
      );
      if (transport === "stale-git-graph") {
        expect(recorded.verification.runningBuildId).toBe("previous-build");
        expect(failure?.detail).toContain("io.write-previous.mjs");
        await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(report.markdown).toContain("rpc-verification");
        expect(report.markdown).toContain("openclaw gateway status --deep");
      }
      expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
    },
  );
}
