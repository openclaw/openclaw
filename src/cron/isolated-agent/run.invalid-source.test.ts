import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
} from "../../gateway/openclaw-id/tunnel-principal.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkOpenClawIdUserProfile } from "../../state/user-profile-openclaw-id.worker.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { CronOperatorSourceError } from "../operator-source-error.js";
import { readCronOperatorSnapshotForRun } from "../operator-source-snapshot.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "../service.test-harness.js";
import type { CronServiceDeps } from "../service/state.js";
import { onTimer } from "../service/timer.test-support.js";
import type { CronStoredJob } from "../types.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { prepareCronCreatorSandbox } from "./run-creator-sandbox.js";
import {
  memberSourceCase as createMemberSourceCase,
  memberSourceCases,
} from "./run.invalid-source.test-support.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runAgent = await h.loadRunCronIsolatedAgentTurn();

function memberSourceCase(name: (typeof memberSourceCases)[number]) {
  const scenario = createMemberSourceCase(name);
  const { profileId } = scenario.operatorSource.source.snapshot;
  const principal = expectDefined(
    scenario.operatorSource.source.snapshot.openclawIdPrincipal,
    "scheduled member principal",
  );
  if (principal.kind !== "member") {
    throw new Error("Expected a scheduled member principal");
  }
  scenario.cfg.gateway!.openclawId = { enabled: true };
  linkOpenClawIdUserProfile({ profileId, accountId: principal.accountId, email: null }, {});
  setOpenClawIdMemberAccountLookup(
    (accountId) =>
      name !== "removed member" &&
      name !== "disabled membership lookup" &&
      accountId === (name === "changed account" ? "other-account" : principal.accountId),
  );
  return { ...scenario, principal };
}

describe("undecodable scheduled authority", () => {
  setupRunCronIsolatedAgentTurnSuite();
  const { logger, makeStorePath } = setupCronServiceSuite({
    prefix: "cron-invalid-source-",
    fakeTimers: false,
  });

  afterEach(() => {
    setOpenClawIdTunnelPrincipalLookup(undefined);
    setOpenClawIdMemberAccountLookup(undefined);
  });

  it.each([undefined, { version: 1 }, { version: 1, snapshot: null }])(
    "refuses preparation before creating an unsandboxed session or running inference: %j",
    async (source) => {
      const job = makeIsolatedAgentJobFixture({
        operatorSource: { executionRevision: "invalid", source },
      });
      expect(() => readCronOperatorSnapshotForRun(job)).toThrow(CronOperatorSourceError);
      await expect(
        runAgent(
          makeIsolatedAgentParamsFixture({
            job,
          }),
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: expect.stringMatching(
          /operator authority that created this automation was refused.*Restart recovery operator source/,
        ),
        errorClassification: { kind: "permanent" },
        executionStarted: false,
        admissionDisposition: "rejected",
      });
      expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
      expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
    },
  );

  it("hydrates stored membership before deciding that its authority was removed", async () => {
    const scenario = memberSourceCase("removed member");
    let hydrated = false;
    setOpenClawIdMemberAccountLookup(
      (accountId) => hydrated && accountId === scenario.principal.accountId,
    );
    setOpenClawIdTunnelPrincipalLookup(
      () => (hydrated ? scenario.operatorSource.source.snapshot.openclawIdPrincipal : undefined),
      async () => {
        hydrated = true;
      },
    );
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const sessionBoundary = new Error("prepared session boundary");
    h.resolveCronSessionMock.mockRejectedValueOnce(sessionBoundary);
    await expect(
      runAgent(
        makeIsolatedAgentParamsFixture({
          cfg: scenario.cfg,
          job: makeIsolatedAgentJobFixture({
            operatorSource: scenario.operatorSource,
            createdActor: {
              type: "human",
              source: "profile",
              id: scenario.operatorSource.source.snapshot.profileId,
            },
          }),
        }),
      ),
    ).rejects.toBe(sessionBoundary);
    expect(hydrated).toBe(true);
    expect(h.resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("retains the Guest sandbox when its current role gains unrelated scopes", async () => {
    const scenario = memberSourceCase("removed member");
    const role = expectDefined(scenario.cfg.gateway?.roles?.definitions.guest, "guest role");
    role.scopes = [...role.scopes, "operator.read"];
    setOpenClawIdMemberAccountLookup((accountId) => accountId === scenario.principal.accountId);
    setOpenClawIdTunnelPrincipalLookup(
      () => scenario.operatorSource.source.snapshot.openclawIdPrincipal,
    );
    const params = makeIsolatedAgentParamsFixture({
      cfg: scenario.cfg,
      job: makeIsolatedAgentJobFixture({
        operatorSource: scenario.operatorSource,
        createdActor: {
          type: "human",
          source: "profile",
          id: scenario.operatorSource.source.snapshot.profileId,
        },
      }),
    });
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    await expect(prepareCronCreatorSandbox(params.cfg, params.job)).resolves.toBe("required");
  });

  it("does not permanently retire an attempt aborted during membership hydration", async () => {
    const scenario = memberSourceCase("removed member");
    const controller = new AbortController();
    setOpenClawIdTunnelPrincipalLookup(
      () => undefined,
      async () => controller.abort(),
    );
    const params = makeIsolatedAgentParamsFixture({
      cfg: scenario.cfg,
      job: makeIsolatedAgentJobFixture({
        operatorSource: scenario.operatorSource,
        createdActor: {
          type: "human",
          source: "profile",
          id: scenario.operatorSource.source.snapshot.profileId,
        },
      }),
      abortSignal: controller.signal,
    });
    await expect(runAgent(params)).rejects.not.toBeInstanceOf(CronOperatorSourceError);
    expect(controller.signal.aborted).toBe(true);
    expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each(["undecodable", ...memberSourceCases] as const)(
    "records the first recurring authority failure without executing: %s",
    async (name) => {
      const scenario = name === "undecodable" ? undefined : memberSourceCase(name);
      const { storePath } = await makeStorePath();
      const nowMs = Date.now();
      const clock = createGatewaySchedulerClock(nowMs);
      const job: CronStoredJob = makeIsolatedAgentJobFixture({
        enabled: true,
        agentId: "main",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs },
        wakeMode: "next-heartbeat",
        delivery: { mode: "none" },
        failureAlert: { after: 1, channel: "telegram", to: "fixture-recipient" },
        state: { nextRunAtMs: nowMs + 60_000 },
        operatorSource: scenario?.operatorSource ?? {
          executionRevision: "invalid",
          source: { version: 1, snapshot: null },
        },
      });
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>((request) =>
        runAgent(
          makeIsolatedAgentParamsFixture({
            ...request,
            cfg: scenario?.cfg ?? {},
            sessionKey: `cron:${request.job.id}`,
          }),
        ),
      );
      const enqueueSystemEvent = vi.fn();
      const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
        async () => {},
      );
      const { cron, state } = createCronServiceWithStateForTest({
        scheduler: createTestGatewayScheduler(clock.clock),
        nowMs: clock.clock.now,
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent,
        sendCronFailureAlert,
        runIsolatedAgentJob,
      });
      try {
        await cron.start();
        clock.setTime(nowMs + 60_001);
        await onTimer(state);
        await cron.waitForIdle();
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        expect(cron.getJob(job.id)).toMatchObject({
          enabled: Boolean(scenario?.transientError),
          state: { lastRunStatus: "error", consecutiveErrors: 1 },
        });
        if (scenario?.transientError) {
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeGreaterThan(clock.clock.now());
        } else {
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
        }
        expect(cron.getJob(job.id)?.state.autoDisabled).toBeUndefined();
        const result = await runIsolatedAgentJob.mock.results[0]?.value.catch(
          (error: unknown) => error,
        );
        const history = readCronRunHistoryPageForTests({ storeKey: storePath });
        expect(history.entries).toHaveLength(1);
        if (scenario?.transientError) {
          expect(result).toBe(scenario.transientError);
          expect(result).not.toBeInstanceOf(CronOperatorSourceError);
          expect(history.entries[0]).toMatchObject({
            status: "error",
            error: scenario.transientError.message,
          });
        } else {
          expect(result).toMatchObject({ error: history.entries[0]?.error });
          expect(result).toMatchObject({
            status: "error",
            error: expect.stringContaining(
              "operator authority that created this automation was refused",
            ),
            errorClassification: { kind: "permanent" },
            executionStarted: false,
            admissionDisposition: "rejected",
          });
          if (scenario) {
            expect(result).toMatchObject({
              error: new CronOperatorSourceError(new Error(scenario.refusal)).message,
            });
          }
          expect(history.entries[0]).toMatchObject({
            status: "error",
            error: expect.stringContaining(scenario?.refusal ?? "Restart recovery operator source"),
          });
        }
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expect(sendCronFailureAlert).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            to: "fixture-recipient",
            payload: {
              text: 'Automation "Test Job" failed\nCheck automation history for details.',
            },
          }),
        );
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
        expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(h.runCliAgentMock).not.toHaveBeenCalled();
        expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    },
  );
});
