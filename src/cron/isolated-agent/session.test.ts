import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

import { loadSessionStore } from "../../config/sessions.js";
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
  });

  it("always generates a new sessionId for cron keys", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:cron:test-job": {
        sessionId: "existing-session-id",
        updatedAt: 1000,
      },
    });

    const result = resolveCronSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:cron:test-job",
      agentId: "main",
      nowMs: Date.now(),
    });

    expect(result.sessionEntry.sessionId).not.toBe("existing-session-id");
    expect(result.isNewSession).toBe(true);
  });

  it("reuses existing sessionId for non-cron hook keys", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:hook:fizzy:card-461": {
        sessionId: "existing-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-5",
      },
    });

    const result = resolveCronSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:hook:fizzy:card-461",
      agentId: "main",
      nowMs: Date.now(),
    });

    expect(result.sessionEntry.sessionId).toBe("existing-session-id");
    expect(result.isNewSession).toBe(false);
  });

  it("generates new sessionId for non-cron keys with no existing entry", () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const result = resolveCronSession({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:hook:webhook:new-key",
      agentId: "main",
      nowMs: Date.now(),
    });

    expect(result.sessionEntry.sessionId).toBeDefined();
    expect(result.isNewSession).toBe(true);
  });
});
