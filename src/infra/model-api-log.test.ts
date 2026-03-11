import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() factories are hoisted before variable declarations, so logInfoSpy
// must be hoisted too — otherwise the factory closes over an uninitialized binding.
const logInfoSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: logInfoSpy,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  charsToKbString,
  estimateTokens,
  logModelApiRequest,
  logModelApiResponse,
} from "./model-api-log.js";

// ── Shared fixture helpers ──────────────────────────────────────────────────

const baseRequest = {
  runId: "run-abc123",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  promptChars: 800,
  systemPromptChars: 400,
  historyMessages: 6,
  imagesCount: 0,
} as const;

const baseResponse = {
  runId: "run-abc123",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  durationMs: 1200,
  responseChars: 512,
  error: false,
} as const;

// ── charsToKbString ─────────────────────────────────────────────────────────

describe("charsToKbString", () => {
  it("converts 0 chars to '0.0 KB'", () => {
    expect(charsToKbString(0)).toBe("0.0 KB");
  });

  it("converts 1024 chars to '1.0 KB'", () => {
    expect(charsToKbString(1024)).toBe("1.0 KB");
  });

  it("converts 1536 chars to '1.5 KB'", () => {
    expect(charsToKbString(1536)).toBe("1.5 KB");
  });

  it("converts 512 chars to '0.5 KB'", () => {
    expect(charsToKbString(512)).toBe("0.5 KB");
  });

  it("rounds to 1 decimal place", () => {
    // 1025 chars = 1025/1024 ≈ 1.00097... → "1.0 KB"
    expect(charsToKbString(1025)).toBe("1.0 KB");
    // 1126 chars = 1126/1024 ≈ 1.099... → "1.1 KB"
    expect(charsToKbString(1126)).toBe("1.1 KB");
  });

  it("handles large values", () => {
    expect(charsToKbString(100 * 1024)).toBe("100.0 KB");
  });
});

// ── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for 0 chars", () => {
    expect(estimateTokens(0)).toBe(0);
  });

  it("returns 0 for negative chars (clamped)", () => {
    expect(estimateTokens(-10)).toBe(0);
  });

  it("estimates 4 chars as 1 token", () => {
    expect(estimateTokens(4)).toBe(1);
  });

  it("estimates 400 chars as ~100 tokens", () => {
    expect(estimateTokens(400)).toBe(100);
  });

  it("estimates 4096 chars as ~1024 tokens", () => {
    expect(estimateTokens(4096)).toBe(1024);
  });

  it("rounds to nearest integer", () => {
    // 6 chars / 4 = 1.5 → rounds to 2
    expect(estimateTokens(6)).toBe(2);
    // 5 chars / 4 = 1.25 → rounds to 1
    expect(estimateTokens(5)).toBe(1);
  });
});

// ── logModelApiRequest ──────────────────────────────────────────────────────

describe("logModelApiRequest", () => {
  beforeEach(() => {
    logInfoSpy.mockClear();
  });

  it("emits one INFO log line", () => {
    logModelApiRequest(baseRequest);
    expect(logInfoSpy).toHaveBeenCalledTimes(1);
  });

  it("log line begins with → request:", () => {
    logModelApiRequest(baseRequest);
    expect(logInfoSpy.mock.calls[0][0]).toMatch(/^→ request:/);
  });

  it("includes provider and model", () => {
    logModelApiRequest({ ...baseRequest, provider: "openai", model: "gpt-5.2" });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("provider=openai");
    expect(msg).toContain("model=gpt-5.2");
  });

  it("includes runId for log-stream correlation", () => {
    logModelApiRequest({ ...baseRequest, runId: "run-xyz789" });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("runId=run-xyz789");
  });

  it("sums prompt and system prompt chars for the size estimate", () => {
    // 1024 prompt + 1024 system = 2048 chars = 2.0 KB
    logModelApiRequest({ ...baseRequest, promptChars: 1024, systemPromptChars: 1024 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("2.0 KB");
    expect(msg).toContain("~512 tokens");
  });

  it("includes history message count", () => {
    logModelApiRequest({ ...baseRequest, historyMessages: 14 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("history=14msg");
  });

  it("includes images count when images > 0", () => {
    logModelApiRequest({ ...baseRequest, imagesCount: 3 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("images=3");
  });

  it("omits images suffix when imagesCount is 0", () => {
    logModelApiRequest({ ...baseRequest, imagesCount: 0 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).not.toContain("images=");
  });

  it("request and response share the same runId for pairing", () => {
    const runId = "run-pairing-test";
    logModelApiRequest({ ...baseRequest, runId });
    logModelApiResponse({ ...baseResponse, runId });
    const reqMsg = logInfoSpy.mock.calls[0][0] as string;
    const resMsg = logInfoSpy.mock.calls[1][0] as string;
    expect(reqMsg).toContain(`runId=${runId}`);
    expect(resMsg).toContain(`runId=${runId}`);
  });
});

// ── logModelApiResponse ─────────────────────────────────────────────────────

describe("logModelApiResponse", () => {
  beforeEach(() => {
    logInfoSpy.mockClear();
  });

  it("emits one INFO log line", () => {
    logModelApiResponse(baseResponse);
    expect(logInfoSpy).toHaveBeenCalledTimes(1);
  });

  it("log line begins with ← response:", () => {
    logModelApiResponse(baseResponse);
    expect(logInfoSpy.mock.calls[0][0]).toMatch(/^← response:/);
  });

  it("reports 'ok' outcome on success", () => {
    logModelApiResponse({ ...baseResponse, error: false });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("ok");
    expect(msg).not.toContain("error");
  });

  it("reports 'error' outcome on failure", () => {
    logModelApiResponse({ ...baseResponse, error: true, responseChars: 0 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("error");
    expect(msg).not.toContain("ok");
  });

  it("includes duration in milliseconds", () => {
    logModelApiResponse({ ...baseResponse, durationMs: 1337 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("1337ms");
  });

  it("includes response size in KB", () => {
    // 2048 chars = 2.0 KB
    logModelApiResponse({ ...baseResponse, responseChars: 2048 });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("2.0 KB");
  });

  it("includes provider and model", () => {
    logModelApiResponse({ ...baseResponse, provider: "minimax", model: "MiniMax-M2.5" });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("provider=minimax");
    expect(msg).toContain("model=MiniMax-M2.5");
  });

  it("includes runId for log-stream correlation", () => {
    logModelApiResponse({ ...baseResponse, runId: "run-xyz789" });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("runId=run-xyz789");
  });

  it("handles zero response chars (timeout before any text)", () => {
    logModelApiResponse({ ...baseResponse, durationMs: 30000, responseChars: 0, error: true });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    expect(msg).toContain("0.0 KB");
    expect(msg).toContain("error");
  });

  it("responseChars computed via reduce matches join-length equivalence", () => {
    // Verify the .reduce() approach used at the call site is equivalent to .join("").length
    const texts = ["Hello, ", "world", "!"];
    const viaReduce = texts.reduce((sum, t) => sum + t.length, 0);
    const viaJoin = texts.join("").length;
    expect(viaReduce).toBe(viaJoin); // 13

    logModelApiResponse({ ...baseResponse, responseChars: viaReduce });
    const msg = logInfoSpy.mock.calls[0][0] as string;
    // 13 chars = 0.0 KB (rounds to 1 decimal)
    expect(msg).toContain("0.0 KB");
  });
});
