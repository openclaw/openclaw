import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_FALLBACKS,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";
import { OPENAI_DEFAULT_MODEL } from "./openai-model-default.js";

describe("applyOpenAICodexModelDefault", () => {
  it("sets openai-codex default when model is unset", () => {
    const cfg: OpenClawConfig = { agents: { defaults: {} } };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
      fallbacks: [...OPENAI_CODEX_DEFAULT_FALLBACKS],
    });
    expect(applied.next.agents?.defaults?.models?.[OPENAI_CODEX_DEFAULT_MODEL]).toEqual({});
    expect(applied.next.agents?.defaults?.models?.[OPENAI_CODEX_DEFAULT_FALLBACKS[0]]).toEqual({});
  });

  it("sets openai-codex default when model is openai/*", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: OPENAI_DEFAULT_MODEL } },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
      fallbacks: [...OPENAI_CODEX_DEFAULT_FALLBACKS],
    });
  });

  it("prepends the default fallback before existing fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: OPENAI_DEFAULT_MODEL,
            fallbacks: ["anthropic/claude-opus-4-5", OPENAI_CODEX_DEFAULT_FALLBACKS[0]],
          },
        },
      },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
      fallbacks: [...OPENAI_CODEX_DEFAULT_FALLBACKS, "anthropic/claude-opus-4-5"],
    });
  });

  it("upgrades legacy openai-codex defaults to gpt-5.4", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.3-codex",
            fallbacks: ["openai-codex/gpt-5.2-codex"],
          },
        },
      },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
      fallbacks: ["openai-codex/gpt-5.2", "openai-codex/gpt-5.2-codex"],
    });
  });

  it("does not override openai-codex/*", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai-codex/custom-model" } },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });

  it("does not override non-openai models", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5" } },
    };
    const applied = applyOpenAICodexModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });
});
