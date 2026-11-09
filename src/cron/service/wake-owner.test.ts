import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { makeCronJob } from "../delivery.test-helpers.js";
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
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}
const mainJob = () =>
  makeCronJob({
    payload: { kind: "systemEvent", text: "  check pending work  " },
    sessionTarget: "main",
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
    const state = createState({ runSessionEvent });
    const controller = new AbortController();
    const pending = executeJobCore(state, mainJob(), controller.signal, {
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
  to: "telegram:42:topic:7",
  threadId: "7",
  accountId: "default",
};
const sessionKey = "agent:main:telegram:42:topic:7";
const expectedTarget: SessionEventTarget = {
  sessionId: "source",
  generation: "generation",
  deliveryContext,
};
const owner = { sessionKey, agentId: "main" };
type OriginCase = [
  string,
  Omit<Parameters<typeof wake>[1], "mode" | "text">,
  DeliveryContext | undefined,
  Parameters<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>[1],
  boolean,
];
it.each<OriginCase>([
  [
    "captured target",
    { ...owner, expectedTarget },
    { channel: "telegram", to: "other" },
    { ...owner, expectedTarget, deliveryContext },
    false,
  ],
  ["async targeted route", owner, deliveryContext, { ...owner, deliveryContext }, true],
  ["target without agent", { sessionKey }, deliveryContext, { sessionKey, deliveryContext }, true],
  ["no resolved route", { sessionKey }, undefined, { sessionKey }, true],
  [
    "untargeted owner",
    {},
    deliveryContext,
    { createIfMissing: undefined, assertAcceptanceCurrent: undefined },
    false,
  ],
])("preserves wake origin: %s", async (name, target, origin, expected, resolvesOrigin) => {
  const resolveOriginDeliveryContext = vi.fn(
    name === "async targeted route" ? async () => origin : () => origin,
  );
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const state = createState({ enqueueSessionEvent, resolveOriginDeliveryContext });
  await expect(wake(state, { mode: "now", text: "check the queue", ...target })).resolves.toEqual({
    ok: true,
  });
  expect(resolveOriginDeliveryContext.mock.calls).toEqual(
    resolvesOrigin ? [[{ sessionKey: target.sessionKey, agentId: target.agentId }]] : [],
  );
  expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", expected);
  if (!origin) {
    expect(enqueueSessionEvent.mock.calls[0]?.[1]).not.toHaveProperty("deliveryContext");
  }
});

const scriptTarget: SessionEventTarget = {
  agentId: "finn",
  sessionKey: "agent:finn:main",
  sessionId: "original-session",
  generation: "original-generation",
};
function scriptFixture(mode: "now" | "next-heartbeat", cronEnabled = true) {
  const state = createState({
    cronEnabled,
    cronConfig: { triggers: { enabled: true } },
    enqueueSessionEvent: vi.fn(),
    deferSessionEvent: vi.fn(),
    captureSessionEventTarget: vi.fn(async () => scriptTarget),
    resolveSessionEventTarget: () => ({ agentId: "finn", sessionKey: scriptTarget.sessionKey }),
    runScriptJob: vi.fn(async () => ({
      status: "ok" as const,
      notify: "Review the result.",
      wake: mode,
    })),
  });
  const job = makeCronJob({
    agentId: "finn",
    wakeMode: "now",
    payload: { kind: "script", script: "return { wake: 'now' }" },
  });
  return {
    state,
    job,
    execute: (signal?: AbortSignal) =>
      executeJobCore(state, job, signal, { migrationPending: false }),
  };
}

it("sends an immediate script follow-up to the captured session while scheduling is disabled", async () => {
  const { state, execute } = scriptFixture("now", false);
  expect(await execute()).toMatchObject({ status: "ok" });
  expect(vi.mocked(state.deps.captureSessionEventTarget!).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(state.deps.runScriptJob!).mock.invocationCallOrder[0]!,
  );
  expect(state.deps.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("Review the result.", {
    agentId: "finn",
    expectedTarget: scriptTarget,
    assertAcceptanceCurrent: expect.any(Function),
  });
  expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(state.deps.deferSessionEvent).not.toHaveBeenCalled();
});

it("attaches deferred script follow-up only to an enabled ordinary scheduled session job", async () => {
  const { state, job, execute } = scriptFixture("next-heartbeat");
  const receiver = {
    ...job,
    id: "ordinary-receiver",
    sessionTarget: "session:agent:finn:main",
    payload: { kind: "agentTurn" as const, message: "Review pending notices." },
    state: { nextRunAtMs: 60_000 },
  } satisfies ReturnType<typeof makeCronJob>;
  state.store = { version: 1, jobs: [receiver] };
  expect(await execute()).toMatchObject({ status: "ok" });
  expect(state.deps.deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
    "Review the result.",
    receiver,
    scriptTarget,
    expect.any(Function),
    60_000,
    undefined,
    undefined,
  );
  expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
  receiver.enabled = false;
  expect(await execute()).toMatchObject({
    status: "error",
    error: expect.stringContaining("No enabled ordinary scheduled session job"),
  });
  expect(state.deps.deferSessionEvent).toHaveBeenCalledTimes(1);
});

it("records a visible script error when the original destination cannot be captured", async () => {
  const { state, execute } = scriptFixture("now");
  state.deps.captureSessionEventTarget = async () => undefined;
  expect(await execute()).toMatchObject({
    status: "error",
    error: expect.stringContaining("no original session target"),
  });
  expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
});

it("does not admit a script follow-up cancelled while resolving its origin route", async () => {
  const { state, execute } = scriptFixture("now");
  const entered = createDeferred();
  const release = createDeferred();
  const controller = new AbortController();
  state.deps.resolveOriginDeliveryContext = async () => {
    entered.resolve();
    await release.promise;
    return undefined;
  };
  const pending = execute(controller.signal);
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Script follow-up skipped route resolution",
    );
    controller.abort(new Error("script occurrence cancelled"));
    release.resolve();
    await expect(pending).rejects.toThrow("script occurrence cancelled");
    expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(state.deps.deferSessionEvent).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
  }
});
