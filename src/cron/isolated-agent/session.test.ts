import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

import { loadSessionStore, evaluateSessionFreshness } from "../../config/sessions.js";
import { resolveCronSession } from "./session.js";

describe("resolveCronSession", () => {
  it("preserves modelOverride and providerOverride from existing session entry", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:cron:test-job": {
        sessionId: "old-session-id",
        updatedAt: 1000,
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        thinkingLevel: "high",
        model: "k2p5",
      },
    });
    vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: true });

    const result = resolveCronSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:test-job",
      agentId: "main",
      nowMs: Date.now(),
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("k2p5");
  });

  it("handles missing modelOverride gracefully", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:cron:test-job": {
        sessionId: "old-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-5",
      },
    });
    vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: true });

    const result = resolveCronSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:test-job",
      agentId: "main",
      nowMs: Date.now(),
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const result = resolveCronSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:new-job",
      agentId: "main",
      nowMs: Date.now(),
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      vi.mocked(loadSessionStore).mockReturnValue({
        "webhook:stable-key": {
          sessionId: "existing-session-id-123",
          updatedAt: Date.now() - 1000,
          systemSent: true,
        },
      });
      vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: true });

      const result = resolveCronSession({
        cfg: {} as OpenClawConfig,
        sessionKey: "webhook:stable-key",
        agentId: "main",
        nowMs: Date.now(),
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
    });

    it("creates new sessionId when session is stale", () => {
      vi.mocked(loadSessionStore).mockReturnValue({
        "webhook:stable-key": {
          sessionId: "old-session-id",
          updatedAt: Date.now() - 86400000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
      });
      vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: false });

      const result = resolveCronSession({
        cfg: {} as OpenClawConfig,
        sessionKey: "webhook:stable-key",
        agentId: "main",
        nowMs: Date.now(),
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
    });

    it("creates new sessionId when forceNew is true", () => {
      vi.mocked(loadSessionStore).mockReturnValue({
        "webhook:stable-key": {
          sessionId: "existing-session-id-456",
          updatedAt: Date.now() - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
      });
      vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: true });

      const result = resolveCronSession({
        cfg: {} as OpenClawConfig,
        sessionKey: "webhook:stable-key",
        agentId: "main",
        nowMs: Date.now(),
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      vi.mocked(loadSessionStore).mockReturnValue({
        "webhook:stable-key": {
          updatedAt: Date.now() - 1000,
          modelOverride: "some-model",
        },
      } as unknown as ReturnType<typeof loadSessionStore>);
      vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: true });

      const result = resolveCronSession({
        cfg: {} as OpenClawConfig,
        sessionKey: "webhook:stable-key",
        agentId: "main",
        nowMs: Date.now(),
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });
  });
});
