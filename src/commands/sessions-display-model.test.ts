import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionDisplayModelRef } from "./sessions-display-model.js";

type SessionDisplayModelRow = Parameters<typeof resolveSessionDisplayModelRef>[1];

function rowWith(
  fields: Partial<
    Pick<SessionDisplayModelRow, "model" | "modelProvider" | "modelOverride" | "providerOverride">
  > = {},
): SessionDisplayModelRow {
  return {
    key: "agent:main",
    model: undefined,
    modelProvider: undefined,
    modelOverride: undefined,
    providerOverride: undefined,
    ...fields,
  };
}

describe("session display model resolution", () => {
  it("resolves a configured alias for sessions without a persisted model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "opus" },
          models: { "anthropic/claude-opus-5-5": { alias: "opus" } },
        },
      },
    };
    expect(resolveSessionDisplayModelRef(cfg, rowWith())).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("keeps an unaliased primary under the default provider", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "gpt-6-astra" } } },
    };
    expect(resolveSessionDisplayModelRef(cfg, rowWith())).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
    });
  });

  it("keeps a fully qualified primary unchanged", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } },
    };
    expect(resolveSessionDisplayModelRef(cfg, rowWith())).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("falls back to the default model when nothing is configured", () => {
    expect(resolveSessionDisplayModelRef({} as OpenClawConfig, rowWith())).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
    });
  });

  it("prefers the persisted runtime model over configured defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "opus" },
          models: { "anthropic/claude-opus-5-5": { alias: "opus" } },
        },
      },
    };
    expect(
      resolveSessionDisplayModelRef(cfg, rowWith({ modelProvider: "openai", model: "gpt-6-mini" })),
    ).toEqual({ provider: "openai", model: "gpt-6-mini" });
  });
});
