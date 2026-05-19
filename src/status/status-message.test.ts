import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatFastModeLabel } from "./status-labels.js";
import { buildStatusMessage } from "./status-message.js";

describe("formatFastModeLabel", () => {
  it("shows fast mode when enabled", () => {
    expect(formatFastModeLabel(true)).toBe("Fast");
  });

  it("hides fast mode when disabled", () => {
    expect(formatFastModeLabel(false)).toBeNull();
  });

  it("shows canonical OpenAI text verbosity even when the active runtime provider is openai-codex", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
          models: {
            "openai/gpt-5.5": {
              params: {
                textVerbosity: "medium",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const sessionEntry = {
      sessionId: "status-message-test",
      updatedAt: 1_000_000,
      modelProvider: "openai-codex",
      model: "gpt-5.5",
    } satisfies SessionEntry;

    const message = buildStatusMessage({
      config,
      agent: {
        model: {
          primary: "openai/gpt-5.5",
        },
      },
      sessionEntry,
      now: 1_000_000,
    });

    expect(message).toContain("Text: medium");
  });
});
