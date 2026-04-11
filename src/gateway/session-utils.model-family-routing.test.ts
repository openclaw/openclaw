import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionModelRef } from "./session-utils.js";

describe("resolveSessionModelRef model-family routing", () => {
  test("infers provider from configured models when override model is canonical and provider is default/fallback", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          model: "openai/gpt-4.1",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const resolved = resolveSessionModelRef(
      cfg,
      {
        modelOverride: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
  });

  test("does not override an explicit providerOverride when model family routing is ambiguous or user-selected", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          model: "openai/gpt-4.1",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const resolved = resolveSessionModelRef(
      cfg,
      {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  test("keeps provider/model encoded refs untouched", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          model: "openai/gpt-4.1",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const resolved = resolveSessionModelRef(
      cfg,
      {
        modelOverride: "anthropic/claude-opus-4-1",
      },
      "main",
    );

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-1",
    });
  });
});
