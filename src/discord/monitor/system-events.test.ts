/**
 * system-events.test.ts
 *
 * [목적]
 * resolveDiscordSystemEvent()의 동작을 검증한다.
 * Discord 시스템 메시지(핀, 가입, 부스트, 스레드 생성 등)를 사람이 읽을 수 있는
 * 이벤트 문자열로 변환하는 함수이다.
 *
 * [배경]
 * 에이전트가 시스템 메시지를 수신했을 때, 일반 메시지와 구분하여 컨텍스트를 제공한다.
 * 일반 메시지(Default, Reply)는 null을 반환하여 별도 처리 없이 통과시킨다.
 *
 * [upstream merge 시 주의]
 * - @buape/carbon의 MessageType enum 값이 변경되면 테스트 업데이트 필요
 * - 새로운 시스템 이벤트 타입이 추가되면 해당 테스트 케이스 추가 필요
 * - author 필드 접근 방식이 변경되면 graceful handling 테스트 확인 필요
 */
import { MessageType } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { resolveDiscordSystemEvent } from "./system-events.js";

// 최소한의 Message 목 생성 헬퍼
function makeMessage(type: MessageType, author?: { username: string; id: string }) {
  return {
    type,
    author: author ?? { username: "testuser", id: "111", discriminator: "0" },
  } as never;
}

describe("resolveDiscordSystemEvent", () => {
  const LOCATION = "TestGuild #general";

  // ── 시스템 이벤트 감지 ──

  it("detects pinned message", () => {
    const result = resolveDiscordSystemEvent(
      makeMessage(MessageType.ChannelPinnedMessage),
      LOCATION,
    );
    expect(result).toContain("pinned a message");
    expect(result).toContain("testuser");
    expect(result).toContain(LOCATION);
  });

  it("detects user join", () => {
    const result = resolveDiscordSystemEvent(makeMessage(MessageType.UserJoin), LOCATION);
    expect(result).toContain("user joined");
  });

  it("detects server boost", () => {
    const result = resolveDiscordSystemEvent(makeMessage(MessageType.GuildBoost), LOCATION);
    expect(result).toContain("boosted the server");
  });

  it("detects thread creation", () => {
    const result = resolveDiscordSystemEvent(makeMessage(MessageType.ThreadCreated), LOCATION);
    expect(result).toContain("created a thread");
  });

  it("detects auto moderation action", () => {
    const result = resolveDiscordSystemEvent(
      makeMessage(MessageType.AutoModerationAction),
      LOCATION,
    );
    expect(result).toContain("auto moderation action");
  });

  it("detects poll results", () => {
    const result = resolveDiscordSystemEvent(makeMessage(MessageType.PollResult), LOCATION);
    expect(result).toContain("poll results posted");
  });

  // ── 일반 메시지는 null 반환 (시스템 이벤트가 아님) ──

  it("returns null for regular messages", () => {
    const result = resolveDiscordSystemEvent(makeMessage(MessageType.Default), LOCATION);
    expect(result).toBeNull();
  });

  it("returns null for reply messages", () => {
    const result = resolveDiscordSystemEvent(makeMessage(MessageType.Reply), LOCATION);
    expect(result).toBeNull();
  });

  // ── 이벤트 문자열에 작성자 정보 포함 ──

  it("includes author in the event string", () => {
    const result = resolveDiscordSystemEvent(
      makeMessage(MessageType.GuildBoostTier1, { username: "병욱", id: "999" }),
      LOCATION,
    );
    expect(result).toContain("병욱");
    expect(result).toContain("Tier 1");
  });

  // author가 null인 엣지 케이스 — 일부 시스템 메시지에서 발생 가능
  it("handles message without author gracefully", () => {
    const msg = { type: MessageType.UserJoin, author: null } as never;
    const result = resolveDiscordSystemEvent(msg, LOCATION);
    expect(result).toContain("user joined");
    expect(result).toContain(LOCATION);
  });
});
