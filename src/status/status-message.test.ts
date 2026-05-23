import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatFastModeLabel } from "./status-labels.js";
import { buildStatusMessage, type StatusArgs } from "./status-message.js";

describe("formatFastModeLabel", () => {
  it("shows fast mode when enabled", () => {
    expect(formatFastModeLabel(true)).toBe("Fast");
  });

  it("hides fast mode when disabled", () => {
    expect(formatFastModeLabel(false)).toBeNull();
  });
});

describe("buildStatusMessage", () => {
  const bedrockConfig = {
    models: {
      providers: {
        "amazon-bedrock": {
          auth: "aws-sdk",
          models: [
            {
              id: "us.anthropic.claude-sonnet-4-6",
              cost: {
                input: 3,
                output: 15,
                cacheRead: 0.3,
                cacheWrite: 3.75,
              },
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;

  const baseStatusArgs = {
    agent: { model: { primary: "amazon-bedrock/us.anthropic.claude-sonnet-4-6" } },
    config: bedrockConfig,
    sessionEntry: {
      inputTokens: 1000,
      outputTokens: 1000,
    },
    timeLine: "Time: test",
    uptimeLine: "Uptime: test",
    now: 0,
  } satisfies StatusArgs;

  it("shows configured cost for aws-sdk providers", () => {
    const message = buildStatusMessage({
      ...baseStatusArgs,
      modelAuth: "aws-sdk",
      activeModelAuth: "aws-sdk",
    });

    expect(message).toContain(
      "🧠 Model: amazon-bedrock/us.anthropic.claude-sonnet-4-6 · 🔑 aws-sdk",
    );
    expect(message).toContain("🧮 Tokens: 1.0k in / 1.0k out · 💵 Cost: $0.02");
  });

  it("keeps hiding cost when no pricing is configured", () => {
    const message = buildStatusMessage({
      ...baseStatusArgs,
      config: undefined,
      modelAuth: "aws-sdk",
      activeModelAuth: "aws-sdk",
    });

    expect(message).toContain("🧮 Tokens: 1.0k in / 1.0k out");
    expect(message).not.toContain("💵 Cost:");
  });
});
