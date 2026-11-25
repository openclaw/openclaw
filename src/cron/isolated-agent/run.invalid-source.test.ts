import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
} from "../../gateway/openclaw-id/tunnel-principal.js";
import { restoreGatewayOperatorSource } from "../../gateway/operator-run-recovery.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { linkOpenClawIdUserProfile } from "../../state/user-profile-openclaw-id.worker.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { CronOperatorSourceError } from "../operator-source-error.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "../service.test-harness.js";
import { resolveCronOperatorExecutionRevision } from "../service/jobs-tool-policy.js";
import type { CronServiceDeps } from "../service/state.js";
import { onTimer } from "../service/timer.test-support.js";
import type { CronStoredJob } from "../types.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
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

  it("hydrates membership and retains the Guest sandbox when its role gains unrelated scopes", async () => {
    const scenario = memberSourceCase("removed member");
    const role = expectDefined(scenario.cfg.gateway?.roles?.definitions.guest, "guest role");
    role.scopes = [...role.scopes, "operator.read"];
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
    const restored = await restoreGatewayOperatorSource({
      agentId: "main",
      snapshot: scenario.operatorSource.source.snapshot,
      context: createContext([], () => scenario.cfg),
      assertCurrent() {},
    });
    try {
      expect(hydrated).toBe(true);
      expect(restored.authority.rolePolicy?.sandboxRequired).toBe(true);
      expect(restored.authority.scopes).toEqual(["operator.sessions.write", "operator.cron"]);
    } finally {
      restored.release();
    }
  });

  it("does not turn aborted membership hydration into an authority refusal", async () => {
    const scenario = memberSourceCase("removed member");
    const controller = new AbortController();
    setOpenClawIdTunnelPrincipalLookup(
      () => undefined,
      async () => controller.abort(),
    );
    const failure = await restoreGatewayOperatorSource({
      agentId: "main",
      snapshot: scenario.operatorSource.source.snapshot,
      context: createContext([], () => scenario.cfg),
      assertCurrent: () => controller.signal.throwIfAborted(),
    }).catch((error: unknown) => error);
    expect(controller.signal.aborted).toBe(true);
    expect(failure).toBe(controller.signal.reason);
  });

  it.each(["undecodable", ...memberSourceCases, "membership revoked while parked"] as const)(
    "records the first recurring authority failure without executing: %s",
    async (name) => {
      const revokeWhileParked = name === "membership revoked while parked";
      const scenario =
        name === "undecodable"
          ? undefined
          : memberSourceCase(revokeWhileParked ? "removed member" : name);
      let memberActive = true;
      if (revokeWhileParked && scenario) {
        const principal = scenario.principal;
        setOpenClawIdMemberAccountLookup(
          (accountId) => memberActive && accountId === principal.accountId,
        );
        setOpenClawIdTunnelPrincipalLookup(() => (memberActive ? principal : undefined));
      }
      const unavailable =
        Boolean(scenario?.transientError) || name === "disabled membership lookup";
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
      if (job.operatorSource) {
        job.operatorSource.executionRevision = resolveCronOperatorExecutionRevision(job);
      }
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>((request) =>
        runAgent(
          makeIsolatedAgentParamsFixture({
            ...request,
            cfg: scenario?.cfg ?? {},
            sessionKey: `cron:${request.job.id}`,
            ...(revokeWhileParked
              ? {
                  providerRunSlot: {
                    tryStart: () => false,
                    wait: async () => {
                      memberActive = false;
                    },
                  },
                }
              : {}),
          }),
        ),
      );
      const enqueueSystemEvent = vi.fn();
      const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
        async () => {},
      );
      const context = createContext([], () => scenario?.cfg ?? {});
      context.resolveGatewayContext = () => context;
      const { cron, state } = createCronServiceWithStateForTest({
        scheduler: createTestGatewayScheduler(clock.clock),
        nowMs: clock.clock.now,
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent,
        sendCronFailureAlert,
        runSchedulerOwned: createScheduledGatewayRunner(() => context),
        runIsolatedAgentJob,
      });
      context.cron = cron;
      try {
        await cron.start();
        clock.setTime(nowMs + 60_001);
        await onTimer(state);
        await cron.waitForIdle();
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        expect(cron.getJob(job.id)).toMatchObject({
          enabled: unavailable,
          state: { lastRunStatus: "error", consecutiveErrors: 1 },
        });
        if (unavailable) {
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
        if (unavailable) {
          expect(result).toMatchObject({
            status: "error",
            error: "Gateway access policy is unavailable; retry the operation.",
            errorClassification: { kind: "reason", reason: "server_error" },
            executionStarted: false,
          });
          expect(history.entries[0]).toMatchObject({
            status: "error",
            error: "Gateway access policy is unavailable; retry the operation.",
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
          if (
            scenario &&
            !["changed role", "deleted role definition", "unknown role", "lost scope"].includes(
              name,
            )
          ) {
            expect(result).toMatchObject({
              error: new CronOperatorSourceError(
                new Error(
                  [
                    "removed member",
                    "changed account",
                    "changed listing",
                    "membership revoked while parked",
                  ].includes(name)
                    ? "I did not start this request. The sign-in it was started with is no longer valid. Reconnect to the Gateway, then send your message again."
                    : scenario.refusal,
                ),
              ).message,
            });
          }
          expect(history.entries[0]).toMatchObject({
            status: "error",
            error: expect.stringContaining(
              "operator authority that created this automation was refused",
            ),
          });
        }
        if (unavailable) {
          // A transient admission outage schedules a quick retry before alerting.
          expect(sendCronFailureAlert).not.toHaveBeenCalled();
        } else {
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
        }
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        if (revokeWhileParked) {
          expect(memberActive).toBe(false);
        } else {
          expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
        }
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
