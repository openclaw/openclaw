import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildStatusReply } from "./commands-status.js";

const baseCommand = {
  surface: "text",
  channel: "telegram",
  ownerList: [],
  senderIsOwner: true,
  isAuthorizedSender: true,
  rawBodyNormalized: "/status",
  commandBodyNormalized: "/status",
};

describe("buildStatusReply", () => {
  it("uses the session/config-selected model instead of transient runtime model", async () => {
    const reply = await buildStatusReply({
      cfg: {
        agents: {
          defaults: {
            model: "openrouter/deepseek/deepseek-v3.2",
          },
        },
      } as unknown as OpenClawConfig,
      command: baseCommand,
      sessionEntry: {
        sessionId: "status-selected-model",
        updatedAt: 0,
      },
      sessionKey: "agent:main:telegram:direct:123",
      provider: "google",
      model: "gemini-3-flash-preview",
      contextTokens: 200_000,
      resolvedThinkLevel: "off",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => "off",
      isGroup: false,
      defaultGroupActivation: () => "mention",
    });

    const normalized = normalizeTestText(reply?.text ?? "");
    expect(normalized).toContain("Model: openrouter/deepseek/deepseek-v3.2");
    expect(normalized).not.toContain("Model: google/gemini-3-flash-preview");
  });

  it("keeps explicit session model overrides in status output", async () => {
    const reply = await buildStatusReply({
      cfg: {
        agents: {
          defaults: {
            model: "openrouter/deepseek/deepseek-v3.2",
          },
        },
      } as unknown as OpenClawConfig,
      command: baseCommand,
      sessionEntry: {
        sessionId: "status-session-override",
        updatedAt: 0,
        providerOverride: "openrouter",
        modelOverride: "x-ai/grok-4.1-fast",
      },
      sessionKey: "agent:main:telegram:direct:123",
      provider: "google",
      model: "gemini-3-flash-preview",
      contextTokens: 200_000,
      resolvedThinkLevel: "off",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => "off",
      isGroup: false,
      defaultGroupActivation: () => "mention",
    });

    const normalized = normalizeTestText(reply?.text ?? "");
    expect(normalized).toContain("Model: openrouter/x-ai/grok-4.1-fast");
    expect(normalized).not.toContain("Model: google/gemini-3-flash-preview");
  });
});
