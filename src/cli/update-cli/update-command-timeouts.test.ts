import { afterEach, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import * as executorOwner from "./update-command-executor.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as noop from "./update-command-noop.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";
import * as commandRun from "./update-command-run.js";
import * as runtimePlan from "./update-command-runtime-preflight.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import { updateCommand } from "./update-command.js";

installFreshUpdateFixture();

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

it("ends an unsettled candidate and unready predecessor within one --timeout budget", async () => {
  prepareTimedUpdate();
  const observing = createDeferredCore();
  const health = vi.fn<GatewayService["readRuntime"]>(() => {
    observing.resolve();
    return new Promise(() => {});
  });
  vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
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
  await observing.promise;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(output).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", reason: "update-activation-timeout" }),
  );
  expect(health).toHaveBeenCalledTimes(1);
});
