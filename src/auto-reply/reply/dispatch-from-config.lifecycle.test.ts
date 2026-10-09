import { beforeEach, describe, expect, it, vi } from "vitest";
import "./dispatch-from-config.abort-and-dedupe.test-utils.js";
import "./dispatch-from-config.lifecycle-and-bindings.test-utils.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
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
} from "./dispatch-from-config.test-harness.js";
import { withDispatchProcessedOutcomeSink } from "./dispatch-processed-outcome.js";
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
    const preparedLoader = vi.spyOn(runtimeLoaders, "loadPreparedModelRuntime").mockResolvedValue({
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
    try {
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
      expect(preparedLookup).toHaveBeenCalledWith({
        agentId: "main",
        demand: "interactive",
        abortSignal: abort.signal,
        onRuntimeLease: expect.any(Function),
      });
    } finally {
      preparedLoader.mockRestore();
    }
  });
});
