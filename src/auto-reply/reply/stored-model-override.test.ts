import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SessionEntry;
}

describe("resolveStoredModelOverride", () => {
  it("returns user-initiated model override", () => {
    const entry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus",
      modelOverrideSource: "user",
    });
    const result = resolveStoredModelOverride({
      sessionEntry: entry,
      defaultProvider: "anthropic",
    });
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-opus",
      source: "session",
    });
  });

  it("skips auto-fallback model override so it does not persist across turns", () => {
    const entry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-haiku",
      modelOverrideSource: "auto",
    });
    const result = resolveStoredModelOverride({
      sessionEntry: entry,
      defaultProvider: "anthropic",
    });
    expect(result).toBeNull();
  });

  it("skips auto-fallback from parent session", () => {
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-haiku",
      modelOverrideSource: "auto",
    });
    const result = resolveStoredModelOverride({
      sessionEntry: makeEntry(),
      sessionStore: { parent: parentEntry },
      sessionKey: "child",
      parentSessionKey: "parent",
      defaultProvider: "anthropic",
    });
    expect(result).toBeNull();
  });

  it("returns parent session user override", () => {
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus",
      modelOverrideSource: "user",
    });
    const result = resolveStoredModelOverride({
      sessionEntry: makeEntry(),
      sessionStore: { parent: parentEntry },
      sessionKey: "child",
      parentSessionKey: "parent",
      defaultProvider: "anthropic",
    });
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-opus",
      source: "parent",
    });
  });

  it("returns override when modelOverrideSource is undefined (legacy)", () => {
    const entry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus",
    });
    const result = resolveStoredModelOverride({
      sessionEntry: entry,
      defaultProvider: "anthropic",
    });
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-opus",
      source: "session",
    });
  });

  it("returns null when no override is set", () => {
    const result = resolveStoredModelOverride({
      sessionEntry: makeEntry(),
      defaultProvider: "anthropic",
    });
    expect(result).toBeNull();
  });
});
