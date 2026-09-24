// Cron failure alert tests cover notification behavior for failed scheduled jobs.
import { describe, expect, it, vi } from "vitest";
import {
  alertCallArg,
  createTelegramDelivery,
  expectAlertFields,
  expectAlertTextContaining,
  setupFailureAlertSuite,
} from "./service.failure-alert.test-helpers.js";

const { withFailureAlertCron } = setupFailureAlertSuite();

describe("CronService failure alerts", () => {
  it.each([
    { name: "default", global: undefined, job: undefined, cooldownMs: 3_600_000 },
    {
      name: "global",
      global: { after: 8, cooldownMs: 60_000 },
      job: undefined,
      cooldownMs: 60_000,
    },
    {
      name: "job override",
      global: { cooldownMs: 60_000 },
      job: { after: 8, cooldownMs: 120_000 },
      cooldownMs: 120_000,
    },
    { name: "zero", global: undefined, job: { after: 8, cooldownMs: 0 }, cooldownMs: 0 },
  ])("groups delivery failures with $name cooldown without an after gate", async (testCase) => {
    await withFailureAlertCron(
      {
        failureAlert: testCase.global,
        runResult: { status: "ok", delivered: false, deliveryError: "primary rejected" },
      },
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("delivery cooldown", {
          delivery: {
            ...createTelegramDelivery(),
            failureDestination: { mode: "webhook", to: "https://alerts.example.test/cron" },
          },
          failureAlert: testCase.job,
        });
        const firstAt = Date.now();
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();

        if (testCase.cooldownMs > 0) {
          vi.setSystemTime(firstAt + testCase.cooldownMs - 1);
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
        }

        vi.setSystemTime(firstAt + testCase.cooldownMs);
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
    );
  });

  it("defaults route-backed jobs to two failures and a one-hour cooldown", async () => {
    await withFailureAlertCron({}, async ({ cron, sendCronFailureAlert, addJob }) => {
      const job = await addJob("default routed alert", { delivery: createTelegramDelivery() });

      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).not.toHaveBeenCalled();

      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertFields(sendCronFailureAlert, { channel: "telegram", to: "19098680" });

      vi.advanceTimersByTime(60 * 60_000 - 1);
      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    });
  });

  it("activates policy when the global failureAlert object omits enabled", async () => {
    await withFailureAlertCron(
      { failureAlert: { after: 1 } },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("object-enabled alert", { delivery: { mode: "none" } });

        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertFields(sendCronFailureAlert, { channel: "last", mode: "announce" });
      },
    );
  });

  it("keeps fallback events and immediate wakes on the failing job owner", async () => {
    await withFailureAlertCron(
      { failureAlert: { enabled: true, after: 1 }, useFallback: true },
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
    );
  });

  it.each([
    {
      name: "was not delivered",
      outcome: { delivered: false, status: "not-delivered" as const },
      rejects: false,
      fallbackCalls: 1,
    },
    {
      name: "has an unknown outcome",
      outcome: { status: "unknown" as const },
      rejects: false,
      fallbackCalls: 0,
    },
    {
      name: "was delivered",
      outcome: { delivered: true, status: "delivered" as const },
      rejects: false,
      fallbackCalls: 0,
    },
    {
      name: "failed after settling as not delivered",
      outcome: {
        delivered: false,
        status: "not-delivered" as const,
        error: "failure alert delivery failed",
      },
      rejects: true,
      fallbackCalls: 1,
    },
  ])("falls back exactly once only when an alert $name", async (testCase) => {
    await withFailureAlertCron(
      { failureAlert: { enabled: true, after: 1 } },
      async ({ cron, sendCronFailureAlert, enqueueSystemEvent, addJob }) => {
        sendCronFailureAlert.mockImplementationOnce(async (alert) => {
          await alert.onDeliverySettled(testCase.outcome);
          if (testCase.rejects) {
            throw new Error("failure alert delivery failed");
          }
        });
        const job = await addJob("recipient custody", { delivery: createTelegramDelivery() });

        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        await vi.waitFor(() =>
          expect(enqueueSystemEvent).toHaveBeenCalledTimes(testCase.fallbackCalls),
        );
      },
    );
  });

  it("groups an incident, alerts on a changed cause, and reports recovery once", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 2, cooldownMs: 60_000 },
        runResult: { status: "error", error: "wrong model id" },
      },
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("daily report", {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const firstAlert = expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "19098680",
        });
        expect((firstAlert.job as { id?: string } | undefined)?.id).toBe(job.id);
        expectAlertTextContaining(sendCronFailureAlert, 'Automation "daily report" failed 2 times');

        runIsolatedAgentJob.mockResolvedValue({ status: "error", error: "timeout" });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

        runIsolatedAgentJob.mockResolvedValue({ status: "error", error: "wrong model id" });
        vi.advanceTimersByTime(60_000);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

        runIsolatedAgentJob.mockResolvedValue({ status: "error", error: "timeout" });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expectAlertTextContaining(sendCronFailureAlert, "Cause: timeout");

        runIsolatedAgentJob.mockResolvedValue({ status: "ok" });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);

        runIsolatedAgentJob.mockResolvedValue({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(3);
        expectAlertTextContaining(sendCronFailureAlert, 'Automation "daily report" recovered');
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(3);

        runIsolatedAgentJob.mockResolvedValue({ status: "error", error: "timeout" });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(3);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(4);
      },
    );
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: false },
        runResult: { status: "error", error: "timeout" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("job with override", {
          failureAlert: {
            after: 1,
            channel: "telegram",
            to: "12345",
            cooldownMs: 1,
          },
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "12345",
        });
      },
    );
  });

  it("reports an existing incident to a changed failure destination", async () => {
    await withFailureAlertCron(
      { failureAlert: { after: 1, cooldownMs: 60_000 } },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("rerouted incident", { delivery: createTelegramDelivery() });
        await cron.run(job.id, "force");
        await cron.update(job.id, { failureAlert: { to: "new-recipient" } });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();

        vi.advanceTimersByTime(60_000);
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
        expectAlertFields(sendCronFailureAlert, { to: "new-recipient" });
      },
    );
  });

  it("fences delayed alerts across recovery and failure in the same clock tick", async () => {
    await withFailureAlertCron(
      { failureAlert: { after: 1, cooldownMs: 0 } },
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("same-tick incident", { delivery: createTelegramDelivery() });
        await cron.run(job.id, "force");
        runIsolatedAgentJob.mockResolvedValueOnce({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(3);

        const first = sendCronFailureAlert.mock.calls[0]![0];
        const current = sendCronFailureAlert.mock.calls[2]![0];
        expect(first.runAtMs).toBe(current.runAtMs);
        await first.onDeliverySettled({ delivered: true, status: "delivered" });
        expect(cron.getJob(job.id)?.state.lastFailureNotificationDeliveryStatus).toBe("unknown");

        await current.onDeliverySettled({ delivered: true, status: "delivered" });
        expect(cron.getJob(job.id)?.state.lastFailureNotificationDeliveryStatus).toBe("delivered");
      },
    );
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "error", error: "auth error" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("disabled alert job", { failureAlert: false });

        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
      },
    );
  });

  it("preserves includeSkipped through failure alert updates", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("updated skipped alert job", {
          failureAlert: {
            after: 1,
            channel: "telegram",
            to: "12345",
          },
        });

        const updated = await cron.update(job.id, {
          failureAlert: {
            includeSkipped: true,
          },
        });
        const updatedFailureAlert = updated?.failureAlert;
        if (!updatedFailureAlert) {
          throw new Error("expected updated failure alert config");
        }
        expect(updatedFailureAlert.after).toBe(1);
        expect(updatedFailureAlert.channel).toBe("telegram");
        expect(updatedFailureAlert.to).toBe("12345");
        expect(updatedFailureAlert.includeSkipped).toBe(true);

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
    );
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          accountId: "global-account",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const normalJob = await addJob("normal alert job", {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        });
        const bestEffortJob = await addJob("best effort alert job", {
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "19098680",
            bestEffort: true,
          },
        });
        const explicitBestEffortJob = await addJob("explicit best effort alert job", {
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "19098680",
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
    );
  });

  it.each([
    {
      name: "uses a globally configured failure webhook destination",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/cron-failures",
      },
      jobAlert: undefined,
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/cron-failures",
      },
    },
    {
      name: "uses a globally configured failure announcement channel and target",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
    },
    {
      name: "preserves a global route when a job explicitly repeats its alert mode",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
    },
    {
      name: "preserves an explicit job failure webhook over the global destination",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "webhook" as const,
        to: "https://alerts.example.test/job-failures",
      },
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/job-failures",
      },
    },
    {
      name: "falls back to the primary announce route instead of a global webhook URL",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a global chat target after a job changes the failure channel",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "telegram",
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: undefined,
      },
    },
    {
      name: "never reuses a global chat target or account for the last failure channel",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
      },
      jobAlert: {
        mode: "announce" as const,
        channel: "last",
      },
      expected: {
        mode: "announce",
        channel: "last",
        to: undefined,
        accountId: undefined,
      },
    },
    {
      name: "falls back to the primary announce route instead of global webhook fields",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        channel: "slack",
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        mode: "announce" as const,
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
    {
      name: "never reuses a job chat target for a global channel-only alert",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "announce" as const,
        channel: "slack",
      },
      jobAlert: undefined,
      expected: {
        mode: "announce",
        channel: "slack",
        to: undefined,
      },
    },
    {
      name: "uses an explicit job channel instead of the global webhook route",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/global-failures",
      },
      jobAlert: {
        channel: "telegram",
      },
      expected: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
      },
    },
  ])("$name", async ({ globalAlert, jobAlert, expected }) => {
    await withFailureAlertCron({ failureAlert: globalAlert }, async (context) => {
      const { cron, sendCronFailureAlert, addJob } = context;
      const job = await addJob("globally routed failure alert", {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        },
        ...(jobAlert ? { failureAlert: jobAlert } : {}),
      });

      await cron.run(job.id, "force");

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertFields(sendCronFailureAlert, expected);
      expectAlertTextContaining(
        sendCronFailureAlert,
        'Automation "globally routed failure alert" failed 1 times',
      );
    });
  });

  it.each([
    {
      name: "channel-shaped failure destination",
      failureDestination: { channel: "slack", to: "#alerts" },
    },
    {
      name: "webhook failure destination",
      failureDestination: {
        mode: "webhook" as const,
        to: "https://alerts.example.test/job-failures",
      },
    },
  ])("routes one scheduler alert through the $name", async ({ failureDestination }) => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/global-failures",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("explicitly routed failure destination", {
          delivery: { mode: "none", failureDestination },
        });

        expect(job.delivery?.failureDestination).toBeDefined();
        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertFields(sendCronFailureAlert, {
          ...failureDestination,
          inheritSessionThread: false,
        });
      },
    );
  });

  it("preserves explicit job alerts alongside an owned failure destination", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/global-failures",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("explicit job alert with a failure destination", {
          delivery: {
            mode: "none",
            failureDestination: { channel: "slack", to: "#alerts" },
          },
          failureAlert: {
            after: 1,
            mode: "announce",
            channel: "telegram",
            to: "telegram:19098680",
          },
        });

        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertFields(sendCronFailureAlert, {
          mode: "announce",
          channel: "telegram",
          to: "telegram:19098680",
        });
        expectAlertTextContaining(
          sendCronFailureAlert,
          'Automation "explicit job alert with a failure destination" failed 1 times',
        );
      },
    );
  });

  it("preserves global skipped alerts alongside an owned failure destination", async () => {
    await withFailureAlertCron(
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
    );
  });

  it("alerts for repeated skipped runs only when opted in", async () => {
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 60_000,
          includeSkipped: true,
        },
        runResult: { status: "skipped", error: "disabled" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("gateway restart", {
          payload: { kind: "agentTurn", message: "restart gateway if needed" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        expectAlertFields(sendCronFailureAlert, {
          channel: "telegram",
          to: "19098680",
        });
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(typeof alertText).toBe("string");
        if (typeof alertText !== "string") {
          throw new Error("expected failure alert text");
        }
        expect(alertText).toBe(
          'Automation "gateway restart" skipped 2 times\n' +
            "Check automation history for details.",
        );

        const skippedJob = cron.getJob(job.id);
        expect(skippedJob?.state.consecutiveSkipped).toBe(2);
        expect(skippedJob?.state.consecutiveErrors).toBe(0);
      },
    );
  });

  it("keeps classified raw errors out of chat failure alerts", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "error", error: "cron: job execution timed out" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("timeout cause alert", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(alertText).toBe('Automation "timeout cause alert" failed 1 times\nCause: timeout');
      },
    );
  });

  it("adds provider login recovery to OpenAI OAuth refresh failures", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          provider: "openai",
          errorClassification: { kind: "reason", reason: "auth_permanent" },
          error:
            'FailoverError: OAuth token refresh failed for openai: OpenAI Codex token refresh failed (401): {"error":{"message":"Your session has ended. Please log in again.","type":"invalid_request_error"}}',
        },
      },
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
    );
  });

  it("does not offer provider login for non-OAuth authentication failures", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          provider: "openai",
          error: "401 invalid API key",
        },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("API key job", { delivery: createTelegramDelivery() });

        await cron.run(job.id, "force");

        expect(alertCallArg(sendCronFailureAlert).presentation).toBeUndefined();
      },
    );
  });

  it.each([
    {
      name: "command exit",
      detail: { kind: "command-exit" as const, exitCode: 23 },
      expected: "Cause: command exited with code 23",
    },
    {
      name: "script failure",
      detail: {
        kind: "script-failure" as const,
        source: "payload" as const,
        code: "tool_budget_exceeded" as const,
      },
      expected: "Cause: automation script exceeded its tool budget",
    },
    {
      name: "plugin reload failure",
      detail: {
        kind: "script-failure" as const,
        source: "payload" as const,
        code: "plugin_reload_failed" as const,
      },
      expected:
        "Cause: tools could not be refreshed after a plugin reload.\n" +
        "The automation script did not run. Automatic setup recovery failed.\n" +
        "Check automation history and plugin status, then retry the automation.",
    },
  ])("renders a closed $name fact in threshold alerts", async ({ detail, expected }) => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          error: "TOKEN=opaque /private/path command --secret provider body stack",
          errorClassification: { kind: "permanent" },
          failureNotificationDetail: detail,
        },
      },
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
    );
  });

  it("keeps arbitrary permanent errors generic without a closed detail", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: {
          status: "error",
          error: "TOKEN=opaque /private/path command --secret provider body stack",
          errorClassification: { kind: "permanent" },
        },
      },
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
    );
  });

  it("tracks skipped runs without alerting or affecting error backoff when includeSkipped is off", async () => {
    await withFailureAlertCron(
      {
        failureAlert: { enabled: true, after: 1 },
        runResult: { status: "skipped", error: "requests-in-flight" },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("busy heartbeat", { delivery: createTelegramDelivery() });

        await cron.run(job.id, "force");
        await cron.run(job.id, "force");

        expect(sendCronFailureAlert).not.toHaveBeenCalled();
        const skippedJob = cron.getJob(job.id);
        expect(skippedJob?.state.consecutiveSkipped).toBe(2);
        expect(skippedJob?.state.consecutiveErrors).toBe(0);
      },
    );
  });

  it("truncates webhook failure alert error text on UTF-16 code-point boundary", async () => {
    // 209 code units: emoji (surrogate pair) at positions 199-200 straddles the 200-unit boundary
    const longError = `${"x".repeat(199)}🎉trailing`;
    await withFailureAlertCron(
      {
        failureAlert: {
          enabled: true,
          after: 1,
          mode: "webhook",
          to: "https://alerts.example.test/failures",
        },
        runResult: { status: "error", error: longError },
      },
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("utf16 boundary job", {
          payload: { kind: "agentTurn", message: "ping" },
          delivery: createTelegramDelivery(),
        });

        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
        const alertText = alertCallArg(sendCronFailureAlert).text;
        expect(typeof alertText).toBe("string");
        if (typeof alertText !== "string") {
          throw new Error("expected failure alert text");
        }

        // Verify no dangling surrogates in the truncated error text.
        // Must check every character including the last: a dangling high surrogate
        // at the final position would be missed by stopping at length-1.
        for (let i = 0; i < alertText.length; i++) {
          const cu = alertText.charCodeAt(i);
          if (cu >= 0xd800 && cu <= 0xdbff) {
            expect(
              alertText.charCodeAt(i + 1) >= 0xdc00 && alertText.charCodeAt(i + 1) <= 0xdfff,
            ).toBe(true);
          }
          if (cu >= 0xdc00 && cu <= 0xdfff) {
            expect(
              i > 0 &&
                alertText.charCodeAt(i - 1) >= 0xd800 &&
                alertText.charCodeAt(i - 1) <= 0xdbff,
            ).toBe(true);
          }
        }

        // Verify the emoji was excluded (truncated at the safe boundary before it)
        expect(alertText).not.toContain("🎉");
      },
    );
  });
});
