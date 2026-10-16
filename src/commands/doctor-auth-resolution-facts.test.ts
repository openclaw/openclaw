import { expect, it } from "vitest";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import {
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { maybeRepairOpenAICodexAuthConfig } from "./doctor-auth-flat-profiles.js";

it.each([false, true])(
  "preserves resolved env references through auth repair (changed: %s)",
  (changed) => {
    const refs = new Map<string, string>();
    const cfg = resolveConfigEnvVars(
      {
        channels: { telegram: { botToken: "${TELEGRAM_BOT_TOKEN_FAKE_A}" } },
        ...(changed ? { auth: { order: { "openai-codex": ["openai-codex:work"] } } } : {}),
      },
      { TELEGRAM_BOT_TOKEN_FAKE_A: "synthetic-telegram-token" },
      { onResolvedEnvSecretRef: (id, path) => refs.set(path, id) },
    ) as OpenClawConfig;
    setConfigResolutionFacts(cfg, createConfigResolutionFacts([], new Map(), undefined, refs));

    const repaired = maybeRepairOpenAICodexAuthConfig(cfg);

    expect(repaired.changes.length > 0).toBe(changed);
    expect(getResolvedConfigEnvSecretRef(repaired.config, "channels.telegram.botToken")).toEqual({
      source: "env",
      provider: "default",
      id: "TELEGRAM_BOT_TOKEN_FAKE_A",
    });
    if (!changed) {
      expect(repaired.config).toBe(cfg);
    }
  },
);
