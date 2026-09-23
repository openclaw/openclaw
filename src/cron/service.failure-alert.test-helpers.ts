import { expect, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];
type RunIsolatedAgentJob = NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
type IsolatedAgentRunResult = Awaited<ReturnType<RunIsolatedAgentJob>>;
type FailureAlertConfig = NonNullable<CronServiceParams["cronConfig"]>["failureAlert"];
type SendCronFailureAlert = NonNullable<CronServiceParams["sendCronFailureAlert"]>;

export function createTelegramDelivery(): NonNullable<CronJobCreate["delivery"]> {
  return { mode: "announce", channel: "telegram", to: "19098680" };
}

function createFailureAlertJob(
  name: string,
  overrides: Partial<CronJobCreate> = {},
): CronJobCreate {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run report" },
    ...overrides,
  };
}

export function setupFailureAlertSuite() {
  const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
    prefix: "openclaw-cron-failure-alert-",
    baseTimeIso: "2026-01-01T00:00:00.000Z",
  });

  async function withFailureAlertCron(
    params: {
      failureAlert?: FailureAlertConfig;
      runResult?: IsolatedAgentRunResult;
      useFallback?: boolean;
    },
    run: (context: {
      cron: CronService;
      enqueueSystemEvent: ReturnType<typeof vi.fn>;
      requestHeartbeat: ReturnType<typeof vi.fn>;
      sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>;
      runIsolatedAgentJob: ReturnType<typeof vi.fn<RunIsolatedAgentJob>>;
      addJob: (name: string, overrides?: Partial<CronJobCreate>) => ReturnType<CronService["add"]>;
    }) => Promise<void>,
  ): Promise<void> {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn<SendCronFailureAlert>(async () => undefined);
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runResult = params.runResult ?? {
      status: "error",
      error: "temporary upstream error",
    };
    const runIsolatedAgentJob = vi.fn<RunIsolatedAgentJob>(async () => runResult);
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      ...(params.failureAlert === undefined
        ? {}
        : { cronConfig: { failureAlert: params.failureAlert } }),
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
      ...(params.useFallback ? {} : { sendCronFailureAlert }),
    });

    await cron.start();
    try {
      await run({
        cron,
        enqueueSystemEvent,
        requestHeartbeat,
        sendCronFailureAlert,
        runIsolatedAgentJob,
        addJob: async (name, overrides) => await cron.add(createFailureAlertJob(name, overrides)),
      });
    } finally {
      cron.stop();
    }
  }

  return { withFailureAlertCron };
}

export function alertCallArg(
  sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>,
  callIndex = sendCronFailureAlert.mock.calls.length - 1,
) {
  const alert = sendCronFailureAlert.mock.calls[callIndex]?.[0];
  if (!alert) {
    throw new Error(`expected failure alert call ${callIndex}`);
  }
  return { ...alert, ...alert.payload };
}

export function expectAlertFields(
  sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>,
  expected: Record<string, unknown>,
  callIndex?: number,
) {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  expect(alert).toEqual(expect.objectContaining(expected));
  return alert;
}

export function expectAlertTextContaining(
  sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>,
  text: string,
  callIndex?: number,
): void {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  expect(typeof alert.text).toBe("string");
  if (typeof alert.text !== "string") {
    throw new Error("expected failure alert text");
  }
  expect(alert.text).toContain(text);
}
