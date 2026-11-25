import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  prime,
  requireValue,
} from "./agent.test-harness.js";

type HeldAgentResult = {
  payloads: Array<{ text: string }>;
  meta: { durationMs: number };
};

export function registerAgentAbortQueueDeadlineTest({
  captureAgentRunSettlement,
  sourceQueuedAt,
  sourceExpiry,
}: {
  captureAgentRunSettlement: (runId: string) => Promise<void>;
  sourceQueuedAt: (source: RpcSourceRef) => number;
  sourceExpiry: (source: RpcSourceRef) => number;
}) {
  const mocks = getAgentTestMocks();
  it("keeps an elapsed queue deadline terminal before the maintenance sweep", async () => {
    prime();
    const runId = "idem-agent-expired-queue-deadline";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(0);
    const agentResult = createDeferred<HeldAgentResult>();
    let settlement: Promise<void> | undefined;
    let onExecutionStarted: (() => void | Promise<void>) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void | Promise<void> }) => {
        onExecutionStarted = opts.onExecutionStarted;
        return agentResult.promise;
      },
    );
    const context = makeContext();

    try {
      await invokeAgent(
        {
          message: "do not revive an expired queue deadline",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
          timeout: 120,
        },
        { context, respond: vi.fn(), reqId: runId },
      );

      const abortEntry = requireValue(rpcSourceTesting.get(runId), "chat abort entry missing");
      settlement = captureAgentRunSettlement(runId);
      const startedAtMs = sourceQueuedAt(abortEntry);
      const queueExpiresAtMs = sourceExpiry(abortEntry);
      nowMs = queueExpiresAtMs + 1;
      monotonicNow.mockReturnValue(
        requireValue(abortEntry.adapter.timing?.queueDeadlineAtMs, "queue deadline missing") + 1,
      );
      const executionStarted = requireValue(onExecutionStarted, "execution-start callback missing");
      await executionStarted();

      expect(sourceQueuedAt(abortEntry)).toBe(startedAtMs);
      expect(sourceExpiry(abortEntry)).toBe(queueExpiresAtMs);
      expect(abortEntry.input.abortSignal.aborted).toBe(true);
      expect(abortEntry.adapter.abortStopReason).toBe("timeout");

      nowMs = queueExpiresAtMs - 1;
      await executionStarted();
      expect(sourceExpiry(abortEntry)).toBe(queueExpiresAtMs);
    } finally {
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await settlement;
      await remaining;
      dateNow.mockRestore();
      monotonicNow.mockRestore();
    }
  });
}
