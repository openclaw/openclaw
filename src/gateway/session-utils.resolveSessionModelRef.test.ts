import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionModelRef } from "./session-utils.js";

describe("resolveSessionModelRef", () => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
      },
    },
  } as unknown as OpenClawConfig;

  it("returns agent default when session has no model info", () => {
    const result = resolveSessionModelRef(cfg, { sessionId: "s1" } as unknown as SessionEntry);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });

  it("uses modelOverride when set by user", () => {
    const entry = {
      sessionId: "s1",
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    } as unknown as SessionEntry;
    const result = resolveSessionModelRef(cfg, entry);
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.provider).toBe("anthropic");
  });

  it("uses entry.model written by cron run when no modelOverride", () => {
    const entry = {
      sessionId: "s1",
      modelProvider: "google-gemini-cli",
      model: "gemini-3-pro-preview",
    } as unknown as SessionEntry;
    const result = resolveSessionModelRef(cfg, entry);
    expect(result.model).toBe("gemini-3-pro-preview");
    expect(result.provider).toBe("google-gemini-cli");
  });

  it("prefers modelOverride over entry.model", () => {
    const entry = {
      sessionId: "s1",
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
      modelProvider: "google-gemini-cli",
      model: "gemini-3-pro-preview",
    } as unknown as SessionEntry;
    const result = resolveSessionModelRef(cfg, entry);
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.provider).toBe("anthropic");
  });
});
