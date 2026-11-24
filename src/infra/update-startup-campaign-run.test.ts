import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as sentinelStore from "./restart-sentinel.js";
import { UpdateCampaignController } from "./update-campaign.js";
import { createUpdateRun, finishUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import {
  runAutoUpdateCommand,
  runCampaignUpdate,
  type AutoUpdateRunner,
} from "./update-startup-auto-run.js";
import {
  matchingObject,
  containingObject,
  updateResult,
} from "./update-startup-suite.test-support.js";
import type { UpdateStepResult } from "./update-step-result.js";

const { prepare, restart } = vi.hoisted(() => ({
  prepare: vi.fn<typeof import("../update/run.js").prepareUpdate>(),
  restart: vi.fn(),
}));
vi.mock("../update/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../update/run.js")>()),
  prepareUpdate: prepare,
}));
vi.mock("./update-triage.js", () => ({
  runUpdateFailureTriage: vi.fn(async () => ({
    status: "completed",
    hint: "Inspect the recorded update failure.",
  })),
}));
vi.mock("./restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart.js")>()),
  scheduleGatewayRestart: restart,
}));

const campaigns = new Set<UpdateCampaignController>();

function runAdmittedUpdate(runId: string, params: Partial<Parameters<AutoUpdateRunner>[0]> = {}) {
  return runAutoUpdateCommand(
    {
      runId,
      channel: "beta",
      mode: "npm",
      root: "/opt/openclaw",
      packageTargetVersion: "2.0.0-beta.1",
      timeoutMs: 1_000,
      restartDrainTimeoutMs: undefined,
      ...params,
    },
    { info: vi.fn() },
  );
}

function doctorFacts(message: string) {
  return [{ check: "doctor", code: "doctor-failed", message }];
}

function createApplyingCampaign(version = "2.0.0-beta.1") {
  const campaign = new UpdateCampaignController(createTestGatewayScheduler());
  campaigns.add(campaign);
  campaign.announce({
    target: { kind: "package", version },
    inspect: { getQueueSize: () => 1 },
    apply: async () => "failed",
    onChange: () => {},
  });
  campaign.adopt();
  return campaign;
}

function runBetaCampaign(
  params: Pick<Parameters<typeof runCampaignUpdate>[0], "campaign" | "runAuto"> &
    Partial<Parameters<typeof runCampaignUpdate>[0]>,
) {
  return runCampaignUpdate({
    channel: "beta",
    mode: "npm",
    version: "2.0.0-beta.1",
    tag: "beta",
    forced: false,
    root: "/opt/openclaw",
    log: { info: vi.fn() },
    canApply: () => true,
    onAttempt: () => {},
    ...params,
  });
}

describe("automatic release campaigns", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-release-campaign-",
      env: { OPENCLAW_PROFILE: undefined, OPENCLAW_SUPERVISOR_MODE: undefined },
    });
    prepare.mockReset();
    restart.mockClear();
  });

  afterEach(async () => {
    for (const campaign of campaigns) {
      campaign.clear();
    }
    campaigns.clear();
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    await state.cleanup();
  });

  it.each([
    { mode: "npm", channel: "beta", packageTargetVersion: "2.0.0-beta.1" },
    { mode: "git", channel: "dev", packageTargetVersion: undefined },
  ] as const)("prepares the pinned $mode release and restarts into its trial", async (target) => {
    const devTarget =
      target.mode === "git"
        ? { mode: "tracked" as const, upstreamRef: "origin/main", upstreamSha: "pinned-sha" }
        : undefined;
    prepare.mockResolvedValueOnce({
      status: "pending",
      target: { version: "2.0.0-beta.1" },
      releaseRoot: "/tmp/release",
    });
    const { runId } = createUpdateRun({ trigger: "campaign" });

    await expect(runAdmittedUpdate(runId, { ...target, devTarget })).resolves.toEqual({
      status: "handoff",
    });

    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId,
        runningRoot: "/opt/openclaw",
        channel: target.channel,
        tag: target.packageTargetVersion,
        ...(devTarget ? { sha: "pinned-sha" } : {}),
        timeoutMs: 1_000,
      }),
    );
    expect(listUpdateRuns()[0]).toMatchObject({ runId, phase: "restarting", status: "running" });
    expect(restart).toHaveBeenCalledExactlyOnceWith({ reason: "update.auto" });
  });

  it.each([false, true])(
    "restarts an already-current release only when plugin maintenance changed it (%s)",
    async (pluginsChanged) => {
      prepare.mockResolvedValueOnce({ status: "current", version: "1.0.0", pluginsChanged });
      const { runId } = createUpdateRun({ trigger: "campaign" });

      await expect(runAdmittedUpdate(runId)).resolves.toMatchObject({
        status: "failed",
        result: { status: "skipped", reason: "already-current" },
      });

      if (pluginsChanged) {
        expect(restart).toHaveBeenCalledExactlyOnceWith({ reason: "update.auto" });
      } else {
        expect(restart).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    "unchanged",
    "new candidate",
    "manual update",
    "different reason",
    "different check",
    "different detail",
    "transient metadata",
    "rolled back",
  ] as const)("backs off only identical activation failures across restart: %s", async (resume) => {
    const log = { info: vi.fn() };
    const step: UpdateStepResult = {
      name: "openclaw doctor",
      command: "doctor",
      cwd: "/private/candidate",
      durationMs: 10,
      exitCode: 1,
      stderrTail: "Plugin dependency is unavailable: chromium-bidi",
    };
    const outcome: Awaited<ReturnType<AutoUpdateRunner>> = {
      status: "failed",
      message: "Doctor failed after activation.",
      result: updateResult({ reason: "doctor-failed", steps: [step], durationMs: 10 }),
    };
    const runAuto = vi.fn<AutoUpdateRunner>(async ({ runId }) => {
      if (resume === "rolled back") {
        // The updater's terminal owner records a restored previous release as rolled-back.
        finishUpdateRun(runId, {
          status: "rolled-back",
          reason: outcome.result.reason,
          diagnostics: outcome.result,
        });
      }
      return structuredClone(outcome);
    });
    const attempt = async (version = "2.0.0-beta.1") => {
      const campaign = createApplyingCampaign(version);
      try {
        return await runBetaCampaign({ version, log, campaign, runAuto });
      } finally {
        campaign.clear();
      }
    };
    if (resume === "transient metadata") {
      step.failureFacts = doctorFacts("Check failed (5ms)");
    }
    await attempt();
    if (resume === "different reason") {
      outcome.result.reason = "candidate-checks-timeout";
    } else if (resume === "different check") {
      step.name = "activated-gateway-startup";
    } else if (resume === "different detail") {
      step.stderrTail = "A different dependency is unavailable: kerberos";
    } else if (resume === "transient metadata") {
      step.failureFacts = doctorFacts("Check failed (19ms)");
    }
    await attempt();
    expect(runAuto).toHaveBeenCalledTimes(2);
    const failures = listUpdateRuns();
    expect(failures).toHaveLength(2);
    await closeStateDatabaseForTest();
    await attempt();
    if (resume.startsWith("different")) {
      expect(runAuto).toHaveBeenCalledTimes(3);
      return;
    }
    expect(runAuto).toHaveBeenCalledTimes(2);
    expect(listUpdateRuns()).toHaveLength(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Automatic updates paused after repeated activation failure"),
      expect.objectContaining({
        version: "2.0.0-beta.1",
        runIds: failures.map((run) => run.runId),
        nextAction: expect.stringContaining("openclaw update"),
      }),
    );
    if (resume === "manual update") {
      const manual = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(manual.runId, { status: "failed", reason: "doctor-failed" });
    }
    await attempt(resume === "new candidate" ? "2.0.0-beta.2" : undefined);
    expect(runAuto).toHaveBeenCalledTimes(
      resume === "new candidate" || resume === "manual update" ? 3 : 2,
    );
  });

  it.each([
    { failures: 1, wait: 0 },
    { failures: 2, wait: 2 },
    { failures: 5, wait: 16 },
    { failures: 6, wait: 24 },
  ])(
    "waits $wait h after $failures identical pre-mutation refusals",
    async ({ failures, wait }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const hour = 60 * 60 * 1000;
        const failedAt = Date.UTC(2026, 10, 21);
        vi.setSystemTime(failedAt - failures * hour);
        // A manual run older than the streak does not reset it.
        finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, { status: "succeeded" });
        for (let index = 0; index < failures; index += 1) {
          vi.setSystemTime(failedAt - (failures - 1 - index) * hour);
          const { runId } = createUpdateRun({
            trigger: "campaign",
            target: { channel: "beta", kind: "package", version: "2.0.0-beta.1" },
          });
          finishUpdateRun(runId, { status: "failed", reason: "no-target" });
        }
        const log = { info: vi.fn() };
        const runAuto = vi.fn<AutoUpdateRunner>(async () => ({
          status: "failed",
          message: "The pinned package target is unavailable.",
          result: updateResult({ reason: "no-target" }),
        }));
        const attempt = async (atMs: number, version = "2.0.0-beta.1") => {
          vi.setSystemTime(atMs);
          const campaign = createApplyingCampaign(version);
          try {
            await runBetaCampaign({ version, log, campaign, runAuto });
          } finally {
            campaign.clear();
          }
          return runAuto.mock.calls.length;
        };
        if (wait > 0) {
          await expect(attempt(failedAt + wait * hour - 60_000)).resolves.toBe(0);
          expect(log.info).toHaveBeenCalledWith(
            expect.stringContaining(`deferred after ${failures} identical failures`),
            expect.objectContaining({ reason: "no-target" }),
          );
        }
        await expect(attempt(failedAt + wait * hour + 60_000)).resolves.toBe(1);
        // A new candidate is not held by the previous target's streak.
        await expect(attempt(failedAt + wait * hour + 60_000, "2.0.0-beta.2")).resolves.toBe(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not clear a replacement campaign after sentinel settlement", async () => {
    const campaign = createApplyingCampaign();
    const persisted = createDeferred();
    const release = createDeferred();
    const write = sentinelStore.writeRestartSentinelIfUnchanged;
    const spy = vi
      .spyOn(sentinelStore, "writeRestartSentinelIfUnchanged")
      .mockImplementationOnce(async (params) => {
        const result = await write(params);
        persisted.resolve();
        await release.promise;
        return result;
      });
    const operation = runBetaCampaign({
      campaign,
      onAttempt: vi.fn(),
      runAuto: async () => ({
        status: "skipped",
        message: "Already current",
        result: updateResult({ status: "skipped", reason: "already-current" }),
      }),
    });
    try {
      await awaitGateBeforeSettlement(
        persisted.promise,
        operation,
        "Campaign did not persist its sentinel",
      );
      campaign.clear();
      campaign.announce({
        target: { kind: "package", version: "3.0.0" },
        inspect: { getQueueSize: () => 1 },
        apply: async () => "failed",
        onChange: () => {},
      });
      const replacement = campaign.getState()?.id;
      release.resolve();
      await expect(operation).resolves.toBe("failed");
      expect(campaign.getState()?.id).toBe(replacement);
    } finally {
      release.resolve();
      await operation;
      spy.mockRestore();
      campaign.clear();
    }
  });

  it.each(["read", "write"])(
    "preserves the original campaign exception when diagnostics %s fails",
    async (failure) => {
      const campaign = createApplyingCampaign();
      const original = new Error("automatic update failed");
      const log = { info: vi.fn() };

      await expect(
        runBetaCampaign({
          log,
          campaign,
          runAuto: async () => {
            const fail = () => {
              throw new Error("diagnostic persistence unavailable");
            };

            if (failure === "read") {
              vi.spyOn(
                await import("./update-run-reader.js"),
                "getUpdateRunAsync",
              ).mockImplementationOnce(fail);
            } else {
              vi.spyOn(
                await import("../state/openclaw-state-worker-store.js"),
                "runOpenClawStateWorkerOperation",
              ).mockImplementationOnce(fail);
            }
            throw original;
          },
        }),
      ).rejects.toBe(original);
      const run = expectDefined(listUpdateRuns()[0], "failed campaign run");
      expect(run).toMatchObject({
        status: "failed",
        reason: "unexpected-error",
        ...(failure === "read"
          ? {
              steps: containingObject({
                step: "requested",
                failureFacts: matchingObject({ message: "automatic update failed" }),
              }),
            }
          : {}),
      });
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining(
          failure === "read"
            ? "Update history could not be read"
            : "Update diagnostics could not be recorded",
        ),
      );
    },
  );
});
