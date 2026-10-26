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
  reconcile: vi.fn(async () => "unowned"),
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
vi.mock("../agents/agent-harness-completion-delivery.js", () => ({
  reconcileHarnessCompletionDelivery: mocks.reconcile,
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
  type AgentHarnessCompletionDelivery,
} from "./agent-harness-completion.js";

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
      { phase: "steer-fallback", delivered: false, path: "none", reason: "steer_dropped" },
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
  mocks.reconcile.mockResolvedValue("unowned");
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

it.each(["pending", "delivered", "blocked"])(
  "honors existing %s requester custody without admitting a second source",
  async (custody) => {
    mocks.reconcile.mockResolvedValue(custody);
    const result = await deliver({ isSourceSessionAdmissionAllowed: () => false });
    expect(result.delivered).toBe(custody === "delivered");
    expect(result.recoveryPending === true).toBe(custody === "pending");
    expect(result.recoveryBlocked === true).toBe(custody === "blocked");
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: source.requesterAgentId,
        sessionKey: source.requesterSessionKey,
        sourceRunId: source.sourceRunId,
        taskRunId: source.sourceSessionKey,
      }),
    );
    expect(mocks.deliver).not.toHaveBeenCalled();
  },
);

it("rejects requester replacement during awaited unowned reconciliation", async () => {
  mocks.reconcile.mockImplementationOnce(async () => {
    await Promise.resolve();
    replaceRequester();
    return "unowned";
  });
  await expect(deliver()).resolves.toMatchObject({
    delivered: false,
    recoveryBlocked: true,
    error: "completion requester locator is missing or replaced",
  });
  expect(mocks.deliver).not.toHaveBeenCalled();
});

it("blocks a replaced requester revision after awaited origin resolution", async () => {
  retireDuringOriginResolution(replaceRequester);
  await expect(deliver()).resolves.toMatchObject({ delivered: false, recoveryBlocked: true });
  expect(mocks.deliver).not.toHaveBeenCalled();
});

const baseKey = buildAnnounceIdempotencyKey("native-result");
const readmitKey = `${baseKey}:readmit:1`;

it("retries a SESSION_WORK_START_CHANGED admission once under a successor identity", async () => {
  const { createSessionWorkStartChangedError } =
    await import("../config/sessions/work-start-error.js");
  // Attempt 1: base identity is fresh, admission accepts its input then throws.
  const spent = new Set<string>();
  mocks.reconcile.mockImplementation((async (request: { sourceRunId: string }) =>
    spent.has(request.sourceRunId) ? "orphaned" : "unowned") as never);
  mocks.deliver.mockImplementationOnce(async (request: { directIdempotencyKey: string }) => {
    spent.add(request.directIdempotencyKey);
    throw createSessionWorkStartChangedError("main");
  });
  mocks.deliver.mockImplementationOnce(async () => {
    assertAdmission({ ...source, sourceRunId: readmitKey });
    return { delivered: true, path: "direct" };
  });
  const custody = custodyFixture();
  await expect(
    deliverAgentHarnessCompletion({ ...params(), completionCustody: custody }),
  ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });

  // Attempt 2 (the monitor's retry): the spent base advances to its successor.
  const delivery = await deliverAgentHarnessCompletion({
    ...params(),
    completionCustody: custody,
  });
  expect(delivery).toMatchObject({ delivered: true, path: "direct" });
  expect(completionSdk.isDurableAgentHarnessCompletionDelivery(delivery)).toBe(true);
  expect(mocks.deliver).toHaveBeenCalledTimes(2);
  expect(mocks.deliver.mock.calls[0]?.[0]).toMatchObject({ directIdempotencyKey: baseKey });
  expect(mocks.deliver.mock.calls[1]?.[0]).toMatchObject({ directIdempotencyKey: readmitKey });

  // A later retry sees the successor's own custody and never admits a third turn.
  mocks.reconcile.mockImplementation((async (request: { sourceRunId: string }) =>
    request.sourceRunId === baseKey ? "orphaned" : "delivered") as never);
  await expect(
    deliverAgentHarnessCompletion({ ...params(), completionCustody: custody }),
  ).resolves.toMatchObject({ delivered: true });
  expect(mocks.deliver).toHaveBeenCalledTimes(2);
});

it("keeps the drop path for a blocked identity and bounds readmission", async () => {
  mocks.reconcile.mockResolvedValue("blocked");
  await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
    delivered: false,
    recoveryBlocked: true,
    error: "completion recovery receipt or owner is unresolved",
  });
  expect(mocks.reconcile).toHaveBeenCalledTimes(1);

  mocks.reconcile.mockClear();
  mocks.reconcile.mockResolvedValue("orphaned");
  await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
    delivered: false,
    recoveryBlocked: true,
    error: "completion readmission limit reached after interrupted admissions",
  });
  expect(mocks.reconcile).toHaveBeenCalledTimes(4);
  expect((mocks.reconcile.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({
    sourceRunId: `${baseKey}:readmit:3`,
  });
  expect(mocks.deliver).not.toHaveBeenCalled();
});

it("holds unavailable evidence without advancing, then admits exactly one successor", async () => {
  let evidence: "unavailable" | "unowned" = "unavailable";
  mocks.reconcile.mockImplementation((async (request: { sourceRunId: string }) =>
    request.sourceRunId === baseKey ? "orphaned" : evidence) as never);
  mocks.deliver.mockImplementation(async () => {
    assertAdmission({ ...source, sourceRunId: readmitKey });
    return { delivered: true, path: "direct" };
  });
  await expect(deliverAgentHarnessCompletion(params())).resolves.toEqual({
    delivered: false,
    path: "none",
    recoveryUnavailable: true,
    error: "completion custody evidence is temporarily unavailable",
  });
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  expect((mocks.reconcile.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({
    sourceRunId: readmitKey,
  });
  expect(mocks.deliver).not.toHaveBeenCalled();

  evidence = "unowned";
  await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
    delivered: true,
    path: "direct",
  });
  expect(mocks.deliver).toHaveBeenCalledTimes(1);
  expect(mocks.deliver.mock.calls[0]?.[0]).toMatchObject({ directIdempotencyKey: readmitKey });
});

it("never advances past an unavailable base identity", async () => {
  mocks.reconcile.mockResolvedValue("unavailable");
  await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
    delivered: false,
    recoveryUnavailable: true,
  });
  expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceRunId: baseKey }),
  );
  expect(mocks.deliver).not.toHaveBeenCalled();
});

it("stops at a blocked successor without admitting it", async () => {
  mocks.reconcile.mockImplementation((async (request: { sourceRunId: string }) =>
    request.sourceRunId === baseKey ? "orphaned" : "blocked") as never);
  await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
    delivered: false,
    recoveryBlocked: true,
    error: "completion recovery receipt or owner is unresolved",
  });
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  expect(mocks.deliver).not.toHaveBeenCalled();
});
