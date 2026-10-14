// Cron failure alert tests cover notification behavior for failed scheduled jobs.
import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  alertCallArg,
  createTelegramDelivery,
  expectAlertFields,
  expectAlertTextContaining,
  setupFailureAlertSuite,
} from "./service.failure-alert.test-helpers.js";
import type { CronFailureNotificationDetail } from "./types.js";

const { withFailureAlertCron } = setupFailureAlertSuite();
type AlertParams = Parameters<typeof withFailureAlertCron>;

function withAlerts(run: AlertParams[1], options: Omit<AlertParams[0], "scheduler"> = {}) {
  return withFailureAlertCron(
    {
      scheduler: createTestGatewayScheduler(),
      failureAlert: { enabled: true, after: 1 },
      ...options,
    },
    run,
  );
}

describe("CronService failure alerts", () => {
  it("alerts once for blocked local-provider runs and recovers without repair or backoff", async () => {
    const error = "Local provider unavailable at http://127.0.0.1:11434 (private diagnostic)";
    const blocked = {
      status: "skipped" as const,
      error,
      diagnostics: {
        entries: [
          {
            ts: Date.now(),
            source: "model-preflight" as const,
            severity: "warn" as const,
            message: error,
          },
        ],
      },
    };
    await withAlerts(
      async ({ cron, sendCronFailureAlert, runCronFailureRepair, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("local report", {
          delivery: createTelegramDelivery(),
          owner: { sessionKey: "agent:main:owner" },
        });
        for (let count = 1; count <= 3; count++) {
          vi.setSystemTime(cron.getJob(job.id)!.state.nextRunAtMs!);
          await expect(cron.run(job.id, "due")).resolves.toEqual({ ok: true, ran: true });
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(count < 2 ? 0 : 1);
          expect(cron.getJob(job.id)).toMatchObject({
            enabled: true,
            state: {
              lastRunStatus: "skipped",
              lastError: error,
              consecutiveErrors: 0,
              consecutiveSkipped: count,
              nextRunAtMs: Date.now() + 60_000,
            },
          });
        }
        const alert = alertCallArg(sendCronFailureAlert);
        expect(alert.text).toContain("local model provider is unreachable");
        expect(alert.text).toContain("Start the provider or check its configured endpoint");
        expect(alert.text).toContain("will check again on a later scheduled run");
        expect(alert.text).not.toContain("private diagnostic");
        expect(runCronFailureRepair).not.toHaveBeenCalled();

        vi.setSystemTime(Date.now() + 3_600_000);
        await cron.run(job.id, "due");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        runIsolatedAgentJob.mockResolvedValue({
          ...blocked,
          error: "Local provider unavailable at http://127.0.0.1:1234",
        });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);

        runIsolatedAgentJob.mockResolvedValue({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expect(cron.getJob(job.id)?.state.failureAlertIncident).toBeUndefined();
        expect(cron.getJob(job.id)?.state.lastFailureAlertAtMs).toBeUndefined();

        runIsolatedAgentJob.mockResolvedValue(blocked);
        for (const mode of ["due", "force"] as const) {
          const atMs = Date.now() + 60_000;
          const oneShot = await addJob(`one-shot ${mode}`, {
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
            delivery: createTelegramDelivery(),
            failureAlert: { after: 1 },
          });
          if (mode === "due") {
            vi.setSystemTime(atMs);
          }
          await expect(cron.run(oneShot.id, mode)).resolves.toEqual({ ok: true, ran: true });
          const saved = cron.getJob(oneShot.id);
          expect(saved?.enabled).toBe(mode === "force");
          expect(saved?.state.nextRunAtMs).toBe(mode === "force" ? atMs : undefined);
          const guidance = alertCallArg(sendCronFailureAlert).text;
          if (mode === "due") {
            expect(guidance).toContain("use Run Now or reschedule");
            expect(guidance).not.toContain("will check again on a later scheduled run");
          } else {
            expect(guidance).toContain("will check again on a later scheduled run");
          }
        }

        await cron.update(job.id, { enabled: false, failureAlert: { after: 1 } });
        await cron.run(job.id, "force");
        expect(cron.getJob(job.id)?.enabled).toBe(false);
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
        expect(alertCallArg(sendCronFailureAlert).text).toContain("use Run Now or reschedule");
        expect(runCronFailureRepair).not.toHaveBeenCalled();
      },
      { failureAlert: undefined, runResult: blocked },
    );
  });

  it.each(["job opt-out", "global opt-out", "ordinary skip"] as const)(
    "keeps %s silent with the default skipped-alert policy",
    async (scenario) => {
      await withAlerts(
        async ({ cron, sendCronFailureAlert, runCronFailureRepair, addJob }) => {
          const job = await addJob("silent skip", {
            delivery: createTelegramDelivery(),
            ...(scenario === "job opt-out" ? { failureAlert: false as const } : {}),
          });
          await cron.run(job.id, "force");
          await cron.run(job.id, "force");
          expect(sendCronFailureAlert).not.toHaveBeenCalled();
          expect(runCronFailureRepair).not.toHaveBeenCalled();
        },
        {
          failureAlert: scenario === "global opt-out" ? { enabled: false } : undefined,
          runResult: {
            status: "skipped",
            error: "unavailable",
            diagnostics: {
              entries: [
                {
                  ts: Date.now(),
                  source: scenario === "ordinary skip" ? "cron-preflight" : "model-preflight",
                  severity: "warn",
                  message: "unavailable",
                },
              ],
            },
          },
        },
      );
    },
  );

  it("groups delivery failures with the job cooldown without an after gate", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("delivery cooldown", {
          delivery: {
            ...createTelegramDelivery(),
            failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
          },
          failureAlert: { after: 8, cooldownMs: 120_000 },
        });
        const firstAt = Date.now();
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();

        vi.setSystemTime(firstAt + 120_000 - 1);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: "primary rejected",
          consecutiveErrors: 0,
          lastFailureAlertAtMs: firstAt,
          lastFailureNotificationDeliveryStatus: "not-requested",
        });

        vi.setSystemTime(firstAt + 120_000);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();

        runIsolatedAgentJob.mockResolvedValue({
          status: "ok",
          delivered: false,
          deliveryError: "primary target no longer exists",
        });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expect(cron.getJob(job.id)?.state.lastFailureAlertAtMs).toBe(Date.now());
      },
      {
        failureAlert: { cooldownMs: 60_000 },
        runResult: { status: "ok", delivered: false, deliveryError: "primary rejected" },
      },
    );
  });

  it("keeps fallback events and immediate wakes on the failing job owner", async () => {
    await withAlerts(
      async ({ cron, enqueueSystemEvent, requestHeartbeat, addJob }) => {
        const sessionKey = "agent:work:cron:failure-alert";
        const job = await addJob("work-owned failure", {
          agentId: "work",
          sessionKey,
          wakeMode: "now",
        });

        await cron.run(job.id, "force");

        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          expect.stringContaining('Automation "work-owned failure" failed 1 times'),
          { agentId: "work", sessionKey, contextKey: `cron:${job.id}:failure-alert` },
        );
        expect(requestHeartbeat).toHaveBeenCalledWith({
          source: "notifications-event",
          intent: "immediate",
          reason: "wake",
          agentId: "work",
          sessionKey,
        });
      },
      {
        useFallback: true,
      },
    );
  });

  it("groups an incident, alerts on a changed cause, and recovers silently", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("daily report", {
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const firstAlert = expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "19098680",
        });
        expect(firstAlert.job.id).toBe(job.id);
        expectAlertTextContaining(sendCronFailureAlert, 'Automation "daily report" failed 2 times');

        runIsolatedAgentJob.mockResolvedValue({
          status: "error",
          error: "timeout",
          provider: "anthropic",
        });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

        runIsolatedAgentJob.mockResolvedValue({ status: "error", error: "wrong model id" });
        vi.setSystemTime(Date.now() + 60_000);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

        runIsolatedAgentJob.mockResolvedValue({
          status: "error",
          error: "timeout",
          provider: "anthropic",
        });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expectAlertTextContaining(sendCronFailureAlert, "Cause: timeout");

        runIsolatedAgentJob.mockResolvedValue({ status: "ok" });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);

        // Recovery clears the incident and cooldown without messaging the user.
        runIsolatedAgentJob.mockResolvedValue({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expect(cron.getJob(job.id)?.state.failureAlertIncident).toBeUndefined();
        expect(cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");

        runIsolatedAgentJob.mockResolvedValue({
          status: "error",
          error: "timeout",
          provider: "anthropic",
        });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(3);
      },
      {
        failureAlert: { enabled: true, after: 2, cooldownMs: 60_000 },
        runResult: { status: "error", error: "wrong model id" },
      },
    );
  });

  it("fences delayed alerts across recovery and failure in the same clock tick", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("same-tick incident", { delivery: createTelegramDelivery() });
        await cron.run(job.id, "force");
        runIsolatedAgentJob.mockResolvedValueOnce({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        // Recovery is silent, so the second failure starts the next alert cycle.
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);

        const first = sendCronFailureAlert.mock.calls[0]![0];
        const current = sendCronFailureAlert.mock.calls[1]![0];
        expect(first.runAtMs).toBe(current.runAtMs);
        await first.onDeliverySettled({ delivered: true, status: "delivered" });
        expect(cron.getJob(job.id)?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");

        await current.onDeliverySettled({ delivered: true, status: "delivered" });
        expect(cron.getJob(job.id)?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
      },
      {
        failureAlert: { after: 1, cooldownMs: 0 },
      },
    );
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("disabled alert job", { failureAlert: false });

        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
      },
      {
        runResult: { status: "error", error: "auth error" },
      },
    );
  });

  it("preserves includeSkipped through failure alert updates", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("updated skipped alert job", {
          failureAlert: { after: 1, channel: "telegram", to: "12345" },
        });

        const updated = await cron.update(job.id, { failureAlert: { includeSkipped: true } });
        expect(updated?.failureAlert).toMatchObject({
          after: 1,
          channel: "telegram",
          to: "12345",
          includeSkipped: true,
        });

        await cron.run(job.id, "force");
        expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "12345",
        });
        expectAlertTextContaining(
          sendCronFailureAlert,
          'Automation "updated skipped alert job" skipped 1 times',
        );
      },
      {
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
    );
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const normalJob = await addJob("normal alert job", {
          delivery: createTelegramDelivery(),
        });
        const bestEffortJob = await addJob("best effort alert job", {
          delivery: {
            ...createTelegramDelivery(),
            bestEffort: true,
          },
        });
        const explicitBestEffortJob = await addJob("explicit best effort alert job", {
          delivery: {
            ...createTelegramDelivery(),
            bestEffort: true,
          },
          failureAlert: { after: 1, channel: "telegram", to: "19098680" },
        });

        await cron.run(normalJob.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expectAlertFields(sendCronFailureAlert, {
          mode: "webhook",
          accountId: "global-account",
          to: undefined,
        });

        await cron.run(bestEffortJob.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

        await cron.run(explicitBestEffortJob.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expectAlertFields(sendCronFailureAlert, {
          mode: "announce",
          channel: "telegram",
          to: "19098680",
        });
      },
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
    );
  });

  it("preserves global skipped alerts alongside an owned failure destination", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("skipped job with a failure destination", {
          delivery: {
            mode: "none",
            failureDestination: { channel: "slack", to: "#alerts" },
          },
        });

        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertFields(sendCronFailureAlert, {
          mode: "announce",
          channel: "slack",
          to: "#alerts",
        });
        expectAlertTextContaining(
          sendCronFailureAlert,
          'Automation "skipped job with a failure destination" skipped 1 times',
        );
      },
      {
        failureAlert: {
          enabled: true,
          after: 1,
          includeSkipped: true,
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        },
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
    );
  });

  it("adds provider login recovery to OpenAI OAuth refresh failures", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("Sunday Magic Drop (Tax Payers)", {
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");

        const alert = alertCallArg(sendCronFailureAlert);
        expect(alert.text).toContain("Cause: auth_permanent");
        expect(alert.text).toContain("Send `/login openai`");
        expect(alert.presentation).toEqual({
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Sign in",
                  action: { type: "command", command: "/login openai" },
                },
              ],
            },
          ],
        });
      },
      {
        runResult: {
          status: "error",
          provider: "openai",
          errorClassification: { kind: "reason", reason: "auth_permanent" },
          error:
            'FailoverError: OAuth token refresh failed for openai: OpenAI Codex token refresh failed (401): {"error":{"message":"Your session has ended. Please log in again.","type":"invalid_request_error"}}',
        },
      },
    );
  });

  it.each([
    ["command exit", { kind: "command-exit", exitCode: 23 }, "Cause: command exited with code 23"],
    [
      "script failure",
      { kind: "script-failure", source: "payload", code: "tool_budget_exceeded" },
      "Cause: automation script exceeded its tool budget",
    ],
    [
      "plugin reload failure",
      { kind: "script-failure", source: "payload", code: "plugin_reload_failed" },
      "Cause: tools could not be refreshed after a plugin reload.\n" +
        "The automation script did not run. Automatic setup recovery failed.\n" +
        "Check automation history and plugin status, then retry the automation.",
    ],
  ] satisfies Array<[string, CronFailureNotificationDetail, string]>)(
    "renders a closed %s fact in threshold alerts",
    async (_name, detail, expected) => {
      await withAlerts(
        async ({ cron, sendCronFailureAlert, addJob }) => {
          const job = await addJob("closed detail alert", {
            payload: { kind: "agentTurn", message: "ping" },
            delivery: createTelegramDelivery(),
          });

          await cron.run(job.id, "force");
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
          expect(alertCallArg(sendCronFailureAlert).text).toBe(
            `Automation "closed detail alert" failed 1 times\n${expected}`,
          );
        },
        {
          runResult: {
            status: "error",
            error: "TOKEN=opaque /private/path command --secret provider body stack",
            errorClassification: { kind: "permanent" },
            failureNotificationDetail: detail,
          },
        },
      );
    },
  );

  it("keeps arbitrary permanent errors generic without a closed detail", async () => {
    await withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("permanent failure", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(alertText).toBe(
          'Automation "permanent failure" failed 1 times\n' +
            "Check automation history for details.",
        );
      },
      {
        runResult: {
          status: "error",
          error: "TOKEN=opaque /private/path command --secret provider body stack",
          errorClassification: { kind: "permanent" },
        },
      },
    );
  });
});
