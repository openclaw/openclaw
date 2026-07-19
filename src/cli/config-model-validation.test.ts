import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateTouchedTextModelRefs } from "./config-model-validation.js";

describe("config model validation", () => {
  it("rejects an unresolved default primary with an actionable error", async () => {
    const resolveModelRef = vi.fn(async () => "Unknown model: missing/nope");

    await expect(
      validateTouchedTextModelRefs({
        config: {
          agents: { defaults: { model: { primary: "missing/nope" } } },
        },
        touchedPaths: [["agents", "defaults", "model", "primary"]],
        resolveModelRef,
      }),
    ).rejects.toThrow(
      'Cannot set model reference "missing/nope" at agents.defaults.model.primary: Unknown model: missing/nope. Run openclaw models list to list available models.',
    );
  });

  it("accepts a resolved default primary", async () => {
    const resolveModelRef = vi.fn(async () => undefined);

    const refsChecked = await validateTouchedTextModelRefs({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
      },
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      resolveModelRef,
    });

    expect(resolveModelRef).toHaveBeenCalledOnce();
    expect(refsChecked).toBe(1);
  });

  it("rejects an unresolved default fallback", async () => {
    const resolveModelRef = vi.fn(async () => "Unknown model: missing/fallback");

    await expect(
      validateTouchedTextModelRefs({
        config: {
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.4-mini",
                fallbacks: ["missing/fallback"],
              },
            },
          },
        },
        touchedPaths: [["agents", "defaults", "model", "fallbacks", "0"]],
        resolveModelRef,
      }),
    ).rejects.toThrow(
      'Cannot set model reference "missing/fallback" at agents.defaults.model.fallbacks.0',
    );
  });

  it("validates touched fallback and per-agent model refs", async () => {
    const resolveModelRef = vi.fn(async () => undefined);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [{ id: "ops", model: { primary: "google/gemini-3.1-pro-preview" } }],
      },
    };

    await validateTouchedTextModelRefs({
      config,
      touchedPaths: [
        ["agents", "defaults", "model", "fallbacks"],
        ["agents", "list", "0", "model", "primary"],
      ],
      resolveModelRef,
    });

    expect(resolveModelRef.mock.calls.map(([call]) => call.ref)).toEqual([
      {
        path: "agents.defaults.model.fallbacks.0",
        value: "anthropic/claude-sonnet-4-6",
        fallback: true,
      },
      {
        path: "agents.list.0.model.primary",
        value: "google/gemini-3.1-pro-preview",
        agentIndex: 0,
        fallback: false,
      },
    ]);
  });

  it("does not validate unrelated or media model keys", async () => {
    const resolveModelRef = vi.fn(async () => undefined);

    await validateTouchedTextModelRefs({
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4-mini" },
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      },
      touchedPaths: [["agents", "defaults", "videoGenerationModel", "primary"]],
      resolveModelRef,
    });

    expect(resolveModelRef).not.toHaveBeenCalled();
  });
});
