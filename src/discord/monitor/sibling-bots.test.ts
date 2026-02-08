import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSiblingBots,
  isSiblingBot,
  registerSiblingBot,
  unregisterSiblingBot,
} from "./sibling-bots.js";

describe("sibling-bots", () => {
  beforeEach(() => {
    clearSiblingBots();
  });

  it("identifies a sibling bot from a different account", () => {
    registerSiblingBot("account-a", "bot-user-a");
    registerSiblingBot("account-b", "bot-user-b");
    expect(isSiblingBot("account-a", "bot-user-b")).toBe(true);
    expect(isSiblingBot("account-b", "bot-user-a")).toBe(true);
  });

  it("returns false for own bot user ID", () => {
    registerSiblingBot("account-a", "bot-user-a");
    expect(isSiblingBot("account-a", "bot-user-a")).toBe(false);
  });

  it("returns false for unknown user IDs", () => {
    registerSiblingBot("account-a", "bot-user-a");
    expect(isSiblingBot("account-a", "unknown-user")).toBe(false);
  });

  it("unregisters a sibling bot", () => {
    registerSiblingBot("account-a", "bot-user-a");
    registerSiblingBot("account-b", "bot-user-b");
    unregisterSiblingBot("account-b");
    expect(isSiblingBot("account-a", "bot-user-b")).toBe(false);
  });

  it("clears all sibling bots", () => {
    registerSiblingBot("account-a", "bot-user-a");
    registerSiblingBot("account-b", "bot-user-b");
    clearSiblingBots();
    expect(isSiblingBot("account-a", "bot-user-b")).toBe(false);
    expect(isSiblingBot("account-b", "bot-user-a")).toBe(false);
  });

  it("overwrites existing entry for same account", () => {
    registerSiblingBot("account-a", "bot-user-old");
    registerSiblingBot("account-a", "bot-user-new");
    registerSiblingBot("account-b", "bot-user-b");
    expect(isSiblingBot("account-b", "bot-user-old")).toBe(false);
    expect(isSiblingBot("account-b", "bot-user-new")).toBe(true);
  });

  it("returns false when registry is empty", () => {
    expect(isSiblingBot("account-a", "any-user")).toBe(false);
  });

  it("returns false with only one account registered", () => {
    registerSiblingBot("account-a", "bot-user-a");
    // Only one account -- no siblings exist
    expect(isSiblingBot("account-a", "bot-user-a")).toBe(false);
  });
});
