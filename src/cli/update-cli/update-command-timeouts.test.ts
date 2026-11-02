import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import * as gatewayService from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as jsonFiles from "../../infra/json-files.js";
import * as packageJson from "../../infra/package-json.js";
import * as admissionOwner from "../../infra/update-candidate-admission.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import * as executorOwner from "./update-command-executor.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as noop from "./update-command-noop.js";
import * as packageUpdate from "./update-command-package.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";
import * as commandRun from "./update-command-run.js";
import * as runtimePlan from "./update-command-runtime-preflight.js";
import * as schema from "./update-command-schema.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import { updateCommand } from "./update-command.js";

const readChildStart = processIdentity.getFileLockProcessStartTime;
const { fixture } = installFreshUpdateFixture();

function selectVersion(version = "2026.9.4") {
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version });
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    version,
    nodeEngine: null,
    schemaVersions: { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: 20 },
  });
}

function prepareTimedUpdate(trigger: "cli" | "campaign" = "cli") {
  const record = createUpdateRun({ trigger });
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", record.runId);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
  const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation()!;
  vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (opts) => ({
    ...(await prepare(opts)),
    timeoutMs: shared.parseUpdateTimeoutMs(opts.timeout),
  }));
  selectVersion();
  vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
    ok: true,
    value: { nodeRunner: process.execPath },
  });
  return record;
}

const runUpdate = (options: Parameters<typeof updateCommand>[0]) =>
  updateCommand({ admission: "installed", yes: true, json: true, tag: "2026.9.4", ...options });

it.each([
  { trigger: "cli", timeout: undefined },
  { trigger: "campaign", timeout: undefined },
  { trigger: "campaign", timeout: "3600" },
] as const)(
  "keeps $trigger step defaults separate from explicit timeout $timeout",
  async ({ trigger, timeout }) => {
    const record = prepareTimedUpdate(trigger);
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        finishUpdateRun(record.runId, { status: "succeeded" }, { env: params.opts.run?.env });
        return null;
      });

    await runUpdate({ restart: false, timeout });

    const stepTimeoutMs =
      timeout === undefined ? (trigger === "campaign" ? 45 : 30) * 60_000 : 3_600_000;
    expect(runtimePlan.resolvePackageRuntimePreflight).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: stepTimeoutMs }),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        timeoutMs: timeout === undefined ? undefined : 3_600_000,
        updateStepTimeoutMs: stepTimeoutMs,
      }),
    );
  },
);

afterEach(() => vi.useRealTimers());

it("forwards an inherited activation budget for already-current updates without --timeout", async () => {
  selectVersion("2026.9.3");
  const admit = commandRun.admitUpdateCommandRun;
  vi.spyOn(commandRun, "admitUpdateCommandRun").mockImplementation(async (params) => {
    const run = await admit(params);
    run.activationTimeoutMs = 60_000;
    return run;
  });
  const budgets: (number | undefined)[] = [];
  const withExecutor = executorOwner.withUpdateCommandExecutor;
  vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementation(
    (runId, operation, options) =>
      withExecutor(
        runId,
        (executor) => {
          const enter = executor.enter.bind(executor);
          vi.spyOn(executor, "enter").mockImplementation(async (root, opts) => {
            const fence = await enter(root, opts);
            if (opts && "activationTimeoutMs" in opts) {
              budgets.push(opts.activationTimeoutMs);
            }
            return fence;
          });
          return operation(executor);
        },
        options,
      ),
  );
  vi.spyOn(noop, "finishAlreadyCurrentUpdate").mockImplementation(async (params) => {
    const run = params.opts.run;
    const fence = run?.executorFence;
    if (!run || !fence) {
      throw new Error("Missing current-core activation fence");
    }
    fence.assertCurrent();
    finishUpdateRun(run.runId, { status: "skipped", reason: "already-current" }, { env: run.env });
  });
  await runUpdate({ tag: "2026.9.3", restart: false });
  expect(budgets).toEqual([60_000]);
});

it.each(["validating", "activating"] as const)(
  "ends an unsettled candidate within one --timeout budget during %s",
  async (phase) => {
    const record = prepareTimedUpdate();
    const observing = createDeferredCore();
    const healthResult = createDeferredCore<Awaited<ReturnType<GatewayService["readRuntime"]>>>();
    const health = vi.fn<GatewayService["readRuntime"]>(() => {
      observing.resolve();
      return healthResult.promise;
    });
    vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
      recordUpdateRunPhase(record.runId, phase, {}, params.opts.run);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
        createMockGatewayService({
          isLoaded: async () => true,
          readRuntime: health,
        }),
      );
      try {
        await verifyUpdatedGateway({
          result: { status: "ok", mode: "npm", root: params.root, steps: [], durationMs: 0 },
          opts: params.opts,
          serviceEnv: params.opts.run!.env,
          gatewayPort: 19305,
          expectedVersion: "2026.9.4",
          requireRunningService: true,
        });
      } catch {
        // A predecessor that cannot establish readiness must not get another budget.
        await verifyPreviousGatewayForUpdate({
          root: params.root,
          config: {},
          env: params.opts.run!.env,
          opts: params.opts,
        });
      }
      throw new Error("Unready Gateways must not complete successfully");
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const output = vi.mocked(defaultRuntime.writeJson);
    const running = runUpdate({ timeout: "60" }).catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        observing.promise,
        running,
        "Update settled before reaching readiness",
      );
      await vi.advanceTimersByTimeAsync(59_999);
      expect(output).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await running;
    } finally {
      healthResult.resolve({ status: "stopped" });
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
    }
    const terminal = getUpdateRun(record.runId);
    expect(terminal).toMatchObject(
      phase === "validating"
        ? { status: "failed", phase: "finished", reason: "update-activation-timeout" }
        : { status: "running", phase: "activating", finishedAtMs: null },
    );
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "update-activation-timeout" }),
    );
    expect(health).toHaveBeenCalledTimes(1);
  },
);

it.each(["timer", "monotonic"] as const)(
  "blocks a delayed forward effect after %s preparation expiry while retaining terminal bookkeeping",
  async (expiration) => {
    const record = prepareTimedUpdate();
    const observing = createDeferredCore();
    const resume = createDeferredCore();
    const effect = path.join(fixture.root, "forward-effect");
    const restored = path.join(fixture.root, "restored");
    let deadlineMs: number | undefined;
    vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
      recordUpdateRunPhase(record.runId, "validating", {}, params.opts.run);
      deadlineMs = params.opts.run!.deadline!.deadlineMs;
      observing.resolve();
      await resume.promise;
      params.executionGuards.assertCurrent("restore");
      fs.writeFileSync(restored, "compensation");
      params.executionGuards.assertCurrent();
      fs.writeFileSync(effect, "forward mutation");
      return null;
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const running = runUpdate({ timeout: "60" }).catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        observing.promise,
        running,
        "Update settled before the delayed forward effect",
      );
      if (expiration === "timer") {
        await vi.advanceTimersByTimeAsync(60_000);
      } else {
        vi.spyOn(performance, "now").mockReturnValue(deadlineMs!);
      }
    } finally {
      resume.resolve();
      await running;
    }
    expect(fs.existsSync(restored)).toBe(true);
    expect(fs.existsSync(effect)).toBe(false);
    expect(getUpdateRun(record.runId)).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "update-activation-timeout",
    });
  },
);

it.each(["before-launch", "at-input", "healthy"] as const)(
  "enforces Node installer preparation authority at %s",
  async (boundary) => {
    const record = prepareTimedUpdate();
    vi.mocked(processIdentity.getFileLockProcessStartTime).mockImplementation((pid) =>
      pid === process.pid ? 1_700_000_000 : readChildStart(pid),
    );
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        finishUpdateRun(record.runId, { status: "succeeded" }, params.opts.run);
        return null;
      });
    const effect = path.join(fixture.root, "installer-effect");
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let admittedRun: Awaited<ReturnType<typeof commandRun.admitUpdateCommandRun>> | undefined;
    const admit = commandRun.admitUpdateCommandRun;
    vi.spyOn(commandRun, "admitUpdateCommandRun").mockImplementation(async (params) => {
      admittedRun = await admit(params);
      return admittedRun;
    });
    const expire = () =>
      vi.spyOn(performance, "now").mockReturnValue(admittedRun!.deadline!.deadlineMs);
    const runCommand = processRunner.runCommandWithTimeout;
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) => {
      if (typeof options === "number") {
        throw new Error("Missing native gate options");
      }
      return runCommand(argv, {
        ...options,
        beforeInput: (pid, spawnedArgv) => {
          if (boundary === "at-input") {
            expire();
          }
          options.beforeInput?.(pid, spawnedArgv);
        },
      });
    });
    vi.mocked(runtimePlan.resolvePackageRuntimePreflight).mockImplementation(async (params) => {
      entered.resolve();
      await resume.promise;
      if (boundary === "before-launch") {
        expire();
      }
      const install = params.runtimeRecovery?.installCommand;
      if (!install) {
        throw new Error("Missing actual private Node runtime installer");
      }
      await install(
        process.execPath,
        ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'expired install')`],
        process.env,
      );
      return { ok: true, value: { nodeRunner: process.execPath } };
    });
    const running = runUpdate({ timeout: "60" }).catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        running,
        "Update settled before Node provisioning",
      );
    } finally {
      resume.resolve();
      await running;
    }
    expect(fs.existsSync(effect)).toBe(boundary === "healthy");
    expect(execute).toHaveBeenCalledTimes(boundary === "healthy" ? 1 : 0);
    if (boundary === "healthy") {
      expect(getUpdateRun(record.runId)).toMatchObject({ status: "succeeded", phase: "finished" });
    } else {
      expect(vi.mocked(defaultRuntime.writeJson)).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error" }),
      );
    }
  },
);

function prepareReadBoundaryUpdate(version: string) {
  const record = prepareTimedUpdate();
  selectVersion(version);
  let run: NonNullable<Parameters<typeof updateCommand>[0]["run"]> | undefined;
  const admit = commandRun.admitUpdateCommandRun;
  vi.spyOn(commandRun, "admitUpdateCommandRun").mockImplementation(async (params) => {
    run = await admit(params);
    return run;
  });
  const expire = () => {
    if (!run?.deadline || run.deadline.signal.aborted) {
      throw new Error("Read boundary did not hold an unexpired admitted deadline");
    }
    vi.spyOn(performance, "now").mockReturnValue(run.deadline.deadlineMs);
  };
  return { record, expire };
}

async function expectReadBoundaryResult(
  version: string,
  admission: "auto" | "installed",
  expired: boolean,
) {
  const running = runUpdate({ tag: version, admission, restart: false, timeout: "60" });
  if (expired) {
    await expect(running).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(vi.mocked(defaultRuntime.writeJson)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "update-activation-timeout" }),
    );
  } else {
    await running;
  }
}

it.each([false, true])(
  "settles already-current after real schema await expired=%s",
  async (expired) => {
    const { record, expire } = prepareReadBoundaryUpdate("2026.9.3");
    const marker = path.join(path.dirname(fixture.root), "current-core-effect");
    let crossed = false;
    const preflight = schema.preflightUpdateCommandSchemas;
    vi.spyOn(schema, "preflightUpdateCommandSchemas").mockImplementation(async (params) => {
      const result = await preflight(params);
      if (!result) {
        throw new Error("Real schema preflight did not admit current package");
      }
      crossed = true;
      if (expired) {
        expire();
      }
      return result;
    });
    vi.spyOn(noop, "finishAlreadyCurrentUpdate").mockImplementation(async (params) => {
      params.opts.run!.executorFence!.assertCurrent();
      fs.writeFileSync(marker, "current-core finalized");
      finishUpdateRun(
        record.runId,
        { status: "skipped", reason: "already-current" },
        { env: params.opts.run!.env },
      );
    });
    await expectReadBoundaryResult("2026.9.3", "installed", expired);
    const row = getUpdateRun(record.runId);
    expect(crossed).toBe(true);
    expect(fs.existsSync(marker)).toBe(!expired);
    expect(row).toMatchObject(
      expired
        ? { status: "failed", phase: "finished", reason: "update-activation-timeout" }
        : { status: "skipped", phase: "finished", reason: "already-current" },
    );
  },
);

it.each(["healthy", "version", "protocol"] as const)(
  "prevents actual candidate child after %s read",
  async (boundary) => {
    const { record, expire } = prepareReadBoundaryUpdate("2026.9.4");
    const home = path.dirname(fixture.root);
    const candidate = path.join(home, "candidate");
    const marker = path.join(home, "candidate-child-effect.json");
    fs.mkdirSync(path.join(candidate, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.4",
        type: "module",
        engines: { node: ">=22.19.0" },
        openclaw: {
          updateAdmissionProtocol: 1,
          schemaVersions: { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: 20 },
        },
      }),
    );
    const verdict = {
      protocol: 1,
      verdict: "admit",
      reasons: [],
      warnings: [],
      facts: {
        candidateVersion: "2026.9.4",
        installedVersion: "2026.9.3",
        checks: [{ name: "config", status: "ok" }],
      },
    };
    fs.writeFileSync(
      path.join(candidate, "dist", "index.js"),
      `import fs from "node:fs";
const context = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--context") + 1], "utf8"));
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, runId: context.run.id, state: process.env.OPENCLAW_STATE_DIR, config: process.env.OPENCLAW_CONFIG_PATH }));
console.log(${JSON.stringify(JSON.stringify(verdict))});
`,
    );
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue({
      root: candidate,
      run: async () => {
        throw new Error("Unexpected package activation in admission fixture");
      },
      close: async () => {},
    });
    let crossed = false;
    const readVersion = packageJson.readPackageVersion;
    vi.spyOn(packageJson, "readPackageVersion").mockImplementation(async (root) => {
      const result = await readVersion(root);
      if (root === candidate && boundary === "version") {
        crossed = true;
        expire();
      }
      return result;
    });
    let inAdmission = false;
    const admit = admissionOwner.runUpdateCandidateAdmission;
    vi.spyOn(admissionOwner, "runUpdateCandidateAdmission").mockImplementation(async (params) => {
      inAdmission = true;
      try {
        return await admit(params);
      } finally {
        inAdmission = false;
      }
    });
    const readJson = jsonFiles.tryReadJson;
    vi.spyOn(jsonFiles, "tryReadJson").mockImplementation(async (...args) => {
      const result = await readJson(...args);
      if (
        inAdmission &&
        args[0] === path.join(candidate, "package.json") &&
        boundary === "protocol"
      ) {
        crossed = true;
        expire();
      }
      return result;
    });
    vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
      finishUpdateRun(record.runId, { status: "succeeded" }, { env: params.opts.run!.env });
      return null;
    });
    await expectReadBoundaryResult("2026.9.4", "auto", boundary !== "healthy");
    const row = getUpdateRun(record.runId);
    const effect = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : null;
    if (boundary !== "healthy") {
      expect(crossed).toBe(true);
    }
    if (effect) {
      expect(effect.runId).toBe(record.runId);
      expect(effect.state).toBe(process.env.OPENCLAW_STATE_DIR);
      expect(effect.config).toBe(process.env.OPENCLAW_CONFIG_PATH);
      expect(effect.pid).not.toBe(process.pid);
    }
    expect(Boolean(effect)).toBe(boundary === "healthy");
    expect(row).toMatchObject(
      boundary === "healthy"
        ? { status: "succeeded", phase: "finished" }
        : { status: "failed", phase: "finished", reason: "update-activation-timeout" },
    );
  },
);
