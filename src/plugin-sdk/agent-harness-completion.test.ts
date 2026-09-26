import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarnessCompletionCustody } from "../agents/agent-harness-completion-custody.js";
import type { AgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import {
  assertHarnessCompletionSourceAdmission,
  createAgentHarnessCompletionScope,
} from "../agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  loadRequester: vi.fn(),
  reconcile: vi.fn(() => "unowned"),
  resolveCompletionOrigin: vi.fn(async () => undefined),
  custodyCurrent: true,
  isCustodyCurrent: vi.fn((custody: AgentHarnessCompletionCustody) => custody.isCurrent()),
  runWithCustody: vi.fn(
    <T>(
      custody: AgentHarnessCompletionCustody,
      _scope: AgentHarnessCompletionScope,
      run: () => T,
    ): T => {
      if (!custody.isCurrent()) {
        throw new Error("Completion custody retired");
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
vi.mock("../agents/subagents/announce/subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: () => ({ channel: "test", to: "requester" }),
  resolveSubagentCompletionOrigin: mocks.resolveCompletionOrigin,
}));
import * as completionSdk from "./agent-harness-completion.js";
import { deliverAgentHarnessCompletion } from "./agent-harness-completion.js";

const source = {
  requesterSessionKey: "main",
  requesterAgentId: "alternate",
  requesterSessionId: "requester-1",
  requesterLifecycleRevision: "revision-1",
  sourceSessionKey: "native-child:one",
  sourceRunId: buildAnnounceIdempotencyKey("native-result"),
};
function params() {
  return {
    scope: createAgentHarnessCompletionScope(source),
    childSessionKey: source.sourceSessionKey,
    childSessionId: "native-thread",
    announceId: "native-result",
    status: "succeeded" as const,
    result: "Child result",
    isSourceSessionAdmissionAllowed: () => true,
  };
}
function custodyFixture() {
  const controller = new AbortController();
  const custody: AgentHarnessCompletionCustody = {
    signal: controller.signal,
    isCurrent: () => mocks.custodyCurrent && !controller.signal.aborted,
    retain: () => custody,
    settleExecution: vi.fn(),
    release: () => controller.abort(),
  };
  return { custody, controller };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.custodyCurrent = true;
  mocks.reconcile.mockReturnValue("unowned");
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
    assertHarnessCompletionSourceAdmission(source);
    return { delivered: true, path: "direct" };
  });
});

describe("SDK harness completion source admission", () => {
  it("enters retained custody without exposing its internal execution callback", async () => {
    const { custody } = custodyFixture();
    const input = params();
    mocks.deliver.mockImplementation(async () => {
      expect(mocks.runWithCustody).toHaveBeenCalledExactlyOnceWith(
        custody,
        input.scope,
        expect.any(Function),
      );
      assertHarnessCompletionSourceAdmission(source);
      return { delivered: true, path: "direct" };
    });
    await expect(
      deliverAgentHarnessCompletion({ ...input, completionCustody: custody }),
    ).resolves.toMatchObject({ delivered: true });
    expect(completionSdk.captureAgentHarnessCompletionCustody).toBeTypeOf("function");
    expect(completionSdk.createAgentHarnessCompletionEventSink).toBeTypeOf("function");
    expect(Object.hasOwn(completionSdk, "runWithAgentHarnessCompletionCustody")).toBe(false);
  });

  it("rejects custody retired during awaited origin resolution", async () => {
    const { custody } = custodyFixture();
    mocks.resolveCompletionOrigin.mockImplementation(async () => {
      mocks.custodyCurrent = false;
      return undefined;
    });
    await expect(
      deliverAgentHarnessCompletion({ ...params(), completionCustody: custody }),
    ).rejects.toThrow("custody retired");
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it.each(["custody-currentness", "custody-signal", "caller-signal"] as const)(
    "fences %s at asynchronous admission and effect boundaries",
    async (ending) => {
      const { custody, controller } = custodyFixture();
      const caller = new AbortController();
      mocks.deliver.mockImplementation(async (delivery) => {
        const assertCurrent = assertHarnessCompletionSourceAdmission(source);
        expect(delivery.isSourceSessionAdmissionAllowed()).toBe(true);
        expect(delivery.isSourceSessionEffectsAllowed()).toBe(true);
        expect(delivery.signal.aborted).toBe(false);
        await Promise.resolve();
        if (ending === "custody-currentness") {
          mocks.custodyCurrent = false;
        } else if (ending === "custody-signal") {
          controller.abort();
        } else {
          caller.abort();
        }
        expect(delivery.signal.aborted).toBe(ending !== "custody-currentness");
        expect(delivery.isSourceSessionAdmissionAllowed()).toBe(false);
        expect(delivery.isSourceSessionEffectsAllowed()).toBe(false);
        expect(assertCurrent).toThrow("source owner retired");
        return { delivered: false, path: "none" };
      });
      await expect(
        deliverAgentHarnessCompletion({
          ...params(),
          completionCustody: custody,
          signal: caller.signal,
        }),
      ).resolves.toMatchObject({ delivered: false });
    },
  );

  it("carries exact host authority through the registered delivery entrypoint and closes it afterward", async () => {
    let retained: (() => void) | undefined;
    mocks.deliver.mockImplementation(async () => {
      await Promise.resolve();
      retained = assertHarnessCompletionSourceAdmission(source);
      expect(() =>
        assertHarnessCompletionSourceAdmission({ ...source, sourceRunId: "forged" }),
      ).toThrow("exact host-issued");
      expect(() =>
        assertHarnessCompletionSourceAdmission({ ...source, requesterAgentId: "main" }),
      ).toThrow("exact host-issued");
      return { delivered: true, path: "direct" };
    });
    await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
      delivered: true,
    });
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterAgentId: "alternate",
        requesterSessionKey: "main",
        sourceSessionKey: source.sourceSessionKey,
        directIdempotencyKey: source.sourceRunId,
        sourceTool: "agent_harness_completion",
      }),
    );
    expect(
      mocks.loadRequester.mock.calls.every(
        ([key, agentId]) => key === "main" && agentId === "alternate",
      ),
    ).toBe(true);
    expect(retained).toBeDefined();
    expect(() => retained!()).toThrow("source owner retired");
    expect(() => assertHarnessCompletionSourceAdmission(source)).toThrow("exact host-issued");
  });

  it("rejects copied scopes and retired source owners before announcement", async () => {
    const input = params();
    await expect(
      deliverAgentHarnessCompletion({ ...input, scope: { ...input.scope } }),
    ).rejects.toThrow("host-issued scope");
    await expect(
      deliverAgentHarnessCompletion({ ...input, isSourceSessionAdmissionAllowed: () => false }),
    ).rejects.toThrow("source owner retired");
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("rechecks source authority after asynchronous delivery work", async () => {
    let current = true;
    mocks.deliver.mockImplementation(async () => {
      const assertCurrent = assertHarnessCompletionSourceAdmission(source);
      await Promise.resolve();
      current = false;
      assertCurrent();
    });
    await expect(
      deliverAgentHarnessCompletion({
        ...params(),
        isSourceSessionAdmissionAllowed: () => current,
      }),
    ).rejects.toThrow("source owner retired");
  });

  it.each(["pending", "delivered", "blocked"])(
    "honors existing %s requester custody without admitting a second source",
    async (custody) => {
      mocks.reconcile.mockReturnValue(custody);
      const result = await deliverAgentHarnessCompletion({
        ...params(),
        isSourceSessionAdmissionAllowed: () => false,
      });
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

  it.each(["missing", "session", "revision"])(
    "blocks %s requester after awaited origin resolution",
    async (kind) => {
      mocks.resolveCompletionOrigin.mockImplementation(async () => {
        mocks.loadRequester.mockReturnValue({
          entry:
            kind === "missing"
              ? undefined
              : {
                  sessionId: kind === "session" ? "successor" : source.requesterSessionId,
                  lifecycleRevision:
                    kind === "revision" ? "successor" : source.requesterLifecycleRevision,
                },
        });
        return undefined;
      });
      await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
        delivered: false,
        recoveryBlocked: true,
      });
      expect(mocks.deliver).not.toHaveBeenCalled();
    },
  );
});
