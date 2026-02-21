import { describe, expect, it, beforeEach } from "vitest";
import {
  registerInstanceBotUserId,
  unregisterInstanceBotUserId,
  isInstanceBotUserId,
  clearInstanceBotUserIds,
} from "./instance-bot-registry.js";

describe("instance-bot-registry", () => {
  beforeEach(() => {
    clearInstanceBotUserIds();
  });

  it("should register and detect instance bot user IDs", () => {
    registerInstanceBotUserId("bot-a");
    registerInstanceBotUserId("bot-b");

    expect(isInstanceBotUserId("bot-a")).toBe(true);
    expect(isInstanceBotUserId("bot-b")).toBe(true);
    expect(isInstanceBotUserId("external-bot")).toBe(false);
  });

  it("should exclude own bot ID from instance check", () => {
    registerInstanceBotUserId("bot-a");
    registerInstanceBotUserId("bot-b");

    // bot-a checking if bot-a is an "instance bot" should return false
    // (it's the caller's own bot, handled by self-message check)
    expect(isInstanceBotUserId("bot-a", "bot-a")).toBe(false);
    // bot-a checking if bot-b is an instance bot should return true
    expect(isInstanceBotUserId("bot-b", "bot-a")).toBe(true);
  });

  it("should unregister bot user IDs", () => {
    registerInstanceBotUserId("bot-a");
    expect(isInstanceBotUserId("bot-a")).toBe(true);

    unregisterInstanceBotUserId("bot-a");
    expect(isInstanceBotUserId("bot-a")).toBe(false);
  });

  it("should handle empty/falsy inputs gracefully", () => {
    expect(isInstanceBotUserId("")).toBe(false);
    expect(isInstanceBotUserId("", "bot-a")).toBe(false);
  });

  it("should clear all registrations", () => {
    registerInstanceBotUserId("bot-a");
    registerInstanceBotUserId("bot-b");
    clearInstanceBotUserIds();

    expect(isInstanceBotUserId("bot-a")).toBe(false);
    expect(isInstanceBotUserId("bot-b")).toBe(false);
  });
});
