import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent"),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent/.openclaw-agent"),
  resolveAgentEffectiveModelPrimary: vi.fn(() => null),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import { generateSlugViaLLM, slugifyLLMResponse } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "test-slug" }],
    });
  });

  it("keeps the helper default timeout when no agent timeout is configured", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {} as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 15_000,
      }),
    );
  });

  it("honors configured agent timeoutSeconds for slow local providers", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {
        agents: {
          defaults: {
            timeoutSeconds: 500,
          },
        },
      } as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 500_000,
      }),
    );
  });
});

describe("slugifyLLMResponse", () => {
  describe("happy path", () => {
    it("returns a clean slug for a normal short response", () => {
      expect(slugifyLLMResponse("vendor-pitch")).toBe("vendor-pitch");
      expect(slugifyLLMResponse("bug-fix")).toBe("bug-fix");
    });

    it("normalizes case and spaces", () => {
      expect(slugifyLLMResponse("API Design")).toBe("api-design");
      expect(slugifyLLMResponse("OAuth Flow")).toBe("oauth-flow");
    });

    it("collapses repeated separators", () => {
      expect(slugifyLLMResponse("api  /  design")).toBe("api-design");
    });

    it("accepts up to MAX_RESPONSE_WORDS words", () => {
      expect(slugifyLLMResponse("one two three four five")).toBe("one-two-three-four-five");
    });
  });

  describe("rejection cases", () => {
    it("returns null for empty or whitespace input", () => {
      expect(slugifyLLMResponse("")).toBeNull();
      expect(slugifyLLMResponse("   ")).toBeNull();
      expect(slugifyLLMResponse("\n\t  \t\n")).toBeNull();
    });

    it("returns null for multi-line responses", () => {
      expect(slugifyLLMResponse("hello\nworld")).toBeNull();
      expect(slugifyLLMResponse("api\ndesign")).toBeNull();
    });

    it("returns null when word count exceeds the threshold", () => {
      expect(slugifyLLMResponse("one two three four five six")).toBeNull();
    });

    it("returns null for very long single-word strings", () => {
      expect(slugifyLLMResponse("a".repeat(100))).toBeNull();
    });

    it("returns null when slugification produces no usable characters", () => {
      expect(slugifyLLMResponse("!!!")).toBeNull();
      expect(slugifyLLMResponse("---")).toBeNull();
    });
  });

  describe("regression: error responses must not become filenames", () => {
    // Reproduces the bug that produced a memory file named
    // `2026-04-10-missing-token-or-projectid-in-.md`. The embedded
    // agent returned the provider error message as payload text instead
    // of throwing, and the original slugify pipeline turned it into a
    // 30-character truncation that ended in a dangling dash.
    it("rejects a Google Cloud auth error response", () => {
      const errorText =
        "Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.";
      expect(slugifyLLMResponse(errorText)).toBeNull();
    });

    it("rejects a generic provider error sentence", () => {
      const errorText = "Request failed: rate limit exceeded, retry later.";
      expect(slugifyLLMResponse(errorText)).toBeNull();
    });

    it("rejects multi-sentence rambling responses", () => {
      const rambling = "Sure! Here is a slug for you: api-design. Hope that helps.";
      expect(slugifyLLMResponse(rambling)).toBeNull();
    });
  });

  describe("regression: trailing dash from truncation must be stripped", () => {
    // Before the fix, the pipeline stripped leading/trailing dashes
    // BEFORE truncating to MAX_SLUG_LENGTH. When truncation cut the
    // string at a separator boundary, the resulting slug ended with a
    // dangling dash that the date-prefixed filename template never
    // cleaned up. The fix moves the strip to after the slice.
    it("does not produce a slug ending in a dash", () => {
      // Five short words that slugify to >30 chars and put a dash at
      // index 30 of the slugified string.
      const result = slugifyLLMResponse("alpha beta gamma delta epsilon");
      expect(result).not.toBeNull();
      expect(result).not.toMatch(/-$/);
      expect(result).not.toMatch(/^-/);
    });

    it("respects the MAX_SLUG_LENGTH cap", () => {
      const result = slugifyLLMResponse("alpha beta gamma delta epsilon");
      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(30);
    });
  });
});
