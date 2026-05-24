import { describe, expect, it } from "vitest";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";
import type { SessionEntry } from "./types.js";

describe("resolveResetPreservedSelection", () => {
  it("preserves explicit default model selections across resets", () => {
    const entry: SessionEntry = {
      sessionId: "session-explicit-default",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    };

    expect(resolveResetPreservedSelection({ entry })).toEqual({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
  });

  it("preserves user-selected model overrides across resets", () => {
    const entry: SessionEntry = {
      sessionId: "session-user-model",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    };

    expect(resolveResetPreservedSelection({ entry })).toEqual({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
  });

  it("does not preserve source-only user markers as model pins", () => {
    const entry: SessionEntry = {
      sessionId: "session-source-only-marker",
      updatedAt: 1,
      modelOverrideSource: "user",
    };

    expect(resolveResetPreservedSelection({ entry })).toEqual({});
  });

  it("does not preserve auto fallback selections across resets", () => {
    const entry: SessionEntry = {
      sessionId: "session-auto-model",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
    };

    expect(resolveResetPreservedSelection({ entry })).toEqual({});
  });
});
