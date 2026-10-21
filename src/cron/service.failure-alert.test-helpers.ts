import { expect, type Mock, vi } from "vitest";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps as Deps } from "./service/state.js";
import type { CronJobCreate } from "./types.js";

type JobRunner = NonNullable<Deps["runIsolatedAgentJob"]>;
type AlertMock = Mock<NonNullable<Deps["sendCronFailureAlert"]>>;

export function createTelegramDelivery(): NonNullable<CronJobCreate["delivery"]> {
  return { mode: "announce", channel: "telegram", to: "19098680" };
}

type FailureAlertParams = {
  scheduler: Deps["scheduler"];
  failureAlert?: NonNullable<Deps["cronConfig"]>["failureAlert"];
  runResult?: Awaited<ReturnType<JobRunner>>;
  useFallback?: boolean;
};

export function setupFailureAlertSuite() {
  const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
    prefix: "openclaw-cron-failure-alert-",
    baseTimeIso: "2026-01-01T00:00:00.000Z",
  });

  async function createFixture(params: FailureAlertParams) {
    const { storePath } = await makeStorePath();
    const runResult = params.runResult ?? {
      status: "error",
      error: "temporary upstream error",
    };
    const mocks = {
      sendCronFailureAlert: vi.fn<NonNullable<Deps["sendCronFailureAlert"]>>(async () => undefined),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runCronFailureRepair: vi.fn<NonNullable<Deps["runCronFailureRepair"]>>(async () => undefined),
      runIsolatedAgentJob: vi.fn<JobRunner>(async () => runResult),
      runScriptJob: vi.fn<NonNullable<Deps["runScriptJob"]>>(async () => runResult),
    };
    const { sendCronFailureAlert, ...deps } = mocks;
    const cron = new CronService({
      ...cronTestDeps({ storePath }),
      scheduler: params.scheduler,
      cronConfig:
        params.failureAlert === undefined ? undefined : { failureAlert: params.failureAlert },
      log: noopLogger,
      ...deps,
      ...(params.useFallback ? {} : { sendCronFailureAlert }),
    });
    return {
      cron,
      ...mocks,
      addJob: (name: string, overrides?: Partial<CronJobCreate>) =>
        cron.add({
          ...cronTestInput(),
          name,
          payload: { kind: "agentTurn", message: "run report" },
          ...overrides,
        }),
    };
  }

  async function withFailureAlertCron(
    params: FailureAlertParams,
    run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  ): Promise<void> {
    const fixture = await createFixture(params);
    await fixture.cron.start();
    try {
      await run(fixture);
    } finally {
      fixture.cron.stop();
    }
  }

  return { withFailureAlertCron };
}

export function alertCallArg(sendAlert: AlertMock) {
  const alert = sendAlert.mock.calls.at(-1)?.[0];
  if (!alert) {
    throw new Error("expected failure alert call");
  }
  return { ...alert, ...alert.payload };
}

export function expectAlertFields(sendAlert: AlertMock, expected: Record<string, unknown>) {
  const alert = alertCallArg(sendAlert);
  expect(alert).toEqual(expect.objectContaining(expected));
  return alert;
}

export function expectAlertTextContaining(sendAlert: AlertMock, text: string): void {
  expect(alertCallArg(sendAlert).text).toEqual(expect.stringContaining(text));
}
