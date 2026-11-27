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
