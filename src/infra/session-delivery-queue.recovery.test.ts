import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  failSessionDelivery,
  isSessionDeliveryEligibleForRetry,
  loadPendingSessionDeliveries,
  markSessionDeliveryPlatformOutcomeUnknown,
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
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
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

  it("uses the entry retry budget when draining entries", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          maxRetries: 20,
        },
        tempDir,
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await failSessionDelivery(id, "busy", tempDir);
      }

      const deliver = vi.fn(async () => undefined);
      await drainPendingSessionDeliveries({
        drainKey: "test-restart-continuation",
        logLabel: "test restart continuation",
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        selectEntry: (entry) => ({
          match: entry.id === id,
          bypassBackoff: true,
        }),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("skips entries queued after the startup recovery cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover old entry",
        },
        tempDir,
      );
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave fresh entry queued",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        maxEnqueuedAt,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe("systemEvent");
      if (pending[0]?.kind === "systemEvent") {
        expect(pending[0].text).toBe("leave fresh entry queued");
      }
    });

    vi.useRealTimers();
  });

  it("does not re-deliver a session entry whose first delivery succeeded but was left unacked by a crash", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      const deliver = vi.fn(async () => {
        deliverCount += 1;
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      // PASS 1: deliver 성공, 그러나 ack 의 atomic rename 이 완료되기 전 crash 모델.
      // 두-단계 ack(.json → .delivered → unlink) 에서 1단계 rename 전에 프로세스가
      // 죽으면 entry 는 .json 으로 pending 잔존한다. 실제 SIGKILL 은 catch 블록(실패
      // 핸들러/마커 정리)을 절대 실행하지 못하므로, ack 를 no-op 으로 막아 entry 가
      // "전송됨" 마커를 지닌 채 pending 으로 남게 한다(retryCount=0, lastAttemptAt 없음).
      // recovery 가 직접 import 하는 storage 모듈을 spy 해야 가로채진다.
      const storageMod = await import("./session-delivery-queue-storage.js");
      const ackSpy = vi
        .spyOn(storageMod, "ackSessionDelivery")
        .mockImplementationOnce(async () => undefined);
      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });
      ackSpy.mockRestore();

      const [pending] = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toBeDefined(); // entry 잔존 — "전송됨" 마커가 영속됐어야 함

      // PASS 2: 재시작 후 복구 재진입.
      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });

      // 수정 전: deliverCount === 2 (blind replay → 턴 재실행 + 응답 중복 전송) → FAIL
      // 수정 후: deliverCount === 1 (recoveryState 마커 → reconciliation → blind replay 거부) → PASS
      expect(deliverCount).toBe(1);
    });
  });

  it("does not re-deliver a session entry whose delivery partially sent before throwing", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:456",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      // Model the production delivery seam on a partial_failed send: some
      // payloads already reached the platform (sentBeforeError), so
      // deliverQueuedSessionDelivery persists the unknown_after_send marker and
      // then throws. Recovery must refuse a blind replay rather than clearing the
      // marker and re-running the turn / re-sending the already-sent reply.
      const deliver = vi.fn(async () => {
        deliverCount += 1;
        await markSessionDeliveryPlatformOutcomeUnknown(id, tempDir);
        throw new Error("partial_failed: reply chunk sent before error");
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const drainOnce = () =>
        drainPendingSessionDeliveries({
          drainKey: "test-sent-before-error",
          logLabel: "test sent-before-error",
          deliver,
          stateDir: tempDir,
          log,
          // bypassBackoff so PASS 2 actually attempts the entry instead of being
          // deferred by the retry backoff (which would hide the blind replay).
          selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
        });

      // PASS 1: delivery partially sends, marks unknown_after_send, then throws.
      await drainOnce();
      // The entry must not stay replayable in the main queue: it is moved to
      // failed/ (fail-safe), not requeued with the marker cleared.
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);

      // PASS 2: restart recovery re-entry.
      await drainOnce();

      // Before the fix: the catch cleared the marker and requeued, so PASS 2
      // blind-replays -> deliverCount === 2. After the fix: the marker is
      // preserved and recovery refuses the blind replay -> deliverCount === 1.
      expect(deliverCount).toBe(1);
    });
  });

  it("does not re-deliver when the outcome-marker write fails after a successful delivery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:789",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      // deliver succeeds: the turn ran and the reply was sent.
      const deliver = vi.fn(async () => {
        deliverCount += 1;
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const drainOnce = () =>
        drainPendingSessionDeliveries({
          drainKey: "test-marker-write-failure",
          logLabel: "test marker write failure",
          deliver,
          stateDir: tempDir,
          log,
          selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
        });

      // PASS 1: deliver succeeds, but persisting unknown_after_send fails, so the
      // entry is left at send_attempt_started even though the send already
      // happened. The recovery (which imports the storage helper directly) must
      // still treat this as non-replayable. Spy the storage module so the helper
      // recovery calls is the one that throws.
      const storageMod = await import("./session-delivery-queue-storage.js");
      const markSpy = vi
        .spyOn(storageMod, "markSessionDeliveryPlatformOutcomeUnknown")
        .mockImplementationOnce(async () => {
          throw new Error("simulated marker write failure after delivery");
        });
      await drainOnce();
      markSpy.mockRestore();

      // The already-delivered entry must not stay replayable: it is moved to
      // failed/, not requeued.
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);

      // PASS 2: restart recovery re-entry.
      await drainOnce();

      // Before the fix: the catch saw send_attempt_started, cleared it, and
      // requeued, so PASS 2 blind-replays -> deliverCount === 2. After the fix:
      // tracking that deliver() returned makes the post-delivery failure
      // non-replayable -> deliverCount === 1.
      expect(deliverCount).toBe(1);
    });
  });

  it("uses the persisted retryCount for the first backoff tier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "retry me",
        },
        tempDir,
      );
      await failSessionDelivery(id, "transient failure", tempDir);

      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      if (!failedEntry) {
        throw new Error("expected failed session delivery to remain pending");
      }
      expect(failedEntry.retryCount).toBe(1);

      const lastAttemptAt = failedEntry.lastAttemptAt;
      if (typeof lastAttemptAt !== "number") {
        throw new Error("expected failed delivery attempt timestamp");
      }
      const notReady = isSessionDeliveryEligibleForRetry(failedEntry, lastAttemptAt + 4_999);
      expect(notReady).toEqual({ eligible: false, remainingBackoffMs: 1 });

      const ready = isSessionDeliveryEligibleForRetry(failedEntry, lastAttemptAt + 5_000);
      expect(ready).toEqual({ eligible: true });
    });

    vi.useRealTimers();
  });
});
