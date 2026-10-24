import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { executeJobCore } from "./timer-execution.js";
import { wake } from "./wake.js";

type RunSessionEvent = NonNullable<CronServiceDeps["runSessionEvent"]>;

function createState(overrides: Partial<CronServiceDeps>) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    storePath: "unused-cron-wake-owner.json",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
      status: "ok",
    })),
    ...overrides,
  });
}

function createHarness(runSessionEvent: RunSessionEvent) {
  const state = createState({ runSessionEvent });
  const job: CronJob = {
    id: "reminder",
    name: "reminder",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "  check pending work  " },
    sessionTarget: "main",
    wakeMode: "now",
    state: {},
  };
  return { state, job };
}

it("retains the ordinary session owner's delivery outcome for a scheduled main turn", async () => {
  const result = {
    status: "ok",
    summary: "pending work completed",
    executionStarted: true,
    delivered: false,
    deliveryAttempted: true,
    deliveryError: "topic unavailable",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
  } as const;
  const runSessionEvent = vi.fn<RunSessionEvent>(async () => result);
  const { state, job } = createHarness(runSessionEvent);

  await expect(
    executeJobCore(state, job, undefined, { migrationPending: false }),
  ).resolves.toMatchObject(result);

  expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ job, text: "check pending work" }),
  );
  expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
});

it.each(["occurrence revalidation", "session custody"] as const)(
  "cancels during %s",
  async (stage) => {
    const entered = createDeferred();
    const release = createDeferred();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const runSessionEvent = vi.fn<RunSessionEvent>(async (request) => {
      if (stage === "session custody") {
        await hold();
        request.assertCurrent();
      }
      return { status: "ok" };
    });
    const { state, job } = createHarness(runSessionEvent);
    const controller = new AbortController();
    const pending = executeJobCore(state, job, controller.signal, {
      migrationPending: false,
      ...(stage === "occurrence revalidation" ? { assertRunCurrent: hold } : {}),
    });

    await awaitGateBeforeSettlement(entered.promise, pending, `Scheduled turn skipped ${stage}`);
    controller.abort(new Error("occurrence cancelled"));
    release.resolve();

    if (stage === "session custody") {
      await expect(pending).rejects.toThrow("occurrence cancelled");
      expect(runSessionEvent).toHaveBeenCalledOnce();
    } else {
      await expect(pending).resolves.toMatchObject({
        status: "error",
        error: "occurrence cancelled",
      });
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    }
  },
);

const deliveryContext: DeliveryContext = {
  channel: "telegram",
  to: "telegram:8661849123:topic:4052",
  accountId: "default",
  threadId: "4052",
};
const sessionKey = "agent:main:telegram:8661849123:topic:4052";
const expectedTarget: SessionEventTarget = {
  sessionId: "source-session",
  generation: "source-generation",
  deliveryContext,
};
type OriginCase = [
  string,
  Omit<Parameters<typeof wake>[1], "mode" | "text">,
  DeliveryContext | undefined,
  Parameters<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>[1],
  boolean,
  boolean,
];
const originCases: OriginCase[] = [
  [
    "captured target",
    { sessionKey, agentId: "main", expectedTarget },
    { channel: "telegram", to: "telegram:other-chat" },
    { sessionKey, agentId: "main", expectedTarget, deliveryContext },
    false,
    false,
  ],
  [
    "async targeted route",
    { sessionKey, agentId: "main" },
    deliveryContext,
    { sessionKey, agentId: "main", deliveryContext },
    true,
    true,
  ],
  [
    "target without agent",
    { sessionKey },
    deliveryContext,
    { sessionKey, deliveryContext },
    true,
    false,
  ],
  ["no resolved route", { sessionKey }, undefined, { sessionKey }, true, false],
  [
    "untargeted owner",
    {},
    deliveryContext,
    { createIfMissing: undefined, assertAcceptanceCurrent: undefined },
    false,
    false,
  ],
];
it.each(originCases)(
  "preserves wake origin: %s",
  async (_name, target, origin, expected, resolvesOrigin, asynchronous) => {
    const resolveOriginDeliveryContext = vi.fn(asynchronous ? async () => origin : () => origin);
    const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
    const state = createState({
      runIsolatedAgentJob: vi.fn(),
      enqueueSessionEvent,
      resolveOriginDeliveryContext,
    });
    await expect(wake(state, { mode: "now", text: "check the queue", ...target })).resolves.toEqual(
      { ok: true },
    );
    expect(resolveOriginDeliveryContext.mock.calls).toEqual(
      resolvesOrigin ? [[{ sessionKey: target.sessionKey, agentId: target.agentId }]] : [],
    );
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", expected);
    if (!origin) {
      expect(enqueueSessionEvent.mock.calls[0]?.[1]).not.toHaveProperty("deliveryContext");
    }
  },
);
