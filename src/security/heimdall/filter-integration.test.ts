import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HeimdallConfig } from "./types.js";
import { applyOutputFilter } from "./apply-filter.js";
import { __resetAuditLogger } from "./audit.js";

// Mock subsystem logger
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("applyOutputFilter (batch)", () => {
  beforeEach(() => {
    __resetAuditLogger();
  });

  const config: HeimdallConfig = {
    enabled: true,
    outputFilter: { enabled: true },
    audit: { enabled: false },
  };

  it("redacts API key in reply text", () => {
    const payloads = [{ text: "Your key is sk-abc123defghijklmnopqrst" }];
    const result = applyOutputFilter(payloads, config);
    expect(result[0].text).toContain("[REDACTED:OpenAI API Key]");
    expect(result[0].text).not.toContain("sk-abc123");
  });

  it("clean reply passes unchanged", () => {
    const payloads = [{ text: "Hello, world!" }];
    const result = applyOutputFilter(payloads, config);
    expect(result[0].text).toBe("Hello, world!");
  });

  it("disabled → no redaction", () => {
    const disabled: HeimdallConfig = {
      enabled: true,
      outputFilter: { enabled: false },
    };
    const payloads = [{ text: "sk-abc123defghijklmnopqrst" }];
    const result = applyOutputFilter(payloads, disabled);
    expect(result[0].text).toBe("sk-abc123defghijklmnopqrst");
  });

  it("Heimdall disabled entirely → no redaction", () => {
    const disabled: HeimdallConfig = { enabled: false };
    const payloads = [{ text: "sk-abc123defghijklmnopqrst" }];
    const result = applyOutputFilter(payloads, disabled);
    expect(result[0].text).toBe("sk-abc123defghijklmnopqrst");
  });

  it("multiple replies each redacted", () => {
    const payloads = [
      { text: "Key: sk-abc123defghijklmnopqrst" },
      { text: "Pat: ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      { text: "Clean text" },
    ];
    const result = applyOutputFilter(payloads, config);
    expect(result[0].text).toContain("[REDACTED:OpenAI API Key]");
    expect(result[1].text).toContain("[REDACTED:GitHub PAT]");
    expect(result[2].text).toBe("Clean text");
  });

  it("non-text payloads (media-only) pass through", () => {
    const payloads = [
      { mediaUrl: "https://example.com/image.png" },
      { text: undefined, mediaUrls: ["https://example.com/a.png"] },
    ];
    const result = applyOutputFilter(payloads, config);
    expect(result).toEqual(payloads);
  });

  it("config undefined → no redaction", () => {
    const payloads = [{ text: "sk-abc123defghijklmnopqrst" }];
    const result = applyOutputFilter(payloads, undefined);
    expect(result[0].text).toBe("sk-abc123defghijklmnopqrst");
  });

  it("preserves other payload fields", () => {
    const payloads = [
      {
        text: "Key: sk-abc123defghijklmnopqrst",
        mediaUrl: "https://example.com/img.png",
        replyToId: "123",
      },
    ];
    const result = applyOutputFilter(payloads, config);
    expect(result[0].mediaUrl).toBe("https://example.com/img.png");
    expect(result[0].replyToId).toBe("123");
    expect(result[0].text).toContain("[REDACTED:");
  });
});
