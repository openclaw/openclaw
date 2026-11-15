import { beforeEach, describe, expect, it, vi } from "vitest";
import "./dispatch-from-config.abort-and-dedupe.test-utils.js";
import "./dispatch-from-config.lifecycle-and-bindings.test-utils.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type {
  ReplyOperation,
  ReplyOperationRunState,
} from "../../sessions/session-controller.contracts.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  messageAuditEvents,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { withDispatchProcessedOutcomeSink } from "./dispatch-processed-outcome.js";
import {
  REPLY_OPERATION_RUN_STATE,
  recordReplyOperationAgentTurn,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("audits an aborted prepared-runtime wait as a skipped reply operation", async () => {
    setNoAbort();
    const abort = new AbortController();
    const preparedLookup = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) =>
      racePromiseWithAbortSignal(new Promise<never>(() => {}), abortSignal),
    );
    const runtimeLoaders = await import("./dispatch-from-config.runtime-loaders.js");
    using _ = vi.spyOn(runtimeLoaders, "loadPreparedModelRuntime").mockResolvedValue({
      loadPublishedGatewayReplyDispatchRuntime: preparedLookup,
    } as never);
    const dispatch = withDispatchProcessedOutcomeSink(() =>
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: "agent:main:main",
        }),
        cfg: { ...emptyConfig, diagnostics: { enabled: true } },
        dispatcher: createDispatcher(),
        replyOptions: { abortSignal: abort.signal },
      }),
    );

    await vi.waitFor(() => expect(preparedLookup).toHaveBeenCalledOnce());
    abort.abort(new Error("request cancelled"));
    const outcome = await dispatch;

    expect(outcome.result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(outcome.processedOutcome).toEqual({
      outcome: "skipped",
      reason: "reply_operation_aborted",
    });
    expect(messageAuditEvents()[0]).toMatchObject({
      status: "blocked",
      outcome: "skipped",
      reasonCode: "reply_operation_aborted",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "reply_operation_aborted",
      }),
    );
    const preparedSignal = preparedLookup.mock.calls[0]?.[0].abortSignal;
    expect(preparedSignal).toBeInstanceOf(AbortSignal);
    expect(preparedSignal?.aborted).toBe(true);
    expect(preparedSignal?.reason).toBe(abort.signal.reason);
    expect(preparedLookup).toHaveBeenCalledWith({
      agentId: "main",
      demand: "interactive",
      abortSignal: preparedSignal,
      onRuntimeLease: expect.any(Function),
    });
  });
});

describe("dispatchReplyFromConfig message session identity", () => {
  beforeEach(describe0BeforeEach0);

  const admittedOwnerFor = (key: string, sessionId: string) =>
    ({ key, sessionId }) as ReplyOperation;

  const dispatchWithAdmittedOwner = async (owner: ReplyOperation | undefined) => {
    setNoAbort();
    const runState: ReplyOperationRunState = {};
    recordReplyOperationAgentTurn([runState], owner);
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "webchat",
        ChatType: "direct",
        SessionKey: "agent:main:main",
      }),
      cfg: { ...emptyConfig, diagnostics: { enabled: true } },
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "Agent reply." }),
      replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
    });
  };

  it("stamps the admitted agent turn session id on the processed message event", async () => {
    // A /new continuation admits a fresh session mid-turn; the pre-admission
    // capture on the lifecycle would group the message with the prior conversation.
    await dispatchWithAdmittedOwner(admittedOwnerFor("agent:main:main", "admitted-session-id"));
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "admitted-session-id",
        sessionKey: "agent:main:main",
        outcome: "completed",
      }),
    );
  });

  it("keeps the captured id when the admitted owner targets another session key", async () => {
    await dispatchWithAdmittedOwner(admittedOwnerFor("agent:other:main", "admitted-other"));
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: undefined,
        outcome: "completed",
      }),
    );
  });
});
