import { beforeEach, describe, expect, it, vi } from "vitest";
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
  isCustodyCurrent: vi.fn((custody: CompletionCustody) => custody.isCurrent()),
  runWithCustody: vi.fn(
    <T>(custody: CompletionCustody, _scope: CompletionScope, run: () => T): T => {
      if (!custody.isCurrent()) {
        throw mocks.custodyError;
      }
      return run();
    },
  ),
}));
vi.mock("../agents/agent-harness-completion-custody.js", () => ({
  captureAgentHarnessCompletionCustody: vi.fn(),
  createAgentHarnessCompletionEventSink: vi.fn(),
  isAgentHarnessCompletionCustodyCurrent: mocks.isCustodyCurrent,
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

describe("SDK harness completion delivery contract", () => {
  it.each<{ name: string; delivery: AgentHarnessCompletionDelivery; durable: boolean }>([
    {
      name: "direct result without phases",
      delivery: { delivered: true, path: "direct" },
      durable: true,
    },
    {
      name: "direct result with no executed phase",
      delivery: { delivered: true, path: "direct", phases: [] },
      durable: false,
    },
    {
      name: "completed direct phase",
      delivery: {
        delivered: true,
        path: "direct",
        phases: [
          {
            phase: "direct-primary",
            delivered: true,
            path: "direct",
            deliveredAt: 123,
            enqueuedAt: 100,
          },
        ],
      },
      durable: true,
    },
    {
      name: "unsuccessful direct phase",
      delivery: {
        delivered: true,
        path: "direct",
        phases: [
          {
            phase: "direct-primary",
            delivered: false,
            path: "none",
            reason: "requester_turn_pending",
            error: "requester is pending",
          },
        ],
      },
      durable: false,
    },
    {
      name: "steer evidence does not prove direct delivery",
      delivery: {
        delivered: true,
        path: "direct",
        phases: [
          { phase: "steer-primary", delivered: true, path: "steered" },
          { phase: "steer-fallback", delivered: false, path: "none", reason: "steer_dropped" },
        ],
      },
      durable: false,
    },
    {
      name: "successful steer",
      delivery: { delivered: true, path: "steered", phases: [] },
      durable: true,
    },
    { name: "queued result", delivery: { delivered: true, path: "queued" }, durable: false },
    { name: "failed result", delivery: { delivered: false, path: "direct" }, durable: false },
  ])("preserves $name", ({ delivery, durable }) => {
    expect(isDurableAgentHarnessCompletionDelivery(delivery)).toBe(durable);
  });
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
