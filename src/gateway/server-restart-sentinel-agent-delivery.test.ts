import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { deliverQueuedGeneratedMediaAgentTurn } from "./server-restart-sentinel-agent-delivery.js";
import { createGeneratedMediaDeliveryEntry } from "./server-restart-sentinel.test-support.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  advanceSessionDeliveryAgentRun: vi.fn(),
  deferSessionDelivery: vi.fn(),
  failSessionDelivery: vi.fn(),
  markSessionDeliveryAttemptStarted: vi.fn(),
  markSessionDeliverySettlement: vi.fn(),
  mergeSessionDeliveryPreparedMediaBlocks: vi.fn(),
}));
vi.mock("../infra/session-delivery-queue-storage.js", () => mocks);
vi.mock("./server-recovery-runtime-context.js", () => ({
  dispatchGatewayLifecycleMethod: mocks.dispatch,
}));

const runId = "image:task-outbound-owned:agent-loop";
const queueId = "session-delivery-outbound-owned";

function deliver(sessionEntry?: SessionEntry) {
  return deliverQueuedGeneratedMediaAgentTurn({
    canonicalKey: "agent:main:main",
    agentId: "main",
    storePath: "/tmp/media-custody/sessions.json",
    queueContext: captureOpenClawStateWorkerContext({
      env: { OPENCLAW_STATE_DIR: "/tmp/media-custody" },
    }),
    entry: createGeneratedMediaDeliveryEntry({
      id: queueId,
      messageId: runId,
      expectedMediaUrls: ["/tmp/proof.png"],
    }),
    sessionEntry,
  });
}

describe("generated-media outbound retry custody", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { resumed: false, partial: false },
    { resumed: false, partial: true },
    { resumed: true, partial: false },
    { resumed: true, partial: true },
  ])(
    "does not rearm an outbound-owned send (resumed: $resumed, partial: $partial)",
    async ({ resumed, partial }) => {
      const result = {
        payloads: [{ mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: {
          status: partial ? "partial_failed" : "failed",
          errorMessage: "transport unavailable before dispatch",
          queueCustody: "held",
          payloadOutcomes: [{ index: 0, status: "failed", sentBeforeError: false }],
        },
      };
      let sessionEntry: SessionEntry | undefined;
      if (resumed) {
        const entry = {
          sessionId: "media-owner",
          updatedAt: 1,
          restartRecoveryDeliverySourceRunId: runId,
          restartRecoveryDeliveryRunId: runId,
        };
        sessionEntry = {
          ...entry,
          ...buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: runId,
            terminalDeliveryEvidence: result,
          }),
        };
      } else {
        mocks.dispatch.mockResolvedValueOnce({ status: "ok", result });
      }

      await expect(deliver(sessionEntry)).rejects.toThrow(
        "outbound recovery retains delivery custody",
      );
      expect(mocks.markSessionDeliverySettlement).toHaveBeenCalledWith(
        expect.objectContaining({ id: queueId }),
        "moved-to-failed",
        expect.any(Object),
      );
      expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
      expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.deferSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.dispatch).toHaveBeenCalledTimes(resumed ? 0 : 1);
    },
  );

  it("still rearms a proven no-send without outbound custody", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: {
          status: "failed",
          errorMessage: "failed before queue admission",
          payloadOutcomes: [{ index: 0, status: "failed", sentBeforeError: false }],
        },
      },
    });
    await expect(deliver()).rejects.toThrow("missed expected media");
    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      queueId,
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
      expect.any(Object),
    );
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
  });
});
