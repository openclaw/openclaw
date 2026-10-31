import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { readGitRuntimeArtifactIdentity } from "../../infra/update-git-runtime.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import * as pluginRecords from "../../plugins/installed-plugin-index-records.js";
import * as pluginLifecycle from "../../plugins/plugin-lifecycle-lease.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { expectCallCount as expectCalls } from "../../test-utils/mock-call-assertions.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import { createUpdateCliBaseSnapshot } from "./update-cli-config.test-support.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  runExec: vi.fn(),
  convergeCandidate: vi.fn(),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.runExec,
  runUtf8CommandWithTimeout: async ([command, ...args]: string[], options: unknown) => ({
    ...(await mocks.runExec(command, args, options)),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    cleanup: "normal",
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: vi.fn(async () => "2026.9.4"),
  resolveNodeRunner: vi.fn(() => process.execPath),
}));
vi.mock("./update-command-resume.js", () => ({
  convergePostCoreUpdatePlugins: mocks.convergeCandidate,
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import * as shared from "./shared.js";
import * as pluginConfig from "./update-command-config.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as plugins from "./update-command-plugins.js";
import * as postCore from "./update-command-post-core.js";
import * as sourceRuntime from "./update-command-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const snapshot = { ...createUpdateCliBaseSnapshot({}), path: "/isolated/openclaw.json" };
const pluginUpdate = createPostCorePluginUpdateResult({
  status: "ok",
  changed: true,
  warnings: [],
});
const unchangedPluginUpdate = () => ({ ...pluginUpdate, changed: false });
const candidateResult = (overrides: Partial<typeof pluginUpdate> = {}) => ({
  pluginUpdate: { ...pluginUpdate, ...overrides },
  configSnapshot: snapshot,
});
function doctorOutput(args: string[]) {
  return {
    stdout: args.includes("--lint")
      ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
      : "",
    stderr: "",
  };
}

beforeEach(() => {
  vi.mocked(shared.readPackageVersion).mockResolvedValue("2026.9.4");
  mocks.readConfig.mockReset().mockResolvedValue(snapshot);
  mocks.resolveEntrypoint.mockReset().mockResolvedValue("/isolated/dist/index.js");
  mocks.convergeCandidate.mockReset().mockResolvedValue(candidateResult());
  mocks.runExec
    .mockReset()
    .mockImplementation(async (_command, args: string[]) => doctorOutput(args));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type ConvergenceParams = Parameters<typeof convergeUpdatePlugins>[0];
function converge({
  result = {},
  ...overrides
}: Omit<Partial<ConvergenceParams>, "result"> & {
  result?: Partial<ConvergenceParams["result"]>;
}) {
  return convergeUpdatePlugins({
    root: "/isolated",
    result: {
      status: "ok",
      mode: "git",
      root: "/isolated",
      steps: [],
      durationMs: 0,
      ...result,
    },
    installKindChanged: false,
    configSnapshot: snapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: "stable",
    downgradeRisk: false,
    opts: { json: true, yes: true },
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 5_000,
    ...overrides,
  });
}

function doctorOperation(args: string[]) {
  return args.includes("--repair") ? "repair" : args.includes("--lint") ? "readiness" : "validate";
}

describe("candidate convergence Doctor dispatch authority", () => {
  it.each([false, true])("reports only final candidate warnings (pending=%s)", async (pending) => {
    const migrations = await import("../../infra/deferred-plugin-migrations.js");
    const freshDoctor = await import("./update-command-fresh-doctor.js");
    const { renderUpdateRunReport, updateRunReportInputFromResult } =
      await import("../../infra/update-run-report.js");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("candidate-warnings-"));
    vi.mocked(shared.readPackageVersion).mockResolvedValue(VERSION);
    vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockResolvedValue({ changed: false });
    const migration = {
      pluginId: "fixture-plugin",
      reason: "The installed plugin has not confirmed its saved data and settings.",
      command: "openclaw doctor --fix",
    };
    const earlyWarning = migrations.formatDeferredPluginMigration(migration, {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
    });
    const finalWarning = migrations.formatDeferredPluginMigration(migration, {});
    const advisory = "Optional Doctor inspection needs attention.";
    vi.spyOn(migrations, "readDeferredPluginMigrationsAsync").mockResolvedValue(
      pending ? [migration] : [],
    );
    vi.spyOn(freshDoctor, "completePostCorePluginUpdate").mockImplementationOnce(async (params) => {
      params.onWarnings?.([earlyWarning, advisory, advisory]);
      return candidateResult({
        status: pending ? "warning" : "ok",
        warnings: pending
          ? [
              {
                pluginId: migration.pluginId,
                reason: "doctor-advisory",
                message: finalWarning,
                guidance: [
                  `Run "${migration.command}" to finish the plugin data/settings upgrade.`,
                ],
              },
            ]
          : [],
      });
    });
    const { resultWithPostUpdate } = await converge({ candidateRuntime: true });
    expect(resultWithPostUpdate.status).toBe("ok");
    const report = renderUpdateRunReport(updateRunReportInputFromResult(resultWithPostUpdate));
    expect(report.lines.filter((line) => line.startsWith("Warning: "))).toEqual([
      `Warning: ${advisory}`,
      ...(pending ? [`Warning: ${finalWarning}`] : []),
    ]);
    expect(report.markdown).not.toContain("Let the current update or repair finish.");
  });
  it("records the failed post-core child even without supplied failure facts", async () => {
    vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess").mockResolvedValueOnce({
      resumed: false,
      exitCode: 1,
      error: "x",
      failureFacts: [],
    });
    const { resultWithPostUpdate } = await converge({
      result: { mode: "npm", before: { version: VERSION }, after: { version: "2026.9.4" } },
      downgradeRisk: true,
    });
    expect(resultWithPostUpdate).toMatchObject({
      status: "error",
      steps: [
        {
          name: "post-update verification",
          exitCode: 1,
          stderrTail: "x",
          failureFacts: [{ check: "runtime", code: "post-core-update-failed" }],
        },
      ],
    });
  });
  it("cancels runtime classification with its enclosing command scope", async () => {
    const controller = new AbortController();
    const cancellation = new Error("Update command was cancelled");
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementationOnce(
      async (_root, options) => {
        await Promise.resolve();
        controller.abort(cancellation);
        options?.signal?.throwIfAborted();
        return "package";
      },
    );
    await expect(
      withCommandProcessScope(
        () => sourceRuntime.completeSourceUpdateRuntime({ root: "/isolated", timeoutMs: 1_000 }),
        controller.signal,
      ),
    ).rejects.toBe(cancellation);
  });

  it.each(["prepared", "classified"] as const)(
    "checks current updater authority before returning %s runtime completion",
    async (noOp) => {
      let current = noOp !== "prepared";
      const refusal = new Error("Runtime completion no longer belongs to this updater");
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementationOnce(async () => {
        await Promise.resolve();
        current = false;
        return "package";
      });
      await expect(
        sourceRuntime.completeSourceUpdateRuntime({
          root: "/isolated",
          timeoutMs: 1_000,
          sourceRuntimePrepared: noOp === "prepared" ? true : undefined,
          assertCurrent: () => {
            if (!current) {
              throw refusal;
            }
          },
        }),
      ).rejects.toBe(refusal);
    },
  );

  it.each(["prepared source", "package"] as const)(
    "leaves unused plugin state untouched during %s runtime completion",
    async (installation) => {
      const root = tempDirs.make("openclaw-runtime-completion-");
      const state = path.join(root, "unavailable-state");
      await fs.writeFile(state, "not a state directory");
      await writeFixtureJson(path.join(root, "package.json"), { version: VERSION });
      vi.stubEnv("OPENCLAW_STATE_DIR", state);
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
      vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", undefined);
      vi.mocked(shared.readPackageVersion).mockResolvedValue(VERSION);
      mocks.convergeCandidate.mockResolvedValue(candidateResult({ changed: false }));

      const { resultWithPostUpdate } = await converge({
        root,
        candidateRuntime: true,
        coreAlreadyCurrent: true,
        result: {
          root,
          status: "skipped",
          reason: "already-current",
          mode: installation === "package" ? "npm" : "git",
          sourceRuntimePrepared: installation === "prepared source" ? true : undefined,
        },
      });

      expect(resultWithPostUpdate).toMatchObject({ status: "skipped", reason: "already-current" });
      expect(await fs.readFile(state, "utf8")).toBe("not a state directory");
    },
  );

  it.each([
    { candidateRuntime: false, scenario: "changed-during" },
    { candidateRuntime: true, scenario: "unchanged" },
  ])(
    "compares the activated Git fact after convergence ($scenario, candidate=$candidateRuntime)",
    async ({ candidateRuntime, scenario }) => {
      const root = tempDirs.make("openclaw-git-verification-");
      const dist = path.join(root, "dist");
      const writer = path.join(dist, "io.write-fixture.mjs");
      const entry = path.join(dist, "entry.mjs");
      const executed = path.join(root, "executed");
      await fs.mkdir(dist);
      await writeFixtureJson(path.join(root, "package.json"), { version: VERSION });
      await writeFixtureJson(path.join(dist, "build-info.json"), { commit: "same-commit" });
      await fs.writeFile(writer, "export const generation = 1;\n");
      await fs.writeFile(
        entry,
        `import fs from "node:fs/promises";
await fs.writeFile(${JSON.stringify(executed)}, String(process.pid));
${scenario === "changed-during" ? `await fs.writeFile(${JSON.stringify(writer)}, "export const generation = 2;\\n");` : ""}
await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(unchangedPluginUpdate()))});
`,
      );
      const activated = await readGitRuntimeArtifactIdentity(root);
      mocks.resolveEntrypoint.mockResolvedValue(entry);
      vi.mocked(shared.readPackageVersion).mockResolvedValue(VERSION);
      if (candidateRuntime) {
        vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockResolvedValue({
          changed: false,
        });
        mocks.convergeCandidate.mockResolvedValue(candidateResult({ changed: false }));
      }
      const { resultWithPostUpdate: result } = await converge({
        candidateRuntime,
        result: {
          root,
          before: { sha: "same-commit", version: VERSION },
          after: { sha: "same-commit", version: VERSION },
          gitRuntime: activated,
        },
        root,
        channel: "dev",
        packageUpdateNodeRunner: process.execPath,
      });
      if (candidateRuntime) {
        await expect(fs.stat(executed)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(Number(await fs.readFile(executed, "utf8"))).not.toBe(process.pid);
      }
      expect(result.status).toBe(scenario === "unchanged" ? "ok" : "error");
      const verification = result.steps.find(
        (step) => step.name === "post-core runtime verification",
      )!;
      const receipts = updateRunStepsFromResultStep(verification);
      expect(receipts[0]?.status).toBe(scenario === "unchanged" ? "completed" : "failed");
      const facts = JSON.parse(
        receipts.find((receipt) => receipt.step.startsWith("diagnostic:"))!.detail!,
      );
      expect(facts.activated).toEqual(activated);
      expect(facts.observed.commit).toBe("same-commit");
      expect(facts.observed.distDigest === activated.distDigest).toBe(scenario === "unchanged");
      if (scenario !== "unchanged") {
        expect(verification.failureFacts).toContainEqual(
          expect.objectContaining({ code: "runtime-verification-failed" }),
        );
      }
    },
  );

  it.each([
    { runtime: "npm", revoked: false },
    { runtime: "git", revoked: true },
    { runtime: "git-rebuilt", revoked: false },
  ] as const)(
    "lets the installed $runtime target own convergence before parent worker use (revoked=$revoked)",
    async ({ runtime, revoked }) => {
      const rebuilt = runtime === "git-rebuilt";
      const version = rebuilt ? VERSION : "2026.9.4";
      vi.mocked(shared.readPackageVersion).mockResolvedValue(version);
      const parentLease = vi
        .spyOn(pluginLifecycle, "withPluginLifecycleLease")
        .mockRejectedValue(new Error("Unknown shared-state SQLite command"));
      const parentRuntime = vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime");
      let current = true;
      const authorityRefusal = new Error("Update requester revoked after target convergence");
      vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess").mockImplementationOnce(
        async () => {
          current = !revoked;
          return { resumed: true, pluginUpdate: unchangedPluginUpdate() };
        },
      );
      const outcome = converge({
        result: {
          mode: runtime === "npm" ? "npm" : "git",
          before: { version: VERSION, sha: "old-checkout", buildId: "updater-build" },
          after: {
            version,
            sha: rebuilt ? "old-checkout" : "target-checkout",
            buildId: "published-build",
          },
        },
        downgradeRisk: true,
        assertCurrent: () => {
          if (!current) {
            throw authorityRefusal;
          }
        },
      });
      if (revoked) {
        await expect(outcome).rejects.toBe(authorityRefusal);
        expect(mocks.runExec).not.toHaveBeenCalled();
      } else {
        const result = await outcome;
        expect(result.resultWithPostUpdate.status).toBe("ok");
        expect(result.resultWithPostUpdate.steps).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "source runtime publication" })]),
        );
      }
      expectCalls(0, parentLease, parentRuntime, mocks.convergeCandidate);
    },
  );

  it.each([false, true])(
    "preserves source-completion ownership when consent handoff is declined (retained different runtime=%s)",
    async (retainedDifferentRuntime) => {
      vi.mocked(shared.readPackageVersion).mockResolvedValue(
        retainedDifferentRuntime ? "2026.9.4" : VERSION,
      );
      const events: string[] = [];
      mocks.runExec.mockImplementation(async (_command, args: string[]) => {
        if (args.includes("--help")) {
          events.push("target-declined-consent");
          return { stdout: "Usage: openclaw update [--yes]", stderr: "" };
        }
        return doctorOutput(args);
      });
      // Exercise the real target capability refusal, including its resumed:false outcome.
      const delegate = vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess");
      const runtime = vi
        .spyOn(sourceRuntime, "completeSourceUpdateRuntime")
        .mockImplementation(async ({ assertCurrent }) => {
          assertCurrent?.();
          events.push("source-published");
          return { changed: true };
        });
      vi.spyOn(pluginConfig, "preparePostCorePluginConfig").mockResolvedValue({
        configSnapshot: snapshot,
        configWriteOptions: {},
        configChanged: false,
        restoredAuthoredChannels: [],
      });
      vi.spyOn(pluginRecords, "loadInstalledPluginIndexInstallRecords").mockResolvedValue({});
      const localPlugins = vi
        .spyOn(plugins, "updatePluginsAfterCoreUpdate")
        .mockImplementation(async () => {
          events.push("local-plugins");
          return unchangedPluginUpdate();
        });
      const actualResume = await vi.importActual<typeof import("./update-command-resume.js")>(
        "./update-command-resume.js",
      );
      mocks.convergeCandidate.mockImplementation(actualResume.convergePostCoreUpdatePlugins);
      const result = await withOpenClawTestState(
        { label: "declined-post-core-handoff" },
        async (state) => {
          const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
          return await withUpdateCommandExecutor(runId, async (executor) => {
            const fence = await executor.enter("/isolated");
            return await converge({
              coreAlreadyCurrent: retainedDifferentRuntime,
              result: {
                status: retainedDifferentRuntime ? "skipped" : "ok",
                ...(retainedDifferentRuntime ? { reason: "already-current" } : {}),
                before: { version: VERSION, sha: "old-checkout" },
                after: {
                  version: retainedDifferentRuntime ? "2026.9.4" : VERSION,
                  sha: "target-checkout",
                },
              },
              downgradeRisk: retainedDifferentRuntime,
              assertCurrent: fence.assertCurrent,
              opts: {
                json: true,
                yes: true,
                acceptCapabilities: true,
                run: { runId, env: state.env, executorFence: fence },
              },
            });
          });
        },
      );
      await expect(delegate.mock.results[0]?.value).resolves.toMatchObject({ resumed: false });
      if (retainedDifferentRuntime) {
        expect(result.resultWithPostUpdate).toMatchObject({
          status: "error",
          reason: "post-core-update-failed",
        });
        expect(result.detail).toContain("installed target executable");
        expect(events).toEqual(["target-declined-consent"]);
        expectCalls(0, runtime, localPlugins);
      } else {
        expect(result.resultWithPostUpdate.status, JSON.stringify(result)).toBe("ok");
        expect(events).toEqual(["target-declined-consent", "source-published", "local-plugins"]);
        expect(result.resultWithPostUpdate.steps).toContainEqual(
          expect.objectContaining({ name: "source runtime publication", exitCode: 0 }),
        );
      }
    },
  );

  it.each(["runtime", "plugins"] as const)(
    "parks before %s changes while converging in the candidate runtime",
    async (changed) => {
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "0.0.1");
      const events: string[] = [];
      const park = vi.fn(async () => {
        events.push("park");
      });
      const assertCurrent = vi.fn();
      vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockImplementation(async (params) => {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.9.4");
        if (changed === "runtime") {
          await params.beforePublication?.();
          params.assertCurrent?.();
          events.push("publish");
        }
        return { changed: changed === "runtime" };
      });
      vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess").mockImplementation(async () => {
        throw new Error("Candidate runtime must not delegate convergence again");
      });
      mocks.convergeCandidate.mockImplementation(async (params) => {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.9.4");
        params.assertCurrent();
        events.push("candidate-plugins");
        return candidateResult({ changed: changed === "plugins" });
      });
      const result = await converge({
        candidateRuntime: true,
        coreAlreadyCurrent: true,
        result: {
          status: "skipped",
          reason: "already-current",
        },
        packageUpdateNodeRunner: "/selected/node",
        beforeRuntimePublication: park,
        beforeDoctor: park,
        assertCurrent,
      });
      expect(events).toEqual(
        changed === "runtime"
          ? ["park", "publish", "candidate-plugins"]
          : ["candidate-plugins", "park"],
      );
      expect(result.resultWithPostUpdate.status).toBe("ok");
      expect(result.resultWithPostUpdate.steps).toEqual(
        changed === "runtime"
          ? [expect.objectContaining({ name: "source runtime publication", exitCode: 0 })]
          : [
              expect.objectContaining({
                name: "post-plugin doctor",
                exitCode: 0,
                deferredInspectionCheckIds: null,
              }),
            ],
      );
      if (changed === "plugins") {
        expect(mocks.runExec.mock.calls.map(([, args]) => doctorOperation(args))).toEqual([
          "repair",
          "validate",
          "readiness",
        ]);
        expect(mocks.runExec.mock.calls.every(([command]) => command === "/selected/node")).toBe(
          true,
        );
      }
      expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("0.0.1");
    },
  );

  it.each([
    ["doctor-revocation", ["repair"]],
    ["config-read-revocation", ["repair"]],
    ["validation-replacement", ["repair", "validate"]],
    ["entrypoint-first-refusal", []],
    ["maintenance-first-refusal", []],
    ["maintenance-deferred", []],
    ["maintenance-at-risk", []],
  ] as const)(
    "does not dispatch fresh Doctor with stale authority after %s",
    async (boundary, allowed) => {
      const originalOwner = {};
      let currentOwner: object | undefined = originalOwner;
      const stale = new Error("original updater is no longer current");
      const maintenanceRefusal = new DoctorMaintenanceRefusalError(
        "Doctor could not enter maintenance; run openclaw doctor --fix after the current owner stops.",
        boundary === "maintenance-at-risk"
          ? { kind: "data-at-risk", reason: "incomplete-migration" }
          : { kind: "deferred", reason: "coordinator-contention" },
      );
      let refuseNextCheck = false;
      const assertCurrent = () => {
        if (refuseNextCheck) {
          refuseNextCheck = false;
          throw stale;
        }
        if (currentOwner !== originalOwner) {
          throw stale;
        }
      };
      if (boundary === "entrypoint-first-refusal") {
        mocks.resolveEntrypoint.mockImplementationOnce(async () => {
          await Promise.resolve();
          refuseNextCheck = true;
          return "/isolated/dist/index.js";
        });
      }
      const dispatched: string[] = [];
      mocks.runExec.mockImplementation(async (_command, args: string[]) => {
        const operation = doctorOperation(args);
        dispatched.push(operation);
        await Promise.resolve();
        if (boundary === "doctor-revocation" && operation === "repair") {
          currentOwner = undefined;
        }
        if (boundary === "validation-replacement" && operation === "validate") {
          currentOwner = {};
        }
        return doctorOutput(args);
      });
      if (boundary === "config-read-revocation") {
        mocks.readConfig.mockImplementationOnce(async () => {
          await Promise.resolve();
          currentOwner = undefined;
          return snapshot;
        });
      }
      const outcome = converge({
        candidateRuntime: true,
        result: { mode: "npm" },
        assertCurrent,
        beforeDoctor: async () => {
          await Promise.resolve();
          if (boundary === "maintenance-deferred" || boundary === "maintenance-at-risk") {
            throw maintenanceRefusal;
          }
          if (boundary === "maintenance-first-refusal") {
            refuseNextCheck = true;
          }
        },
      });
      if (boundary === "maintenance-deferred") {
        const completed = await outcome;
        expect(completed.resultWithPostUpdate).toMatchObject({
          status: "ok",
          postUpdate: { plugins: { status: "warning", changed: true } },
          steps: [
            expect.objectContaining({
              exitCode: 0,
              advisory: {
                kind: "package-post-install-doctor",
                message: maintenanceRefusal.message,
              },
            }),
          ],
        });
        expect(mocks.readConfig).not.toHaveBeenCalled();
      } else {
        await expect(outcome).rejects.toBe(
          boundary === "maintenance-at-risk" ? maintenanceRefusal : stale,
        );
      }
      expect(dispatched).toEqual(allowed);
    },
  );
});
