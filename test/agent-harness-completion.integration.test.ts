import { beforeEach, expect, it, vi } from "vitest";
import type { AgentHarnessCompletionCustody as CompletionCustody } from "../src/agents/agent-harness-completion-custody.js";
import type { AgentHarnessCompletionScope as CompletionScope } from "../src/agents/agent-harness-completion-scope.js";
import {
  assertHarnessCompletionSourceAdmission as assertAdmission,
  createAgentHarnessCompletionScope,
} from "../src/agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../src/agents/announce-idempotency.js";
import { buildAgentInternalEventContext } from "../src/agents/internal-events.js";
import type * as AnnounceRuntime from "../src/agents/subagents/announce/subagent-announce-delivery.runtime.js";
import { SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION } from "../src/agents/subagents/completion/subagent-completion-instructions.js";

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
vi.mock("../src/agents/agent-harness-completion-custody.js", () => ({
  captureAgentHarnessCompletionCustody: vi.fn(),
  createAgentHarnessCompletionEventSink: vi.fn(),
  runWithAgentHarnessCompletionCustody: mocks.runWithCustody,
}));
// mock-isolation: Keep requester storage and outbound delivery inside the fixture.
vi.mock("../src/agents/subagents/announce/subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: mocks.deliver,
  loadRequesterSessionEntry: mocks.loadRequester,
  isInternalAnnounceRequesterSession: () => false,
}));
vi.mock(
  "../src/agents/subagents/announce/subagent-announce-delivery.runtime.js",
  async (importOriginal) => ({
    ...(await importOriginal<typeof AnnounceRuntime>()),
    captureRequesterSessionEntryCurrent: async (sessionKey: string, agentId?: string) => ({
      readCurrent: () => mocks.loadRequester(sessionKey, agentId).entry,
      release() {},
    }),
  }),
);
// mock-isolation: Keep channel routing and delivery hooks inside the fixture.
vi.mock("../src/agents/subagents/announce/subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: () => ({ channel: "test", to: "requester" }),
  resolveSubagentCompletionOrigin: mocks.resolveCompletionOrigin,
}));
import * as completionSdk from "../src/plugin-sdk/agent-harness-completion.js";
import {
  deliverAgentHarnessCompletion,
  isDurableAgentHarnessCompletionDelivery,
  type AgentHarnessCompletionDelivery,
} from "../src/plugin-sdk/agent-harness-completion.js";

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
it.each([undefined, " Keep the review private; send any visible update with the message tool. "])(
  "preserves outcome guidance alongside reply instruction %j at delivery",
  async (replyInstruction) => {
    const result = "Review failed: revise the implementation in this child session.";
    await deliver({ replyInstruction, result });
    const announcement = mocks.deliver.mock.calls[0]![0];
    const [event] = announcement.internalEvents;
    expect(event.replyInstruction).toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
    expect(event.replyInstruction.split("This completion ends one child run")).toHaveLength(2);
    expect(event.replyInstruction).toContain(
      replyInstruction?.trim() ?? "send the visible response with the message tool",
    );
    expect(announcement.triggerMessage).toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
    const fragments = buildAgentInternalEventContext(announcement.internalEvents);
    const instructions = fragments.filter((part) => part.kind === "runtime-instruction");
    expect(
      instructions.some((part) => part.text.includes("fixable blockers require continued work")),
    ).toBe(true);
    expect(instructions.every((part) => !part.text.includes(result))).toBe(true);
    expect(fragments.find((part) => part.kind === "conversation-data")?.text).toContain(result);
  },
);

it("delivers a detached Codex parent's native review result with shared outcome guidance", async () => {
  const { loadCodexNativeSubagentMonitorTestFixture } =
    await import("../extensions/codex/test-api.js");
  const { createClient, createRuntime, CodexNativeSubagentMonitor, notifyChildStarted } =
    await loadCodexNativeSubagentMonitorTestFixture();
  const client = createClient();
  const runtime = createRuntime();
  runtime.deliverAgentHarnessCompletion.mockImplementation(deliverAgentHarnessCompletion);
  mocks.deliver.mockResolvedValue({ delivered: true, path: "direct" });
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime);
  const parent = await monitor.registerParent({
    parentThreadId: "parent-thread",
    requesterSessionKey: source.requesterSessionKey,
    agentId: source.requesterAgentId,
    completionScope: createAgentHarnessCompletionScope(source),
  });
  try {
    parent.bindTurn("parent-turn");
    await notifyChildStarted(client);
    const result = "Review failed: revise in this child session.";
    await client.completeTurn({
      status: "completed",
      turnId: "child-turn",
      items: [{ type: "agentMessage", id: "review", phase: "final_answer", text: result }],
    });
    expect(mocks.deliver).not.toHaveBeenCalled();
    await parent.unregister();
    expect(mocks.deliver).toHaveBeenCalledOnce();
    const announcement = mocks.deliver.mock.calls[0]![0];
    expect(announcement.internalEvents[0]).toMatchObject({
      result,
      replyInstruction: expect.stringContaining(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION),
    });
    expect(announcement.triggerMessage).toContain("Use the Codex native subagent result");
    expect(announcement.triggerMessage).toContain(
      "send the visible response with the message tool",
    );
    expect(announcement.triggerMessage).toContain("do not expose internal notification markup");
  } finally {
    await parent.unregister();
    await monitor.dispose();
    client.close();
  }
});

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

it("blocks a replaced requester revision after awaited origin resolution", async () => {
  retireDuringOriginResolution(replaceRequester);
  await expect(deliver()).resolves.toMatchObject({ delivered: false, recoveryBlocked: true });
  expect(mocks.deliver).not.toHaveBeenCalled();
});
