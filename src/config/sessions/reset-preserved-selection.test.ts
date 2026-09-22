import { describe, expect, it } from "vitest";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";

describe("resolveResetPreservedSelection", () => {
  it("does not stamp legacy raw aliases as resolved during reset", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "sonnet",
          agentRuntimeOverride: "native-runtime",
        },
      }),
    ).toEqual({
      providerOverride: "anthropic",
      modelOverride: "sonnet",
      agentRuntimeOverride: "native-runtime",
      modelOverrideSource: "user",
    });
  });

  it("preserves canonical route provenance", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "canonical",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
          agentRuntimeOverride: "native-runtime",
        },
      }),
    ).toMatchObject({
      modelOverride: "claude-sonnet-4-6",
      modelOverrideRouteResolution: "resolved",
      agentRuntimeOverride: "native-runtime",
    });
  });

  it("preserves an explicit configured-default selection", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "explicit-default",
          updatedAt: 1,
          modelOverrideSource: "default",
        },
      }),
    ).toEqual({ modelOverrideSource: "default" });
  });

  it("preserves legacy user auth pins while dropping legacy automatic pins", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy-user",
          updatedAt: 1,
          authProfileOverride: "openai:work",
        },
      }),
    ).toEqual({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });

    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy-auto",
          providerOverride: "provider-a",
          modelOverride: "model",
          modelOverrideSource: "auto",
          agentRuntimeOverride: "native-runtime",
          updatedAt: 1,
          authProfileOverride: "openai:fallback",
          authProfileOverrideCompactionCount: 0,
        },
      }),
    ).toEqual({});
  });
});
