/**
 * Regression test for #49826: cron job status should not be "error" when the
 * agent task succeeded but delivery failed (transient network error, etc.).
 *
 * The fix ensures that the run outcome is derived from the agent task result
 * (hasFatalErrorPayload) rather than the delivery result when the task itself
 * completed successfully.
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
} from "./run.test-harness.js";

// Access the mocked deliverOutboundPayloads from the same mock scope as the
// test harness.  The harness already calls vi.mock() on this module so we can
// just import and cast.
const { deliverOutboundPayloads } =
  (await import("../../infra/outbound/deliver.js")) as unknown as {
    deliverOutboundPayloads: ReturnType<typeof vi.fn>;
  };

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — delivery failure does not mark job as error (#49826)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  function setupDeliveryRequested(): void {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "feishu",
      to: "group-123",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "feishu",
      to: "group-123",
      accountId: undefined,
      error: undefined,
    });
  }

  it("returns status ok when agent task succeeded but best-effort delivery threw", async () => {
    mockRunCronFallbackPassthrough();
    setupDeliveryRequested();
    deliverOutboundPayloads.mockRejectedValue(new Error("network timeout"));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          delivery: {
            mode: "announce",
            channel: "feishu",
            to: "group-123",
            bestEffort: true,
          },
        }),
      }),
    );

    // The agent task itself succeeded and delivery is best-effort — status
    // must reflect the task outcome, not the transient delivery failure.
    // Fixes #49826.
    expect(result.status).toBe("ok");
  });

  it("returns status error when agent task succeeded but strict delivery threw", async () => {
    mockRunCronFallbackPassthrough();
    setupDeliveryRequested();
    deliverOutboundPayloads.mockRejectedValue(new Error("network timeout"));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          delivery: { mode: "announce", channel: "feishu", to: "group-123" },
        }),
      }),
    );

    // Delivery is NOT best-effort — strict delivery failure must surface.
    expect(result.status).toBe("error");
  });

  it("returns status error when agent task itself had a fatal error payload", async () => {
    setupDeliveryRequested();

    // Simulate the agent returning an error payload.
    const { runWithModelFallback } =
      (await import("../../agents/model-fallback.js")) as unknown as {
        runWithModelFallback: ReturnType<typeof vi.fn>;
      };
    runWithModelFallback.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "something went wrong", isError: true }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });
    deliverOutboundPayloads.mockRejectedValue(new Error("network timeout"));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          delivery: { mode: "announce", channel: "feishu", to: "group-123" },
        }),
      }),
    );

    // Both agent task AND delivery failed — status should be error.
    expect(result.status).toBe("error");
  });

  it("returns status error when agent task had fatal error but delivery succeeded", async () => {
    setupDeliveryRequested();

    // Agent returns a fatal error payload, but delivery succeeds.
    const { runWithModelFallback } =
      (await import("../../agents/model-fallback.js")) as unknown as {
        runWithModelFallback: ReturnType<typeof vi.fn>;
      };
    runWithModelFallback.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "context window exceeded", isError: true }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });
    deliverOutboundPayloads.mockResolvedValueOnce([{ ok: true }]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          delivery: { mode: "announce", channel: "feishu", to: "group-123" },
        }),
      }),
    );

    // Agent task failed — status must remain "error" even though delivery
    // succeeded.  Fixes P1: fatal payloads must not be rewritten to success.
    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
  });

  it("returns status error when delivery was aborted even with best-effort", async () => {
    // Abort the signal *during delivery* (not before the agent run) so the
    // run reaches the delivery-phase isAborted() guard in run.ts rather than
    // exiting early from the runPrompt abort check.  Fixes P2 review thread.
    const ac = new AbortController();

    mockRunCronFallbackPassthrough();
    setupDeliveryRequested();
    deliverOutboundPayloads.mockImplementationOnce(async () => {
      ac.abort("timeout");
      throw new Error("aborted: timeout");
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        abortSignal: ac.signal,
        job: makeIsolatedAgentTurnJob({
          delivery: { mode: "announce", channel: "feishu", to: "group-123", bestEffort: true },
        }),
      }),
    );

    // Even though delivery is best-effort, an abort/timeout must always surface
    // as an error — the run was killed mid-flight.
    expect(result.status).toBe("error");
  });

  it("returns status ok and delivered=true when delivery succeeds", async () => {
    mockRunCronFallbackPassthrough();
    setupDeliveryRequested();
    deliverOutboundPayloads.mockResolvedValueOnce([{ ok: true }]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          delivery: { mode: "announce", channel: "feishu", to: "group-123" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.delivered).toBe(true);
  });
});
