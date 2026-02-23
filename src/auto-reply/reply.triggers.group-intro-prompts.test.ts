import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  getReplyFromConfig = await loadGetReplyFromConfig();
});

installTriggerHandlingE2eTestHooks();

function getLastExtraSystemPrompt() {
  return getRunEmbeddedPiAgentMock().mock.calls.at(-1)?.[0]?.extraSystemPrompt ?? "";
}

describe("group intro prompts", () => {
  const groupParticipationNote =
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Avoid Markdown tables. Don't type literal \\n sequences; use real line breaks sparingly.";

  it("labels Discord groups using the surface metadata", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedPiAgentOk();

      await getReplyFromConfig(
        {
          Body: "status update",
          From: "discord:group:dev",
          To: "+1888",
          ChatType: "group",
          GroupSubject: "Release Squad",
          GroupMembers: "Alice, Bob",
          Provider: "discord",
        },
        {},
        makeCfg(home),
      );

      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const extraSystemPrompt = getLastExtraSystemPrompt();
      expect(extraSystemPrompt).toContain('"channel": "discord"');
      expect(extraSystemPrompt).toContain(
        `You are in the Discord group chat "Release Squad". Participants: Alice, Bob.`,
      );
      expect(extraSystemPrompt).toContain(
        `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });
  it("keeps WhatsApp labeling for WhatsApp group chats", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedPiAgentOk();

      await getReplyFromConfig(
        {
          Body: "ping",
          From: "123@g.us",
          To: "+1999",
          ChatType: "group",
          GroupSubject: "Ops",
          Provider: "whatsapp",
        },
        {},
        makeCfg(home),
      );

      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const extraSystemPrompt = getLastExtraSystemPrompt();
      expect(extraSystemPrompt).toContain('"channel": "whatsapp"');
      expect(extraSystemPrompt).toContain(`You are in the WhatsApp group chat "Ops".`);
      expect(extraSystemPrompt).toContain(
        `WhatsApp IDs: SenderId is the participant JID (group participant id).`,
      );
      expect(extraSystemPrompt).toContain(
        `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). WhatsApp IDs: SenderId is the participant JID (group participant id). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });
  it("labels Telegram groups using their own surface", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedPiAgentOk();

      await getReplyFromConfig(
        {
          Body: "ping",
          From: "telegram:group:tg",
          To: "+1777",
          ChatType: "group",
          GroupSubject: "Dev Chat",
          Provider: "telegram",
        },
        {},
        makeCfg(home),
      );

      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const extraSystemPrompt = getLastExtraSystemPrompt();
      expect(extraSystemPrompt).toContain('"channel": "telegram"');
      expect(extraSystemPrompt).toContain(`You are in the Telegram group chat "Dev Chat".`);
      expect(extraSystemPrompt).toContain(
        `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });
});
