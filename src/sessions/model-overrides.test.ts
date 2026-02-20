import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

describe("applyModelOverrideToSessionEntry", () => {
  it("clears model and override state when default is selected", () => {
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 10,
      modelProvider: "openai",
      model: "gpt-4.1",
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      authProfileOverride: "p1",
      authProfileOverrideSource: "user",
      fallbackNoticeSelectedModel: "foo",
    };

    const { updated } = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        isDefault: true,
      },
    });

    expect(updated).toBe(true);
    expect(entry.modelProvider).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.fallbackNoticeSelectedModel).toBeUndefined();
  });

  it("sets override state when default is not selected", () => {
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 10,
    };

    const { updated } = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "openai",
        model: "gpt-4.1",
        isDefault: false,
      },
    });

    expect(updated).toBe(true);
    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-4.1");
  });
});
