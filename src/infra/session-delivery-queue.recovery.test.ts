import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue.js";

describe("session-delivery queue recovery", () => {
  it("replays and acks pending entries on recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("keeps failed entries queued with retry metadata for later recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          throw new Error("transient failure");
        }),
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      expect(summary.failed).toBe(1);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("transient failure");
    });
  });
});
