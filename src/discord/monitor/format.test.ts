/**
 * format.test.ts
 *
 * [목적]
 * Discord 메시지 포맷팅 유틸리티 함수들의 동작을 검증한다.
 * - resolveDiscordSystemLocation: 메시지 출처 위치를 문자열로 변환
 * - formatDiscordReactionEmoji: 리액션 이모지를 표시 가능한 문자열로 변환
 * - formatDiscordUserTag: Discord 유저 태그(username#discriminator) 생성
 * - resolveTimestampMs: ISO 타임스탬프를 밀리초로 파싱
 *
 * [배경]
 * 에이전트 알림 시스템에서 Discord 이벤트를 사람이 읽을 수 있는 형태로 변환할 때 사용.
 * DM, Group DM, 길드 채널 등 다양한 메시지 출처를 올바르게 구분해야 한다.
 *
 * [upstream merge 시 주의]
 * - Discord의 사용자 이름 시스템 변경(discriminator 폐지 등) 시 formatDiscordUserTag 확인
 * - 새로운 메시지 출처 유형 추가 시 resolveDiscordSystemLocation 테스트 확인
 * - 커스텀 이모지 포맷이 변경되면 formatDiscordReactionEmoji 테스트 업데이트
 */
import { describe, expect, it } from "vitest";
import {
  formatDiscordReactionEmoji,
  formatDiscordUserTag,
  resolveDiscordSystemLocation,
  resolveTimestampMs,
} from "./format.js";

// ── 메시지 출처 위치 문자열 변환 ──
describe("resolveDiscordSystemLocation", () => {
  // DM은 단순히 "DM" 반환
  it("returns 'DM' for direct messages", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: true,
        isGroupDm: false,
        channelName: "irrelevant",
      }),
    ).toBe("DM");
  });

  // Group DM은 채널명과 함께 표시
  it("returns Group DM format for group DMs", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: false,
        isGroupDm: true,
        channelName: "my-group",
      }),
    ).toBe("Group DM #my-group");
  });

  // 길드 메시지는 "서버명 #채널명" 형식
  it("returns guild#channel format with guild name", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: false,
        isGroupDm: false,
        guild: { name: "Resona" } as never,
        channelName: "general",
      }),
    ).toBe("Resona #general");
  });

  // 길드 정보가 없으면 채널명만 표시
  it("returns #channel format without guild name", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: false,
        isGroupDm: false,
        channelName: "general",
      }),
    ).toBe("#general");
  });
});

// ── 리액션 이모지 포맷팅 ──
describe("formatDiscordReactionEmoji", () => {
  // 커스텀 이모지: ID와 이름 모두 있는 경우 → Discord 포맷
  it("formats custom emoji with id and name", () => {
    expect(formatDiscordReactionEmoji({ id: "123", name: "fire" })).toBe("<:fire:123>");
  });

  // 커스텀 이모지: ID만 있고 이름 없는 경우
  it("formats custom emoji with only id", () => {
    expect(formatDiscordReactionEmoji({ id: "123", name: null })).toBe("emoji:123");
  });

  // 유니코드 이모지: 이름만 있는 경우 (ID 없음)
  it("returns unicode emoji name", () => {
    expect(formatDiscordReactionEmoji({ name: "🔥" })).toBe("🔥");
  });

  // 빈 이모지 객체 — 폴백
  it("returns fallback for empty emoji", () => {
    expect(formatDiscordReactionEmoji({})).toBe("emoji");
  });
});

// ── Discord 유저 태그 생성 ──
describe("formatDiscordUserTag", () => {
  // 구 시스템: username#1234 형식
  it("formats user with discriminator", () => {
    const user = { username: "testuser", discriminator: "1234", id: "111" } as never;
    expect(formatDiscordUserTag(user)).toBe("testuser#1234");
  });

  // 신 시스템: discriminator "0"은 무시 (2023년 이후 Discord 유저네임 변경)
  it("returns username when discriminator is 0 (new Discord format)", () => {
    const user = { username: "testuser", discriminator: "0", id: "111" } as never;
    expect(formatDiscordUserTag(user)).toBe("testuser");
  });

  // discriminator 필드 자체가 없는 경우
  it("returns username when discriminator is missing", () => {
    const user = { username: "testuser", id: "111" } as never;
    expect(formatDiscordUserTag(user)).toBe("testuser");
  });

  // username이 없는 엣지 케이스 — ID로 폴백
  it("falls back to user id when username is missing", () => {
    const user = { id: "111", discriminator: "0" } as never;
    expect(formatDiscordUserTag(user)).toBe("111");
  });
});

// ── 타임스탬프 파싱 ──
describe("resolveTimestampMs", () => {
  it("parses valid ISO timestamp", () => {
    const ts = "2026-03-01T12:00:00.000Z";
    expect(resolveTimestampMs(ts)).toBe(Date.parse(ts));
  });

  // null, 빈 문자열, 잘못된 형식은 모두 undefined 반환
  it("returns undefined for null", () => {
    expect(resolveTimestampMs(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveTimestampMs("")).toBeUndefined();
  });

  it("returns undefined for invalid date string", () => {
    expect(resolveTimestampMs("not-a-date")).toBeUndefined();
  });
});
