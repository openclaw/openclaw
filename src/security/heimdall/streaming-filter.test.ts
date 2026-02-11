import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HeimdallConfig } from "./types.js";
import { __resetAuditLogger } from "./audit.js";
import { wrapBlockReplyWithFilter } from "./streaming-filter.js";

// Mock subsystem logger
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("wrapBlockReplyWithFilter (streaming)", () => {
  beforeEach(() => {
    __resetAuditLogger();
  });

  const config: HeimdallConfig = {
    enabled: true,
    outputFilter: { enabled: true },
    audit: { enabled: false },
  };

  it("redacts secret in streaming payload", async () => {
    const received: Array<{ text?: string }> = [];
    const original = async (payload: { text?: string }) => {
      received.push(payload);
    };
    const wrapped = wrapBlockReplyWithFilter(original, config);
    await wrapped({ text: "Your key: sk-abc123defghijklmnopqrst" });
    expect(received).toHaveLength(1);
    expect(received[0].text).toContain("[REDACTED:OpenAI API Key]");
    expect(received[0].text).not.toContain("sk-abc123");
  });

  it("clean payload passes unchanged", async () => {
    const received: Array<{ text?: string }> = [];
    const original = async (payload: { text?: string }) => {
      received.push(payload);
    };
    const wrapped = wrapBlockReplyWithFilter(original, config);
    await wrapped({ text: "Hello world" });
    expect(received[0].text).toBe("Hello world");
  });

  it("non-text payload passes through", async () => {
    const received: Array<{ text?: string; mediaUrl?: string }> = [];
    const original = async (payload: { text?: string; mediaUrl?: string }) => {
      received.push(payload);
    };
    const wrapped = wrapBlockReplyWithFilter(original, config);
    await wrapped({ mediaUrl: "https://example.com/img.png" });
    expect(received[0].mediaUrl).toBe("https://example.com/img.png");
    expect(received[0].text).toBeUndefined();
  });

  it("disabled config → passthrough", async () => {
    const received: Array<{ text?: string }> = [];
    const original = async (payload: { text?: string }) => {
      received.push(payload);
    };
    const disabled: HeimdallConfig = { enabled: false };
    const wrapped = wrapBlockReplyWithFilter(original, disabled);
    // Should be the same function
    expect(wrapped).toBe(original);
  });

  it("output filter disabled → passthrough", async () => {
    const original = vi.fn();
    const cfg: HeimdallConfig = {
      enabled: true,
      outputFilter: { enabled: false },
    };
    const wrapped = wrapBlockReplyWithFilter(original, cfg);
    expect(wrapped).toBe(original);
  });

  it("preserves context argument", async () => {
    const received: Array<{ payload: { text?: string }; context?: string }> = [];
    const original = async (payload: { text?: string }, context?: string) => {
      received.push({ payload, context });
    };
    const wrapped = wrapBlockReplyWithFilter(original, config);
    await wrapped({ text: "clean" }, "ctx-value");
    expect(received).toHaveLength(1);
    expect(received[0].context).toBe("ctx-value");
  });
});
