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

const privateError = "TOKEN=opaque /private/path command --secret provider body stack";
const timeoutFailure = { status: "error", error: "timeout", provider: "anthropic" } as const;
const telegramRoute = { channel: "telegram", to: "19098680" };

const { withFailureAlertCron } = setupFailureAlertSuite();
type AlertParams = Parameters<typeof withFailureAlertCron>;
type AlertContext = Parameters<AlertParams[1]>[0];
type RunResult = NonNullable<AlertParams[0]["runResult"]>;
type AlertCase = AlertContext & {
  runJob: (job: { id: string }, count: number, result?: RunResult) => Promise<void>;
};

function skipped(
  error: string,
  source: "model-preflight" | "cron-preflight" = "model-preflight",
): RunResult {
  return {
    status: "skipped",
    error,
    diagnostics: {
      entries: [{ ts: Date.now(), source, severity: "warn", message: error }],
    },
  };
}

function withAlerts(
  run: (context: AlertCase) => Promise<void>,
  options: Omit<AlertParams[0], "scheduler"> = {},
) {
  return withFailureAlertCron(
    {
      scheduler: createTestGatewayScheduler(),
      failureAlert: { enabled: true, after: 1 },
      ...options,
    },
    (context) =>
      run({
        ...context,
        addJob: (name, overrides) =>
          context.addJob(name, { delivery: createTelegramDelivery(), ...overrides }),
        runJob: async (job, count, result) => {
          if (result) {
            context.runIsolatedAgentJob.mockResolvedValue(result);
          }
          await context.cron.run(job.id, "force");
          expect(context.sendCronFailureAlert).toHaveBeenCalledTimes(count);
        },
      }),
  );
}

describe("CronService failure alerts", () => {
  it("alerts once for blocked local-provider runs and recovers without repair or backoff", () =>
    withAlerts(
      async ({
        cron,
        sendCronFailureAlert,
        runCronFailureRepair,
        runIsolatedAgentJob,
        addJob,
        runJob,
      }) => {
        const error = "Local provider unavailable at http://127.0.0.1:11434 (private diagnostic)";
        const blocked = skipped(error);
        runIsolatedAgentJob.mockResolvedValue(blocked);
        const job = await addJob("local report", { owner: { sessionKey: "agent:main:owner" } });
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
        await runJob(job, 2, {
          ...blocked,
          error: "Local provider unavailable at http://127.0.0.1:1234",
        });
        await runJob(job, 2, { status: "ok", delivered: true });
        expect(cron.getJob(job.id)?.state.failureAlertIncident).toBeUndefined();
        expect(cron.getJob(job.id)?.state.lastFailureAlertAtMs).toBeUndefined();

        runIsolatedAgentJob.mockResolvedValue(blocked);
        for (const mode of ["due", "force"] as const) {
          const atMs = Date.now() + 60_000;
          const oneShot = await addJob(`one-shot ${mode}`, {
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
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
      { failureAlert: undefined },
    ));

  it.each(["job opt-out", "global opt-out", "ordinary skip"] as const)(
    "keeps %s silent with the default skipped-alert policy",
    (scenario) =>
      withAlerts(
        async ({ cron, runCronFailureRepair, addJob, runJob }) => {
          const job = await addJob(
            "silent skip",
            scenario === "job opt-out" ? { failureAlert: false } : {},
          );
          await cron.run(job.id, "force");
          await runJob(job, 0);
          expect(runCronFailureRepair).not.toHaveBeenCalled();
        },
        {
          failureAlert: scenario === "global opt-out" ? { enabled: false } : undefined,
          runResult: skipped(
            "unavailable",
            scenario === "ordinary skip" ? "cron-preflight" : "model-preflight",
          ),
        },
      ),
  );

  it("groups delivery failures with the job cooldown without an after gate", () =>
    withAlerts(
      async ({ cron, addJob, runJob }) => {
        const job = await addJob("delivery cooldown", {
          delivery: {
            ...createTelegramDelivery(),
            failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
          },
          failureAlert: { after: 8, cooldownMs: 120_000 },
        });
        const firstAt = Date.now();
        await runJob(job, 1);

        vi.setSystemTime(firstAt + 120_000 - 1);
        await runJob(job, 1);
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: "primary rejected",
          consecutiveErrors: 0,
          lastFailureAlertAtMs: firstAt,
          lastFailureNotificationDeliveryStatus: "not-requested",
        });

        vi.setSystemTime(firstAt + 120_000);
        await runJob(job, 1);

        await runJob(job, 2, {
          status: "ok",
          delivered: false,
          deliveryError: "primary target no longer exists",
        });
        expect(cron.getJob(job.id)?.state.lastFailureAlertAtMs).toBe(Date.now());
      },
      {
        failureAlert: { cooldownMs: 60_000 },
        runResult: { status: "ok", delivered: false, deliveryError: "primary rejected" },
      },
    ));

  it("keeps fallback events and immediate wakes on the failing job owner", () =>
    withAlerts(
      async ({ cron, enqueueSystemEvent, requestHeartbeat, addJob }) => {
        const sessionKey = "agent:work:cron:failure-alert";
        const job = await addJob("work-owned failure", {
          delivery: undefined,
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
      { useFallback: true },
    ));

  it("groups an incident, alerts on a changed cause, and recovers silently", () =>
    withAlerts(
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob, runJob }) => {
        const job = await addJob("daily report");

        await runJob(job, 0);

        await runJob(job, 1);
        const firstAlert = expectAlertFields(sendCronFailureAlert, telegramRoute);
        expect(firstAlert.job.id).toBe(job.id);
        expectAlertTextContaining(sendCronFailureAlert, 'Automation "daily report" failed 2 times');

        await runJob(job, 1, timeoutFailure);

        runIsolatedAgentJob.mockResolvedValue({ status: "error", error: "wrong model id" });
        vi.setSystemTime(Date.now() + 60_000);
        await runJob(job, 1);

        await runJob(job, 2, timeoutFailure);
        expectAlertTextContaining(sendCronFailureAlert, "Cause: timeout");

        await runJob(job, 2, { status: "ok" });

        await runJob(job, 2, { status: "ok", delivered: true });
        expect(cron.getJob(job.id)?.state.failureAlertIncident).toBeUndefined();
        expect(cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");

        await runJob(job, 2, timeoutFailure);
        await runJob(job, 3);
      },
      {
        failureAlert: { enabled: true, after: 2, cooldownMs: 60_000 },
        runResult: { status: "error", error: "wrong model id" },
      },
    ));

  it("fences delayed alerts across recovery and failure in the same clock tick", () =>
    withAlerts(
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("same-tick incident");
        await cron.run(job.id, "force");
        runIsolatedAgentJob.mockResolvedValueOnce({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
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
    ));

  it.each([false, true])("routes skipped alerts with an owned destination=%s", (owned) => {
    const name = owned ? "skipped job with a failure destination" : "updated skipped alert job";
    return withAlerts(
      async ({ cron, sendCronFailureAlert, addJob, runJob }) => {
        const route = { channel: "telegram", to: "12345" };
        const job = await addJob(
          name,
          owned
            ? {
                delivery: { mode: "none", failureDestination: { channel: "slack", to: "#alerts" } },
              }
            : { delivery: undefined, failureAlert: { after: 1, ...route } },
        );
        if (!owned) {
          const updated = await cron.update(job.id, { failureAlert: { includeSkipped: true } });
          expect(updated?.failureAlert).toMatchObject({ after: 1, ...route, includeSkipped: true });
        }
        await runJob(job, 1);
        expectAlertFields(
          sendCronFailureAlert,
          owned ? { mode: "announce", channel: "slack", to: "#alerts" } : route,
        );
        expectAlertTextContaining(sendCronFailureAlert, `Automation "${name}" skipped 1 times`);
      },
      {
        ...(owned
          ? {
              failureAlert: {
                enabled: true,
                after: 1,
                includeSkipped: true,
                mode: "announce",
                channel: "telegram",
                to: "telegram:19098680",
              },
            }
          : {}),
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
    );
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", () =>
    withAlerts(
      async ({ sendCronFailureAlert, addJob, runJob }) => {
        const delivery = { ...createTelegramDelivery(), bestEffort: true };
        const normalJob = await addJob("normal alert job");
        const bestEffortJob = await addJob("best effort alert job", { delivery });
        const explicitBestEffortJob = await addJob("explicit best effort alert job", {
          delivery,
          failureAlert: { after: 1, ...telegramRoute },
        });

        await runJob(normalJob, 1);
        expectAlertFields(sendCronFailureAlert, {
          mode: "webhook",
          accountId: "global-account",
          to: undefined,
        });

        await runJob(bestEffortJob, 1);

        await runJob(explicitBestEffortJob, 2);
        expectAlertFields(sendCronFailureAlert, {
          mode: "announce",
          ...telegramRoute,
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
    ));

  it("adds provider login recovery to OpenAI OAuth refresh failures", () =>
    withAlerts(
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("Sunday Magic Drop (Tax Payers)");

        await cron.run(job.id, "force");

        const alert = alertCallArg(sendCronFailureAlert);
        expect(alert.text).toContain("Cause: auth_permanent");
        expect(alert.text).toContain("Send `/login openai`");
        const signIn = {
          label: "Sign in",
          action: { type: "command", command: "/login openai" },
        };
        expect(alert.presentation).toEqual({
          blocks: [{ type: "buttons", buttons: [signIn] }],
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
    ));

  it.each([
    ["arbitrary permanent error", undefined, "Check automation history for details."],
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
  ] satisfies Array<[string, CronFailureNotificationDetail | undefined, string]>)(
    "renders safe %s detail in threshold alerts",
    (_name, detail, expected) =>
      withAlerts(
        async ({ sendCronFailureAlert, addJob, runJob }) => {
          const job = await addJob("closed detail alert");

          await runJob(job, 1);
          expect(alertCallArg(sendCronFailureAlert).text).toBe(
            `Automation "closed detail alert" failed 1 times\n${expected}`,
          );
        },
        {
          runResult: {
            status: "error",
            error: privateError,
            errorClassification: { kind: "permanent" },
            failureNotificationDetail: detail,
          },
        },
      ),
  );
});
