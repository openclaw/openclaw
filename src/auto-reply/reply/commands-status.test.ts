import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildStatusReply } from "./commands-status.js";
import { buildCommandContext } from "./commands.js";

describe("buildStatusReply", () => {
  it("defaults reasoning to on for reasoning-capable models when the session does not override it", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      models: {
        providers: {
          "openai-codex": {
            models: [
              {
                id: "gpt-5.4",
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const command = buildCommandContext({
      ctx: {
        Body: "/status",
        CommandBody: "/status",
        CommandSource: "text",
        CommandAuthorized: true,
        Provider: "whatsapp",
        Surface: "whatsapp",
      } as MsgContext,
      cfg,
      isGroup: false,
      triggerBodyNormalized: "/status",
      commandAuthorized: true,
    });

    const reply = await buildStatusReply({
      cfg,
      command,
      sessionEntry: { sessionId: "status-default", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      provider: "openai-codex",
      model: "gpt-5.4",
      contextTokens: 272000,
      resolvedThinkLevel: "medium",
      resolvedVerboseLevel: "off",
      resolveDefaultThinkingLevel: async () => "medium",
      resolveDefaultReasoningLevel: async () => "on",
      isGroup: false,
      defaultGroupActivation: () => "mention",
    });

    expect(reply?.text).toContain("Think: medium");
    expect(reply?.text).toContain("Reasoning: on");
  });
});
