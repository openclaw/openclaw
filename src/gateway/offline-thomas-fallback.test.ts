import { describe, expect, it } from "vitest";
import {
  buildOfflineThomasFallbackReply,
  shouldUseOfflineThomasFallback,
} from "./offline-thomas-fallback.js";

describe("offline Thomas fallback", () => {
  it("recognizes provider quota and billing messages as fallback candidates", () => {
    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "hello",
        assistantTexts: [
          "API provider returned a billing error - your API key has run out of credits.",
        ],
      }),
    ).toBe(true);

    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "hello",
        assistantTexts: ["You exceeded your current quota, please check your plan and billing."],
      }),
    ).toBe(true);
  });

  it("does not replace normal assistant text or slash command replies", () => {
    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "hello",
        assistantTexts: ["Hello right back."],
      }),
    ).toBe(false);

    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "/context list",
        assistantTexts: ["API provider returned a billing error."],
      }),
    ).toBe(false);
  });

  it("builds a transparent, conversational local reply", () => {
    const reply = buildOfflineThomasFallbackReply({
      userMessage: "What can you do for me?",
      reason: "billing",
    });

    expect(reply).toContain("free local Thomas mode");
    expect(reply).toContain("cloud model");
    expect(reply).toContain("What can you do for me?");
    expect(reply).toMatch(/talk|plan|draft|organize/i);
  });

  it("is honest when the user asks it to perform external work", () => {
    const reply = buildOfflineThomasFallbackReply({
      userMessage: "Search the web and update my project files",
      reason: "auth",
    });

    expect(reply).toContain("can't browse");
    expect(reply).toContain("can't change files");
    expect(reply).toContain("local");
  });
});
