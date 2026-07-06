import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAutoSessionTitleCandidate } from "./auto-session-title.js";

describe("isAutoSessionTitleCandidate", () => {
  it("returns true for a new session with a non-command user message", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "How do I sort an array in Python?",
        isNewSession: true,
        entry: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when isNewSession is false", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "How do I sort an array in Python?",
        isNewSession: false,
        entry: undefined,
      }),
    ).toBe(false);
  });

  it("returns false for slash commands", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "/status",
        isNewSession: true,
        entry: undefined,
      }),
    ).toBe(false);
  });

  it("returns false for empty messages", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "   ",
        isNewSession: true,
        entry: undefined,
      }),
    ).toBe(false);
  });

  it("returns false when entry has a label", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "Hello",
        isNewSession: true,
        entry: { label: "My Custom Label" } as any,
      }),
    ).toBe(false);
  });

  it("returns false when entry has a displayName", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "Hello",
        isNewSession: true,
        entry: { displayName: "Custom Title" } as any,
      }),
    ).toBe(false);
  });

  it("returns false when entry has a subject", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "Hello",
        isNewSession: true,
        entry: { subject: "Custom Subject" } as any,
      }),
    ).toBe(false);
  });

  it("returns false when entry has an origin label", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "Hello",
        isNewSession: true,
        entry: { origin: { label: "Discord Thread" } } as any,
      }),
    ).toBe(false);
  });

  it("returns true when entry exists but has no explicit name fields", () => {
    expect(
      isAutoSessionTitleCandidate({
        sessionKey: "agent:main:webchat",
        userMessage: "What is TypeScript?",
        isNewSession: true,
        entry: { sessionId: "abc123" } as any,
      }),
    ).toBe(true);
  });
});
