import { describe, expect, it } from "vitest";
import { parseReplyDirectives } from "./reply-directives.js";

describe("parseReplyDirectives", () => {
  it("extracts media directives for final reply text", () => {
    expect(parseReplyDirectives("Here\nMEDIA:https://example.com/a.png")).toMatchObject({
      text: "Here",
      mediaUrl: "https://example.com/a.png",
      mediaUrls: ["https://example.com/a.png"],
    });
  });

  it("can strip raw media directives without returning sendable media", () => {
    expect(
      parseReplyDirectives("Tool output\nMEDIA:/tmp/secret.png", {
        mediaDirectives: "strip",
      }),
    ).toMatchObject({
      text: "Tool output",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("can leave media-looking diagnostic text inert", () => {
    expect(
      parseReplyDirectives("Diagnostic MEDIA:/tmp/secret.png", {
        mediaDirectives: "ignore",
      }),
    ).toMatchObject({
      text: "Diagnostic MEDIA:/tmp/secret.png",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });
});
