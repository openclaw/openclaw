/**
 * allow-list.test.ts
 *
 * [목적]
 * Discord 접근 제어(Allow List) 시스템의 동작을 검증한다.
 * 어떤 사용자, 역할, 채널, 길드가 봇과 상호작용할 수 있는지 결정하는 핵심 보안 모듈.
 *
 * [배경]
 * openclaw.json의 discord.guilds, discord.users, discord.roles 등의 설정으로
 * 봇의 접근 범위를 제한한다. 잘못된 동작은 다음 문제를 야기할 수 있다:
 * - 허용되지 않은 사용자/길드에서 봇이 응답 (보안 위험)
 * - 허용된 사용자/길드에서 봇이 응답하지 않음 (기능 장애)
 *
 * [테스트 범위]
 * - normalizeDiscordSlug: 문자열 정규화 (소문자, 특수문자, 한글 처리)
 * - normalizeDiscordAllowList: 원시 설정을 구조화된 AllowList로 변환
 * - allowListMatches: AllowList와 후보를 매칭
 * - resolveDiscordAllowListMatch: 매칭 소스(wildcard/id/name)를 반환
 * - resolveDiscordUserAllowed: 사용자 허용 여부
 * - resolveDiscordRoleAllowed: 역할 기반 허용 여부
 * - resolveDiscordMemberAllowed: 사용자+역할 복합 허용 여부
 * - isDiscordGroupAllowedByPolicy: 그룹 정책(disabled/open/allowlist) 적용
 * - resolveDiscordShouldRequireMention: 멘션 필수 여부
 * - resolveGroupDmAllow: Group DM 채널 허용 여부
 * - shouldEmitDiscordReactionNotification: 리액션 알림 발생 여부
 *
 * [upstream merge 시 주의]
 * - AllowList 구조체(allowAll, ids, names) 변경 시 거의 모든 테스트 수정 필요
 * - 그룹 정책 모드 추가 시 isDiscordGroupAllowedByPolicy 테스트 확인
 * - 멘션 로직(autoThread, channelConfig)이 변경되면 requireMention 테스트 수정
 * - normalizeDiscordSlug의 정규식이 변경되면 한글/특수문자 테스트 확인
 */
import { describe, expect, it } from "vitest";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordMemberAllowed,
  resolveDiscordRoleAllowed,
  resolveDiscordShouldRequireMention,
  resolveDiscordUserAllowed,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";

// ── 문자열 정규화 ──
describe("normalizeDiscordSlug", () => {
  it("lowercases and replaces special chars with hyphens", () => {
    expect(normalizeDiscordSlug("My Channel Name!")).toBe("my-channel-name");
  });

  // Discord 채널명 앞의 # 제거
  it("strips leading # from channel names", () => {
    expect(normalizeDiscordSlug("#general")).toBe("general");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeDiscordSlug("---test---")).toBe("test");
  });

  // 한글은 [a-z0-9] 범위 밖이므로 하이픈으로 치환된 후, 앞뒤 하이픈 trim으로 빈 문자열
  it("handles Korean characters", () => {
    expect(normalizeDiscordSlug("팀-채팅")).toBe("");
  });

  it("handles empty string", () => {
    expect(normalizeDiscordSlug("")).toBe("");
  });
});

// ── AllowList 파싱 ──
describe("normalizeDiscordAllowList", () => {
  const PREFIXES = ["discord:", "user:", "pk:"];

  // 빈 입력 → null (설정 없음 = 제한 없음으로 처리)
  it("returns null for empty array", () => {
    expect(normalizeDiscordAllowList([], PREFIXES)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeDiscordAllowList(undefined, PREFIXES)).toBeNull();
  });

  // 와일드카드 * → 모든 항목 허용
  it("detects wildcard", () => {
    const result = normalizeDiscordAllowList(["*"], PREFIXES);
    expect(result?.allowAll).toBe(true);
  });

  // 순수 숫자 문자열 → Discord ID로 인식
  it("extracts numeric IDs", () => {
    const result = normalizeDiscordAllowList(["123456789"], PREFIXES);
    expect(result?.ids.has("123456789")).toBe(true);
  });

  // Discord 멘션 포맷 <@!123456> → ID 추출
  it("extracts IDs from mention format", () => {
    const result = normalizeDiscordAllowList(["<@!123456>"], PREFIXES);
    expect(result?.ids.has("123456")).toBe(true);
  });

  // 접두사 포맷 discord:999, user:888 → ID 추출
  it("extracts IDs from prefixed entries", () => {
    const result = normalizeDiscordAllowList(["discord:999", "user:888"], PREFIXES);
    expect(result?.ids.has("999")).toBe(true);
    expect(result?.ids.has("888")).toBe(true);
  });

  // 숫자가 아닌 항목 → 이름으로 저장 (slug 정규화 적용)
  it("adds non-ID entries as names (slugified)", () => {
    const result = normalizeDiscordAllowList(["My Username"], PREFIXES);
    expect(result?.names.has("my-username")).toBe(true);
  });
});

// ── AllowList 매칭 ──
describe("allowListMatches", () => {
  // 와일드카드는 모든 후보와 매칭
  it("matches wildcard", () => {
    const list = { allowAll: true, ids: new Set<string>(), names: new Set<string>() };
    expect(allowListMatches(list, { id: "any" })).toBe(true);
  });

  // ID 매칭
  it("matches by ID", () => {
    const list = { allowAll: false, ids: new Set(["123"]), names: new Set<string>() };
    expect(allowListMatches(list, { id: "123" })).toBe(true);
    expect(allowListMatches(list, { id: "456" })).toBe(false);
  });

  // 이름 매칭은 명시적으로 allowNameMatching 옵션이 필요 (보안: 이름 위조 방지)
  it("does NOT match by name unless allowNameMatching is true", () => {
    const list = { allowAll: false, ids: new Set<string>(), names: new Set(["test-user"]) };
    expect(allowListMatches(list, { name: "Test User" })).toBe(false);
    expect(allowListMatches(list, { name: "Test User" }, { allowNameMatching: true })).toBe(true);
  });

  // tag (username#discriminator) 매칭도 allowNameMatching 필요
  it("matches by tag with allowNameMatching", () => {
    const list = { allowAll: false, ids: new Set<string>(), names: new Set(["user-1234"]) };
    expect(allowListMatches(list, { tag: "user#1234" }, { allowNameMatching: true })).toBe(true);
  });
});

// ── 매칭 소스 해석 ──
describe("resolveDiscordAllowListMatch", () => {
  // 와일드카드 매칭 시 matchSource: "wildcard" 반환
  it("returns wildcard match source", () => {
    const list = { allowAll: true, ids: new Set<string>(), names: new Set<string>() };
    const result = resolveDiscordAllowListMatch({ allowList: list, candidate: {} });
    expect(result).toEqual({ allowed: true, matchKey: "*", matchSource: "wildcard" });
  });

  // ID 매칭 시 matchSource: "id" 반환
  it("returns id match source", () => {
    const list = { allowAll: false, ids: new Set(["999"]), names: new Set<string>() };
    const result = resolveDiscordAllowListMatch({ allowList: list, candidate: { id: "999" } });
    expect(result).toEqual({ allowed: true, matchKey: "999", matchSource: "id" });
  });

  // 매칭 실패 시 allowed: false만 반환
  it("returns not allowed when no match", () => {
    const list = { allowAll: false, ids: new Set(["999"]), names: new Set<string>() };
    const result = resolveDiscordAllowListMatch({ allowList: list, candidate: { id: "111" } });
    expect(result).toEqual({ allowed: false });
  });
});

// ── 사용자 허용 여부 ──
describe("resolveDiscordUserAllowed", () => {
  // allowList가 없으면 모든 사용자 허용 (기본 동작)
  it("returns true when no allowList configured", () => {
    expect(resolveDiscordUserAllowed({ userId: "123" })).toBe(true);
  });

  // allowList가 있으면 목록에 있는 사용자만 허용
  it("checks user ID against allowList", () => {
    expect(resolveDiscordUserAllowed({ allowList: ["123"], userId: "123" })).toBe(true);
    expect(resolveDiscordUserAllowed({ allowList: ["123"], userId: "456" })).toBe(false);
  });
});

// ── 역할 기반 허용 여부 ──
describe("resolveDiscordRoleAllowed", () => {
  it("returns true when no allowList configured", () => {
    expect(resolveDiscordRoleAllowed({ memberRoleIds: ["role1"] })).toBe(true);
  });

  // role: 접두사로 역할 ID 매칭
  it("checks role IDs against allowList", () => {
    expect(resolveDiscordRoleAllowed({ allowList: ["role:111"], memberRoleIds: ["111"] })).toBe(
      true,
    );
    expect(resolveDiscordRoleAllowed({ allowList: ["role:111"], memberRoleIds: ["222"] })).toBe(
      false,
    );
  });

  it("allows wildcard", () => {
    expect(resolveDiscordRoleAllowed({ allowList: ["*"], memberRoleIds: ["anything"] })).toBe(true);
  });
});

// ── 멤버 복합 허용 여부 (사용자 + 역할) ──
describe("resolveDiscordMemberAllowed", () => {
  // 제한 없으면 모든 멤버 허용
  it("returns true when no restrictions", () => {
    expect(resolveDiscordMemberAllowed({ memberRoleIds: [], userId: "123" })).toBe(true);
  });

  // 사용자 제한이 있을 때 해당 사용자 ID로 허용
  it("allows by user ID when user restriction exists", () => {
    expect(
      resolveDiscordMemberAllowed({
        userAllowList: ["123"],
        memberRoleIds: [],
        userId: "123",
      }),
    ).toBe(true);
  });

  // 역할 제한이 있을 때 해당 역할 ID로 허용
  it("allows by role ID when role restriction exists", () => {
    expect(
      resolveDiscordMemberAllowed({
        roleAllowList: ["role:555"],
        memberRoleIds: ["555"],
        userId: "123",
      }),
    ).toBe(true);
  });

  // 사용자와 역할 모두 불일치 → 차단
  it("blocks when neither user nor role matches", () => {
    expect(
      resolveDiscordMemberAllowed({
        userAllowList: ["999"],
        roleAllowList: ["role:888"],
        memberRoleIds: ["111"],
        userId: "123",
      }),
    ).toBe(false);
  });
});

// ── 그룹 정책 ──
describe("isDiscordGroupAllowedByPolicy", () => {
  // disabled: 모든 그룹 메시지 차단
  it("blocks all when policy is disabled", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "disabled",
        guildAllowlisted: true,
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  // open: 모든 그룹 메시지 허용
  it("allows all when policy is open", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "open",
        guildAllowlisted: false,
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  // allowlist 모드: 길드가 허용 목록에 없으면 차단
  it("blocks when guild not allowlisted in allowlist mode", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: false,
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(false);
  });

  // allowlist 모드: 길드 허용 + 채널 설정 없음 → 허용
  it("allows when guild allowlisted and no channel config", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: true,
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  // allowlist 모드: 길드 허용 + 채널 설정 있음 → 채널 허용 여부까지 확인
  it("respects channel allowlist when configured", () => {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: true,
        channelAllowlistConfigured: true,
        channelAllowed: false,
      }),
    ).toBe(false);

    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy: "allowlist",
        guildAllowlisted: true,
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(true);
  });
});

// ── 멘션 필수 여부 ──
describe("resolveDiscordShouldRequireMention", () => {
  // 비길드(DM) 메시지는 멘션 불필요
  it("returns false for non-guild messages", () => {
    expect(resolveDiscordShouldRequireMention({ isGuildMessage: false, isThread: false })).toBe(
      false,
    );
  });

  // 길드 메시지의 기본값은 멘션 필수
  it("defaults to true for guild messages without config", () => {
    expect(resolveDiscordShouldRequireMention({ isGuildMessage: true, isThread: false })).toBe(
      true,
    );
  });

  // 채널 설정에서 requireMention을 명시적으로 false로 지정
  it("respects channelConfig.requireMention", () => {
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: false,
        channelConfig: { allowed: true, requireMention: false },
      }),
    ).toBe(false);
  });

  // 길드 정보의 requireMention이 채널 설정 없을 때 폴백으로 사용됨
  it("respects guildInfo.requireMention as fallback", () => {
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: false,
        guildInfo: { requireMention: false },
      }),
    ).toBe(false);
  });

  // autoThread로 봇이 생성한 스레드에서는 멘션 불필요
  it("skips mention in bot-owned autoThread", () => {
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: true,
        botId: "bot-123",
        threadOwnerId: "bot-123",
        channelConfig: { allowed: true, autoThread: true },
      }),
    ).toBe(false);
  });
});

// ── Group DM 채널 허용 여부 ──
describe("resolveGroupDmAllow", () => {
  // 채널 설정 없으면 모든 Group DM 허용
  it("allows all when no channels configured", () => {
    expect(resolveGroupDmAllow({ channelId: "123", channelSlug: "test" })).toBe(true);
  });

  it("allows all with empty channels array", () => {
    expect(resolveGroupDmAllow({ channels: [], channelId: "123", channelSlug: "test" })).toBe(true);
  });

  // "*"는 normalizeDiscordSlug로 정규화되면 ""가 되어 와일드카드로 동작하지 않음
  // Group DM에서는 채널 ID나 slug로 매칭해야 함
  it("does not support wildcard (normalized away)", () => {
    expect(resolveGroupDmAllow({ channels: ["*"], channelId: "123", channelSlug: "test" })).toBe(
      false,
    );
  });

  // 채널 ID로 매칭
  it("matches by channel ID", () => {
    expect(resolveGroupDmAllow({ channels: ["123"], channelId: "123", channelSlug: "test" })).toBe(
      true,
    );
  });

  // 불일치 시 차단
  it("blocks unmatched channels", () => {
    expect(resolveGroupDmAllow({ channels: ["456"], channelId: "123", channelSlug: "test" })).toBe(
      false,
    );
  });
});

// ── 리액션 알림 발생 여부 ──
describe("shouldEmitDiscordReactionNotification", () => {
  // mode=off: 리액션 알림 비활성화
  it("returns false for mode=off", () => {
    expect(shouldEmitDiscordReactionNotification({ mode: "off", userId: "123" })).toBe(false);
  });

  // mode=all: 모든 리액션에 대해 알림
  it("returns true for mode=all", () => {
    expect(shouldEmitDiscordReactionNotification({ mode: "all", userId: "123" })).toBe(true);
  });

  // mode=own: 봇이 작성한 메시지에 대한 리액션만 알림
  it("returns true for mode=own when bot authored the message", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "own",
        botId: "bot-1",
        messageAuthorId: "bot-1",
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("returns false for mode=own when bot did not author the message", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        mode: "own",
        botId: "bot-1",
        messageAuthorId: "other",
        userId: "user-1",
      }),
    ).toBe(false);
  });

  // 기본값은 mode=own
  it("defaults to mode=own", () => {
    expect(
      shouldEmitDiscordReactionNotification({
        botId: "bot-1",
        messageAuthorId: "bot-1",
        userId: "user-1",
      }),
    ).toBe(true);
  });
});
