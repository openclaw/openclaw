import { describe, expect, it } from "vitest";
import { getDefaultModelProviderAuthError } from "./server-startup.js";

describe("getDefaultModelProviderAuthError", () => {
  it("returns a clear startup error when the default model provider has no auth", () => {
    const error = getDefaultModelProviderAuthError({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      },
      hasAuthForProviderFn: () => false,
      resolveAgentDirFn: () => "/tmp/openclaw-agent-main",
    } satisfies Parameters<typeof getDefaultModelProviderAuthError>[0]);

    expect(error).toContain('Default model "anthropic/claude-opus-4-6" has no configured auth');
    expect(error).toContain('openclaw models set "openai-codex/gpt-5.4"');
  });

  it("returns nothing when the default model provider already has auth", () => {
    const error = getDefaultModelProviderAuthError({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.4" },
          },
        },
      },
      hasAuthForProviderFn: () => true,
      resolveAgentDirFn: () => "/tmp/openclaw-agent-main",
    } satisfies Parameters<typeof getDefaultModelProviderAuthError>[0]);

    expect(error).toBeUndefined();
  });

  it("skips the auth check when channel startup is disabled", () => {
    const error = getDefaultModelProviderAuthError({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      },
      skipChannels: true,
      hasAuthForProviderFn: () => false,
      resolveAgentDirFn: () => "/tmp/openclaw-agent-main",
    } satisfies Parameters<typeof getDefaultModelProviderAuthError>[0]);

    expect(error).toBeUndefined();
  });
});
