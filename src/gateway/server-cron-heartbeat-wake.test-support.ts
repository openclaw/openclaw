import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "../infra/heartbeat-wake.js";
import type { GatewayCronState } from "./server-cron.js";

type CronHeartbeatWakeTestHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig) => GatewayCronState;
  withCronService: (
    cfg: OpenClawConfig,
    run: (state: GatewayCronState) => Promise<void>,
  ) => Promise<void>;
  getCronDeps: (state: GatewayCronState) => {
    requestHeartbeat?: (opts: HeartbeatWakeRequest) => void;
  };
  getCronState: (state: GatewayCronState) => CronServiceState;
  requestHeartbeatMock: Mock;
  requestHeartbeatAndWaitMock: Mock<(...args: unknown[]) => Promise<HeartbeatRunResult>>;
};

export function registerGatewayCronHeartbeatWakeTests({
  createCronConfig,
  loadCronService,
  withCronService,
  getCronDeps,
  getCronState,
  requestHeartbeatMock,
  requestHeartbeatAndWaitMock,
}: CronHeartbeatWakeTestHarness) {
  it("preserves live monitor failure ownership through the registered Gateway adapter", async () => {
    const cfg = {
      ...createCronConfig("server-cron-heartbeat-failure-owner"),
      agents: { entries: { main: { heartbeat: { every: "5m" } } } },
      cron: {
        ...createCronConfig("server-cron-heartbeat-failure-owner-store").cron,
        failureAlert: { enabled: true, after: 2, channel: "telegram", to: "-1002222222222" },
      },
    } satisfies OpenClawConfig;
    let owners: readonly (() => boolean)[] | undefined;
    requestHeartbeatAndWaitMock.mockImplementationOnce(async (request) => {
      owners = (request as { failureNotificationOwners?: readonly (() => boolean)[] })
        .failureNotificationOwners;
      expect(owners).toHaveLength(1);
      expect(owners?.some((owner) => owner())).toBe(true);
      return { status: "failed", reason: "agent-runner-failure" };
    });
    await withCronService(cfg, async (state) => {
      await state.reconcileSystemJobs();
      const monitor = (await state.cron.list({ includeDisabled: true })).find(
        (job) => job.payload.kind === "heartbeat" && job.agentId === "main",
      );
      expect(monitor).toBeDefined();
      if (!monitor) {
        throw new Error("expected a reconciled heartbeat monitor");
      }
      await expect(state.cron.run(monitor.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce();
      expect(state.cron.getJob(monitor.id)?.state.lastRunStatus).toBe("error");
      expect(owners?.some((owner) => owner())).toBe(false);
    });
  });

  it("forwards heartbeat overrides through the cron wake adapter", () => {
    const cfg = createCronConfig("server-cron-heartbeat-override");
    const failureNotificationOwners = [() => true];
    const state = loadCronService(cfg);
    try {
      const cronDeps = getCronDeps(state);

      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        sessionKey: "discord:channel:ops",
        heartbeat: { target: "last" },
        scheduledEveryMs: 15 * 60_000,
        failureNotificationOwners,
      });

      expect(requestHeartbeatMock).toHaveBeenCalledWith({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        agentId: "main",
        sessionKey: "agent:main:discord:channel:ops",
        heartbeat: { target: "last", to: undefined, accountId: undefined },
        scheduledEveryMs: 15 * 60_000,
        failureNotificationOwners,
      });
    } finally {
      state.cron.stop();
    }
  });

  it("returns the settled heartbeat result through the cron wake adapter", async () => {
    requestHeartbeatAndWaitMock.mockResolvedValueOnce({
      status: "failed",
      reason: "agent-runner-failure",
    });
    await withCronService(createCronConfig("server-cron-heartbeat-settlement"), async (state) => {
      const lifecycle = { abortSignal: new AbortController().signal };
      await expect(
        getCronState(state).deps.requestHeartbeatAndWait?.(
          {
            source: "interval",
            intent: "task",
            reason: "heartbeat-task:report",
            agentId: "main",
            scheduledEveryMs: 15 * 60_000,
            tasks: [{ jobId: "report", name: "report", prompt: "Run report" }],
          },
          lifecycle,
        ),
      ).resolves.toEqual({ status: "failed", reason: "agent-runner-failure" });
      expect(requestHeartbeatAndWaitMock).toHaveBeenCalledWith(
        {
          source: "interval",
          intent: "task",
          reason: "heartbeat-task:report",
          agentId: "main",
          sessionKey: undefined,
          heartbeat: undefined,
          scheduledEveryMs: 15 * 60_000,
          tasks: [{ jobId: "report", name: "report", prompt: "Run report" }],
        },
        lifecycle,
      );
    });
  });
}
