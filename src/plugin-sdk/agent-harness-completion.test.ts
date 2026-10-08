import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { AgentHarnessCompletionCustody } from "../agents/agent-harness-completion-custody.js";
import type { AgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import {
  assertHarnessCompletionSourceAdmission,
  createAgentHarnessCompletionScope,
} from "../agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  loadRequester: vi.fn(),
  reconcile: vi.fn(async () => "unowned"),
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
      mocks.reconcile.mockResolvedValue(custody);
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

  it.each(["unowned", "pending", "delivered"])(
    "rejects requester replacement during awaited %s reconciliation",
    async (custody) => {
      const entered = createDeferred();
      const result = createDeferred<string>();
      mocks.reconcile.mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      const delivery = deliverAgentHarnessCompletion(params());
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          delivery,
          "completion bypassed requester reconciliation",
        );
        mocks.loadRequester.mockReturnValue({
          entry: {
            sessionId: source.requesterSessionId,
            lifecycleRevision: "successor",
          },
        });
        result.resolve(custody);
        await expect(delivery).resolves.toMatchObject({
          delivered: false,
          recoveryBlocked: true,
        });
        expect(mocks.deliver).not.toHaveBeenCalled();
      } finally {
        result.resolve(custody);
        await delivery;
      }
    },
  );

  it("preserves a reconciliation refusal without announcing the completion", async () => {
    const refusal = new SessionTranscriptProjectionUnavailableError(source.requesterSessionId);
    mocks.reconcile.mockRejectedValueOnce(refusal);
    await expect(deliverAgentHarnessCompletion(params())).rejects.toBe(refusal);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

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

describe("SDK harness completion readmission after interrupted admission", () => {
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
      assertHarnessCompletionSourceAdmission({ ...source, sourceRunId: readmitKey });
      return { delivered: true, path: "direct" };
    });
    const { custody } = custodyFixture();
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
      assertHarnessCompletionSourceAdmission({ ...source, sourceRunId: readmitKey });
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
});
