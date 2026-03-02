/**
 * sibling-bots.test.ts
 *
 * [목적]
 * 형제 봇 레지스트리(Sibling Bot Registry)의 동작을 검증한다.
 * 같은 배포 환경에 있는 여러 에이전트 봇의 Discord user ID를 추적하고,
 * bot user ID ↔ agent ID 간 양방향 매핑을 관리한다.
 *
 * [배경]
 * 멀티 에이전트 환경에서 봇끼리의 메시지를 "봇 메시지 무시" 필터에서 제외하고,
 * A2A(agent-to-agent) 통신 시 발신자 에이전트를 식별하는 데 사용된다.
 * - registerSiblingBot: 봇 등록 (정방향 + 역방향 매핑)
 * - getAgentIdForBot: bot user ID → agent ID (정방향 조회)
 * - getBotUserIdForAgent: agent ID → bot user ID (역방향 조회)
 * - resolveAgentBotUserId: 2단계 조회 (역방향 → config binding 폴백)
 *
 * [upstream merge 시 주의]
 * - globalThis 키가 변경되면 테스트 간 상태 격리에 영향 가능
 * - resolveAgentBotUserId의 config binding 구조가 변경되면 폴백 테스트 업데이트 필요
 * - 새로운 매핑 방향이 추가되면 해당 테스트 추가 필요
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerSiblingBot,
  unregisterSiblingBot,
  isSiblingBot,
  listSiblingBots,
  clearSiblingBots,
  getAgentIdForBot,
  getBotUserIdForAgent,
  resolveAgentBotUserId,
} from "./sibling-bots.js";

describe("sibling-bots", () => {
  beforeEach(() => {
    clearSiblingBots();
  });

  // ── 기본 등록/해제 ──

  it("registers and recognises a sibling bot", () => {
    registerSiblingBot("111");
    expect(isSiblingBot("111")).toBe(true);
    expect(isSiblingBot("222")).toBe(false);
  });

  it("unregisters a sibling bot", () => {
    registerSiblingBot("111");
    unregisterSiblingBot("111");
    expect(isSiblingBot("111")).toBe(false);
  });

  it("lists all registered siblings", () => {
    registerSiblingBot("a");
    registerSiblingBot("b");
    expect(listSiblingBots().toSorted()).toEqual(["a", "b"]);
  });

  // 빈 문자열은 무시되어야 함 — Discord에서 빈 ID가 넘어오는 엣지 케이스 방지
  it("ignores empty strings", () => {
    registerSiblingBot("");
    expect(listSiblingBots()).toEqual([]);
  });

  it("clearSiblingBots resets state", () => {
    registerSiblingBot("x");
    clearSiblingBots();
    expect(isSiblingBot("x")).toBe(false);
    expect(listSiblingBots()).toEqual([]);
  });

  // ── 정방향 조회: bot user ID → agent ID ──

  describe("getAgentIdForBot", () => {
    it("returns agentId when registered with one", () => {
      registerSiblingBot("bot-111", "eden");
      expect(getAgentIdForBot("bot-111")).toBe("eden");
    });

    // agentId 없이 등록된 봇은 undefined 반환 — 레거시 호환용
    it("returns undefined when registered without agentId", () => {
      registerSiblingBot("bot-222");
      expect(getAgentIdForBot("bot-222")).toBeUndefined();
    });

    it("returns undefined for unknown bot", () => {
      expect(getAgentIdForBot("unknown")).toBeUndefined();
    });

    // 여러 봇이 각각 다른 에이전트에 매핑되는 실제 배포 시나리오
    it("maps multiple bots to different agents", () => {
      registerSiblingBot("bot-a", "eden");
      registerSiblingBot("bot-b", "seum");
      registerSiblingBot("bot-c", "ruda");
      expect(getAgentIdForBot("bot-a")).toBe("eden");
      expect(getAgentIdForBot("bot-b")).toBe("seum");
      expect(getAgentIdForBot("bot-c")).toBe("ruda");
    });

    // 해제 시 매핑도 함께 제거되어야 함
    it("clears agentId mapping on unregister", () => {
      registerSiblingBot("bot-x", "miri");
      unregisterSiblingBot("bot-x");
      expect(getAgentIdForBot("bot-x")).toBeUndefined();
    });

    it("clears agentId mapping on clearSiblingBots", () => {
      registerSiblingBot("bot-y", "yunseul");
      clearSiblingBots();
      expect(getAgentIdForBot("bot-y")).toBeUndefined();
    });
  });

  // ── 역방향 조회: agent ID → bot user ID ──

  describe("getBotUserIdForAgent", () => {
    // agent ID로 봇 user ID를 조회 — A2A 메시지 전송 시 사용
    it("returns bot user ID for a registered agent", () => {
      registerSiblingBot("bot-111", "eden");
      expect(getBotUserIdForAgent("eden")).toBe("bot-111");
    });

    // agentId 없이 등록된 봇은 역방향 매핑이 없음
    it("returns undefined when bot registered without agentId", () => {
      registerSiblingBot("bot-222");
      expect(getBotUserIdForAgent("bot-222")).toBeUndefined();
    });

    it("returns undefined for unknown agent", () => {
      expect(getBotUserIdForAgent("nonexistent")).toBeUndefined();
    });

    // 여러 에이전트의 역방향 조회가 독립적으로 동작하는지 검증
    it("maps multiple agents to their respective bots", () => {
      registerSiblingBot("bot-a", "eden");
      registerSiblingBot("bot-b", "seum");
      expect(getBotUserIdForAgent("eden")).toBe("bot-a");
      expect(getBotUserIdForAgent("seum")).toBe("bot-b");
    });

    // 해제 시 역방향 매핑도 함께 제거
    it("clears reverse mapping on unregister", () => {
      registerSiblingBot("bot-x", "miri");
      unregisterSiblingBot("bot-x");
      expect(getBotUserIdForAgent("miri")).toBeUndefined();
    });

    // clearSiblingBots는 정방향+역방향 모두 초기화
    it("clears reverse mapping on clearSiblingBots", () => {
      registerSiblingBot("bot-y", "yunseul");
      clearSiblingBots();
      expect(getBotUserIdForAgent("yunseul")).toBeUndefined();
    });
  });

  // ── 2단계 조회: resolveAgentBotUserId ──

  describe("resolveAgentBotUserId", () => {
    // Stage 1: 역방향 맵에서 직접 조회
    it("resolves via direct reverse lookup (stage 1)", () => {
      registerSiblingBot("bot-111", "eden");
      expect(resolveAgentBotUserId("eden")).toBe("bot-111");
    });

    // Stage 2: config binding 폴백 — agentId로 직접 못 찾으면
    // config.bindings에서 agentId → accountId를 찾고,
    // accountId로 역방향 조회를 재시도
    it("resolves via config binding fallback (stage 2)", () => {
      // accountId "acc-eden"이 봇으로 등록되어 있지만 agentId 매핑은 없음
      registerSiblingBot("bot-eden", "acc-eden");
      const cfg = {
        bindings: [{ accountId: "acc-eden", agentId: "eden" }],
      };
      // "eden"으로 직접 조회 실패 → binding에서 acc-eden 찾음 → bot-eden 반환
      expect(resolveAgentBotUserId("eden", cfg)).toBe("bot-eden");
    });

    it("returns undefined when no match in either stage", () => {
      expect(resolveAgentBotUserId("ghost")).toBeUndefined();
    });

    // config binding이 있지만 해당 accountId가 등록되지 않은 경우
    it("returns undefined when binding exists but accountId not registered", () => {
      const cfg = {
        bindings: [{ accountId: "acc-unknown", agentId: "eden" }],
      };
      expect(resolveAgentBotUserId("eden", cfg)).toBeUndefined();
    });

    // Stage 1이 성공하면 Stage 2는 시도하지 않음 (성능 최적화)
    it("prefers direct lookup over config binding", () => {
      registerSiblingBot("bot-direct", "eden");
      registerSiblingBot("bot-fallback", "acc-eden");
      const cfg = {
        bindings: [{ accountId: "acc-eden", agentId: "eden" }],
      };
      // Stage 1에서 "eden" → "bot-direct" 반환, Stage 2는 무시
      expect(resolveAgentBotUserId("eden", cfg)).toBe("bot-direct");
    });

    // 여러 binding 중 일치하는 것만 사용
    it("finds correct binding among multiple entries", () => {
      registerSiblingBot("bot-s", "acc-seum");
      const cfg = {
        bindings: [
          { accountId: "acc-eden", agentId: "eden" },
          { accountId: "acc-seum", agentId: "seum" },
          { accountId: "acc-ruda", agentId: "ruda" },
        ],
      };
      expect(resolveAgentBotUserId("seum", cfg)).toBe("bot-s");
      expect(resolveAgentBotUserId("ruda", cfg)).toBeUndefined(); // acc-ruda 미등록
    });
  });
});
