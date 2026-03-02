/**
 * thread-participants.test.ts
 *
 * [목적]
 * 스레드 참여자 레지스트리의 동작을 검증한다.
 * 멀티 에이전트 환경에서 특정 스레드에 어떤 봇이 참여하고 있는지 추적하는 모듈이다.
 *
 * [배경]
 * message-handler.preflight.ts의 thread guard가 이 레지스트리를 사용하여
 * "이 스레드에 이미 참여 중인 봇만 응답" 로직을 구현한다.
 * 레지스트리가 잘못 동작하면 봇이 관계없는 스레드에 침입하거나,
 * 참여해야 할 스레드에서 응답하지 않는 문제가 발생한다.
 *
 * [upstream merge 시 주의]
 * - 참여자 저장 구조(Map/Set)가 변경되면 중복 등록, 독립성 테스트 확인 필요
 * - TTL/만료 로직이 변경되면 cleanupExpiredThreads 테스트 업데이트 필요
 * - 디스크 영속화 로직은 이 테스트에서 다루지 않음 (인메모리만 검증)
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearThreadParticipants,
  cleanupExpiredThreads,
  getThreadParticipants,
  hasThreadParticipants,
  isThreadParticipant,
  registerThreadParticipant,
  registerThreadParticipants,
  touchThreadActivity,
} from "./thread-participants.js";

afterEach(() => {
  clearThreadParticipants();
});

describe("thread-participants", () => {
  const THREAD_A = "thread-aaa";
  const THREAD_B = "thread-bbb";
  const BOT_1 = "bot-111";
  const BOT_2 = "bot-222";
  const BOT_3 = "bot-333";

  // 기본 등록/조회 동작 검증
  describe("registerThreadParticipant", () => {
    it("registers a bot as participant in a thread", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(true);
    });

    it("does not duplicate participants on repeated registration", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1]);
    });

    it("registers multiple bots in the same thread", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_A, BOT_2);
      const participants = getThreadParticipants(THREAD_A);
      expect(participants).toContain(BOT_1);
      expect(participants).toContain(BOT_2);
      expect(participants).toHaveLength(2);
    });

    it("keeps threads independent", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_B, BOT_2);
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(true);
      expect(isThreadParticipant(THREAD_A, BOT_2)).toBe(false);
      expect(isThreadParticipant(THREAD_B, BOT_2)).toBe(true);
      expect(isThreadParticipant(THREAD_B, BOT_1)).toBe(false);
    });
  });

  // 일괄 등록 — 초기 로딩 시 사용
  describe("registerThreadParticipants (batch)", () => {
    it("registers multiple bots at once", () => {
      registerThreadParticipants(THREAD_A, [BOT_1, BOT_2, BOT_3]);
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1, BOT_2, BOT_3]);
    });
  });

  describe("isThreadParticipant", () => {
    it("returns false for unknown thread", () => {
      expect(isThreadParticipant("nonexistent", BOT_1)).toBe(false);
    });

    it("returns false for non-participant bot", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(isThreadParticipant(THREAD_A, BOT_2)).toBe(false);
    });
  });

  describe("hasThreadParticipants", () => {
    it("returns false for unknown thread", () => {
      expect(hasThreadParticipants("nonexistent")).toBe(false);
    });

    it("returns true when thread has participants", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(hasThreadParticipants(THREAD_A)).toBe(true);
    });
  });

  describe("getThreadParticipants", () => {
    it("returns empty array for unknown thread", () => {
      expect(getThreadParticipants("nonexistent")).toEqual([]);
    });

    // 내부 상태의 복사본을 반환해야 함 — 외부에서 배열을 수정해도 내부에 영향 없어야 함
    it("returns a copy (not a reference to internal state)", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      const list = getThreadParticipants(THREAD_A);
      list.push("injected");
      // Internal state should not be modified
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1]);
    });
  });

  describe("touchThreadActivity", () => {
    it("does not throw for unknown thread", () => {
      expect(() => touchThreadActivity("nonexistent")).not.toThrow();
    });

    it("updates activity without changing participants", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      touchThreadActivity(THREAD_A);
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1]);
    });
  });

  describe("clearThreadParticipants", () => {
    it("removes all threads", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_B, BOT_2);
      clearThreadParticipants();
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(false);
      expect(isThreadParticipant(THREAD_B, BOT_2)).toBe(false);
    });
  });

  // 만료된 스레드 정리 — 24시간 TTL 기반
  describe("cleanupExpiredThreads", () => {
    it("returns 0 when no threads are expired", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(cleanupExpiredThreads()).toBe(0);
      // Thread should still exist
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(true);
    });
  });
});
