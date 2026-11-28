import { beforeEach, expect, it, vi } from "vitest";
import type { AgentHarnessCompletionCustody as CompletionCustody } from "../agents/agent-harness-completion-custody.js";
import type { AgentHarnessCompletionScope as CompletionScope } from "../agents/agent-harness-completion-scope.js";
import {
  assertHarnessCompletionSourceAdmission as assertAdmission,
  createAgentHarnessCompletionScope,
} from "../agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import type * as AnnounceRuntime from "../agents/subagents/announce/subagent-announce-delivery.runtime.js";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  loadRequester: vi.fn(),
  resolveCompletionOrigin: vi.fn(async () => undefined),
  custodyCurrent: true,
  custodyError: new Error("Completion custody retired"),
  runWithCustody: vi.fn(
    <T>(custody: CompletionCustody, _scope: CompletionScope, run: () => T): T => {
      if (!custody.isCurrent()) {
        throw mocks.custodyError;
      }
      return run();
    },
  ),
}));
// mock-isolation: Keep process-global custody and Gateway continuation state outside this fixture.
vi.mock("../agents/agent-harness-completion-custody.js", () => ({
  captureAgentHarnessCompletionCustody: vi.fn(),
  createAgentHarnessCompletionEventSink: vi.fn(),
  runWithAgentHarnessCompletionCustody: mocks.runWithCustody,
}));
vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: mocks.deliver,
  loadRequesterSessionEntry: mocks.loadRequester,
  isInternalAnnounceRequesterSession: () => false,
}));
vi.mock(
  "../agents/subagents/announce/subagent-announce-delivery.runtime.js",
  async (importOriginal) => ({
    ...(await importOriginal<typeof AnnounceRuntime>()),
    captureRequesterSessionEntryCurrent: async (sessionKey: string, agentId?: string) => ({
      readCurrent: () => mocks.loadRequester(sessionKey, agentId).entry,
      release() {},
    }),
  }),
);
vi.mock("../agents/subagents/announce/subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: () => ({ channel: "test", to: "requester" }),
  resolveSubagentCompletionOrigin: mocks.resolveCompletionOrigin,
}));
import * as completionSdk from "./agent-harness-completion.js";
import {
  deliverAgentHarnessCompletion,
  isDurableAgentHarnessCompletionDelivery,
  registerAgentHarnessCompletion,
  type AgentHarnessCompletionDelivery,
} from "./agent-harness-completion.js";

it("retires a native result consumed before its completion fact without delivering it again", async () => {
  const send = vi.fn(async () => direct());
  const retire = vi.fn(async () => {});
  const registration = {
    scope: createAgentHarnessCompletionScope(source),
    assignmentId: "already-consumed-native-turn",
    isCurrent: () => true,
    readiness: () => "ready" as const,
    observeConsumption: async () => false,
    deliver: send,
    retire,
    settleExecution() {},
    onError(error: unknown) {
      throw error;
    },
  };
  expect(() =>
    registerAgentHarnessCompletion({
      ...registration,
      scope: { ...registration.scope },
    }),
  ).toThrow("host-issued scope");
  const owner = registerAgentHarnessCompletion(registration);
  try {
    owner.consume();
    await owner.complete("native result");
    expect(send).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledWith("consumed", expect.any(Function));
    expect(owner.isConsumed()).toBe(true);
  } finally {
    owner.release();
  }
});

it("keeps native consumption through an in-flight failure and separates a successor assignment", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<AgentHarnessCompletionDelivery>();
  const send = vi.fn(() => {
    started.resolve();
    return response.promise;
  });
  const retire = vi.fn(async () => {});
  const registration = {
    scope: createAgentHarnessCompletionScope(source),
    assignmentId: "native-turn-one",
    isCurrent: () => true,
    readiness: () => "ready" as const,
    observeConsumption: async () => false,
    deliver: send,
    retire,
    settleExecution() {},
    onError(error: unknown) {
      throw error;
    },
  };
  const owner = registerAgentHarnessCompletion({
    ...registration,
    scope: createAgentHarnessCompletionScope({
      ...source,
      gatewayContextResolver: () => undefined,
    }),
  });
  const duplicate = registerAgentHarnessCompletion({
    ...registration,
    scope: createAgentHarnessCompletionScope({
      ...source,
      gatewayContextResolver: () => undefined,
    }),
  });
  const successorSend = vi.fn(async () => direct());
  const successor = registerAgentHarnessCompletion({
    ...registration,
    assignmentId: "native-turn-two",
    deliver: successorSend,
  });
  try {
    const attempt = owner.complete("same native result");
    await started.promise;
    await duplicate.complete("same native result");
    duplicate.consume();
    response.resolve({ delivered: false, path: "none", error: "late transport failure" });
    await attempt;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(send).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledWith("consumed", expect.any(Function));
    await successor.complete("same native result");
    expect(successorSend).toHaveBeenCalledOnce();
  } finally {
    owner.release();
    duplicate.release();
    successor.release();
    vi.useRealTimers();
  }
});

it("cannot retire a successor from a released native delivery attempt", async () => {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<AgentHarnessCompletionDelivery>();
  const retire = vi.fn(async () => {});
  const owner = registerAgentHarnessCompletion({
    scope: createAgentHarnessCompletionScope(source),
    assignmentId: "released-native-attempt",
    isCurrent: () => true,
    readiness: () => "ready",
    observeConsumption: async () => false,
    deliver: () => {
      entered.resolve();
      return result.promise;
    },
    retire,
    settleExecution() {},
    onError(error) {
      throw error;
    },
  });
  const pending = owner.complete("old result");
  await entered.promise;
  owner.release();
  result.resolve(direct());
  await pending;
  expect(retire).not.toHaveBeenCalled();
  expect(() => owner.complete("successor result")).toThrow("registration is closed");
});

it("retires a duplicate observer after the shared delivery is abandoned", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<AgentHarnessCompletionDelivery>();
  const send = vi.fn(() => {
    started.resolve();
    return response.promise;
  });
  const retire = vi.fn(async (outcome: string) => {
    if (outcome === "undelivered") {
      owner.release();
    }
  });
  const registration = {
    scope: createAgentHarnessCompletionScope(source),
    assignmentId: "abandoned-native-result",
    isCurrent: () => true,
    readiness: () => "ready" as const,
    observeConsumption: async () => false,
    deliver: send,
    retire,
    settleExecution() {},
    onError(error: unknown) {
      throw error;
    },
  };
  const owner = registerAgentHarnessCompletion(registration);
  const duplicate = registerAgentHarnessCompletion(registration);
  try {
    const pending = owner.complete("native result");
    await started.promise;
    await duplicate.complete("native result");
    response.resolve({ delivered: false, path: "none", recoveryBlocked: true });
    await pending;
    await duplicate.waitForDelivery();
    expect(send).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledWith("unavailable", expect.any(Function));
  } finally {
    owner.release();
    duplicate.release();
  }
});

it("accepts a duplicate receipt while undelivered retirement is still pending", async () => {
  const entered = Promise.withResolvers<void>();
  const persistence = Promise.withResolvers<void>();
  const send = vi.fn(async () => ({
    delivered: false,
    path: "none" as const,
    recoveryBlocked: true as const,
  }));
  const retire = vi.fn(async (outcome: string, assertCurrent: () => void) => {
    if (outcome === "undelivered") {
      entered.resolve();
      await persistence.promise;
      assertCurrent();
    }
  });
  const registration = {
    scope: createAgentHarnessCompletionScope(source),
    assignmentId: "retiring-native-result",
    isCurrent: () => true,
    readiness: () => "ready" as const,
    observeConsumption: async () => false,
    deliver: send,
    retire,
    settleExecution() {},
    onError(error: unknown) {
      throw error;
    },
  };
  const owner = registerAgentHarnessCompletion(registration);
  const duplicate = registerAgentHarnessCompletion(registration);
  try {
    const pending = owner.complete("native result");
    await entered.promise;
    await duplicate.complete("native result");
    duplicate.consume();
    persistence.resolve();
    await pending;
    await duplicate.waitForDelivery();
    expect(send).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledWith("consumed", expect.any(Function));
    expect(owner.isConsumed()).toBe(true);
  } finally {
    persistence.resolve();
    owner.release();
    duplicate.release();
  }
});

it("retries consumed retirement without redelivering after repeated persistence failures", async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => direct());
  const retire = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new Error("write unavailable"))
    .mockRejectedValueOnce(new Error("write still unavailable"));
  const owner = registerAgentHarnessCompletion({
    scope: createAgentHarnessCompletionScope(source),
    assignmentId: "consumed-retirement",
    isCurrent: () => true,
    readiness: () => "ready",
    observeConsumption: async () => false,
    deliver: send,
    retire,
    settleExecution() {},
    onError() {},
  });
  try {
    await owner.complete("native result");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retire).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledOnce();
    expect(owner.isConsumed()).toBe(true);
  } finally {
    owner.release();
    vi.useRealTimers();
  }
});

const source = {
  requesterSessionKey: "main",
  requesterAgentId: "alternate",
  requesterSessionId: "requester-1",
  requesterLifecycleRevision: "revision-1",
  sourceSessionKey: "native-child:one",
  sourceRunId: buildAnnounceIdempotencyKey("native-result"),
};
type Input = Parameters<typeof deliverAgentHarnessCompletion>[0];
function params(overrides: Partial<Input> = {}) {
  return {
    scope: createAgentHarnessCompletionScope(source),
    childSessionKey: source.sourceSessionKey,
    childSessionId: "native-thread",
    announceId: "native-result",
    status: "succeeded" as const,
    result: "Child result",
    isSourceSessionAdmissionAllowed: () => true,
    ...overrides,
  };
}
const deliver = (overrides?: Parameters<typeof params>[0]) =>
  deliverAgentHarnessCompletion(params(overrides));
const rejects = (input: Partial<Input>, message: string) =>
  expect(deliver(input)).rejects.toThrow(message);
function custodyFixture() {
  const controller = new AbortController();
  const custody: CompletionCustody = {
    signal: controller.signal,
    isCurrent: () => mocks.custodyCurrent && !controller.signal.aborted,
    retain: () => custody,
    settleExecution: vi.fn(),
    release: () => controller.abort(),
  };
  return custody;
}

const replaceRequester = () =>
  mocks.loadRequester.mockReturnValue({
    entry: { sessionId: source.requesterSessionId, lifecycleRevision: "successor" },
  });
function retireDuringOriginResolution(retire: () => void) {
  mocks.resolveCompletionOrigin.mockImplementation(async () => {
    retire();
    return undefined;
  });
}

type Phases = NonNullable<AgentHarnessCompletionDelivery["phases"]>;
const direct = (phases?: Phases): AgentHarnessCompletionDelivery => ({
  delivered: true,
  path: "direct",
  ...(phases ? { phases } : {}),
});
const directPhase = (delivered: boolean): Phases => [
  { phase: "direct-primary", delivered, path: delivered ? "direct" : "none" },
];
it.each<[string, AgentHarnessCompletionDelivery, boolean]>([
  ["direct result without phases", direct(), true],
  ["direct result with no executed phase", direct([]), false],
  ["completed direct phase", direct(directPhase(true)), true],
  ["unsuccessful direct phase", direct(directPhase(false)), false],
  [
    "steer evidence does not prove direct delivery",
    direct([
      { phase: "steer-primary", delivered: true, path: "steered" },
      { phase: "steer-fallback", delivered: false, path: "none" },
    ]),
    false,
  ],
  ["successful steer", { delivered: true, path: "steered", phases: [] }, true],
  ["queued result", { delivered: true, path: "queued" }, false],
  ["failed result", { delivered: false, path: "direct" }, false],
])("preserves %s", (_name, delivery, durable) => {
  expect(isDurableAgentHarnessCompletionDelivery(delivery)).toBe(durable);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.custodyCurrent = true;
  mocks.resolveCompletionOrigin.mockImplementation(async () => undefined);
  mocks.loadRequester.mockReturnValue({
    entry: {
      sessionId: source.requesterSessionId,
      lifecycleRevision: source.requesterLifecycleRevision,
    },
    canonicalKey: source.requesterSessionKey,
    agentId: source.requesterAgentId,
    storePath: "/isolated/alternate/sessions.json",
  });
  mocks.deliver.mockImplementation(async () => {
    assertAdmission(source);
    return { delivered: true, path: "direct" };
  });
});

it("enters retained custody without exposing its internal execution callback", async () => {
  const custody = custodyFixture();
  const input = params();
  mocks.deliver.mockImplementation(async () => {
    expect(mocks.runWithCustody).toHaveBeenCalled();
    for (const call of mocks.runWithCustody.mock.calls) {
      expect(call).toEqual([custody, input.scope, expect.any(Function)]);
    }
    assertAdmission(source);
    return { delivered: true, path: "direct" };
  });
  const result = await deliver({ ...input, completionCustody: custody });
  expect(result).toMatchObject({ delivered: true });
  expect(completionSdk.captureAgentHarnessCompletionCustody).toBeTypeOf("function");
  expect(completionSdk.createAgentHarnessCompletionEventSink).toBeTypeOf("function");
  expect(Object.hasOwn(completionSdk, "runWithAgentHarnessCompletionCustody")).toBe(false);
});

it("rejects custody retired during awaited origin resolution", async () => {
  const custody = custodyFixture();
  retireDuringOriginResolution(() => {
    mocks.custodyCurrent = false;
  });
  await expect(deliver({ completionCustody: custody })).rejects.toMatchObject({
    message: "Harness completion custody retired",
    cause: mocks.custodyError,
  });
  expect(mocks.deliver).not.toHaveBeenCalled();
});

it.each(["custody-currentness", "caller-signal"] as const)(
  "fences %s at asynchronous admission and effect boundaries",
  async (ending) => {
    const custody = custodyFixture();
    const caller = new AbortController();
    mocks.deliver.mockImplementation(async (delivery) => {
      const assertCurrent = assertAdmission(source);
      expect(delivery.isSourceSessionAdmissionAllowed()).toBe(true);
      expect(delivery.isSourceSessionEffectsAllowed()).toBe(true);
      expect(delivery.signal.aborted).toBe(false);
      await Promise.resolve();
      if (ending === "custody-currentness") {
        mocks.custodyCurrent = false;
      } else {
        caller.abort();
      }
      expect(delivery.signal.aborted).toBe(ending !== "custody-currentness");
      expect(delivery.isSourceSessionAdmissionAllowed()).toBe(false);
      expect(delivery.isSourceSessionEffectsAllowed()).toBe(false);
      expect(assertCurrent).toThrow("source owner retired");
      return { delivered: false, path: "none" };
    });
    const result = await deliver({ completionCustody: custody, signal: caller.signal });
    expect(result).toMatchObject({ delivered: false });
  },
);

it("carries exact host authority through the registered delivery entrypoint and closes it afterward", async () => {
  let retained: (() => void) | undefined;
  mocks.deliver.mockImplementation(async () => {
    await Promise.resolve();
    retained = assertAdmission(source);
    for (const invalid of [{ sourceRunId: "forged" }, { requesterAgentId: "main" }]) {
      expect(() => assertAdmission({ ...source, ...invalid })).toThrow("exact host-issued");
    }
    return { delivered: true, path: "direct" };
  });
  await expect(deliver()).resolves.toMatchObject({ delivered: true });
  expect(mocks.deliver.mock.calls[0]?.[0]).toMatchObject({
    requesterAgentId: "alternate",
    requesterSessionKey: "main",
    sourceSessionKey: source.sourceSessionKey,
    directIdempotencyKey: source.sourceRunId,
    sourceTool: "agent_harness_completion",
  });
  const requesterCalls = mocks.loadRequester.mock.calls;
  expect(requesterCalls.every(([key, id]) => key === "main" && id === "alternate")).toBe(true);
  expect(() => retained!()).toThrow("source owner retired");
  expect(() => assertAdmission(source)).toThrow("exact host-issued");
});

it("rejects copied scopes and retired source owners before announcement", async () => {
  const input = params();
  await rejects({ ...input, scope: { ...input.scope } }, "host-issued scope");
  await rejects({ ...input, isSourceSessionAdmissionAllowed: () => false }, "source owner retired");
  expect(mocks.deliver).not.toHaveBeenCalled();
});

it("rechecks source authority after asynchronous delivery work", async () => {
  let current = true;
  mocks.deliver.mockImplementation(async () => {
    const assertCurrent = assertAdmission(source);
    await Promise.resolve();
    current = false;
    assertCurrent();
  });
  await rejects({ isSourceSessionAdmissionAllowed: () => current }, "source owner retired");
});

it("delivers to the requester chat after its revision changes during origin resolution", async () => {
  retireDuringOriginResolution(replaceRequester);
  await expect(deliver()).resolves.toMatchObject({ delivered: true });
  expect(mocks.deliver).toHaveBeenCalledOnce();
});
