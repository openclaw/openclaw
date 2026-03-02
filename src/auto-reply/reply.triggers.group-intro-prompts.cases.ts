import { describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

type GetReplyFromConfig = typeof import("./reply.js").getReplyFromConfig;
type InboundMessage = Parameters<GetReplyFromConfig>[0];

function getLastExtraSystemPrompt() {
  return getRunEmbeddedPiAgentMock().mock.calls.at(-1)?.[0]?.extraSystemPrompt ?? "";
}

export function registerGroupIntroPromptCases(params: {
  getReplyFromConfig: () => GetReplyFromConfig;
}): void {
  describe("group intro prompts", () => {
    type GroupIntroCase = {
      name: string;
      message: InboundMessage;
      expected: string[];
      setup?: (cfg: ReturnType<typeof makeCfg>) => void;
    };
    const groupParticipationNote =
      "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Avoid Markdown tables. Don't type literal \\n sequences; use real line breaks sparingly.";
    it("labels group chats using channel-specific metadata", async () => {
      await withTempHome(async (home) => {
        const cases: GroupIntroCase[] = [
          {
            name: "discord",
            message: {
              Body: "status update",
              From: "discord:group:dev",
              To: "+1888",
              ChatType: "group",
              GroupSubject: "Release Squad",
              GroupMembers: "Alice, Bob",
              Provider: "discord",
            },
            expected: [
              '"channel": "discord"',
              `You are in the Discord group chat "Release Squad". Participants: Alice, Bob.`,
              `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
            ],
          },
          {
            name: "whatsapp",
            message: {
              Body: "ping",
              From: "123@g.us",
              To: "+1999",
              ChatType: "group",
              GroupSubject: "Ops",
              Provider: "whatsapp",
            },
            expected: [
              '"channel": "whatsapp"',
              `You are in the WhatsApp group chat "Ops".`,
              `WhatsApp IDs: SenderId is the participant JID (group participant id).`,
              `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). WhatsApp IDs: SenderId is the participant JID (group participant id). ${groupParticipationNote} Address the specific sender noted in the message context.`,
            ],
          },
          {
            name: "telegram",
            message: {
              Body: "ping",
              From: "telegram:group:tg",
              To: "+1777",
              ChatType: "group",
              GroupSubject: "Dev Chat",
              Provider: "telegram",
            },
            expected: [
              '"channel": "telegram"',
              `You are in the Telegram group chat "Dev Chat".`,
              `Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
            ],
          },
          {
            name: "whatsapp-always-on",
            setup: (cfg) => {
              cfg.channels ??= {};
              cfg.channels.whatsapp = {
                ...cfg.channels.whatsapp,
                allowFrom: ["*"],
                groups: { "*": { requireMention: false } },
              };
              cfg.messages = {
                ...cfg.messages,
                groupChat: {},
              };
            },
            message: {
              Body: "hello group",
              From: "123@g.us",
              To: "+2000",
              ChatType: "group",
              Provider: "whatsapp",
              SenderE164: "+2000",
              GroupSubject: "Test Group",
              GroupMembers: "Alice (+1), Bob (+2)",
            },
            expected: [
              '"channel": "whatsapp"',
              '"chat_type": "group"',
              "Activation: always-on (you receive every group message).",
            ],
          },
        ];

        for (const testCase of cases) {
          mockRunEmbeddedPiAgentOk();
          const cfg = makeCfg(home);
          testCase.setup?.(cfg);
          await params.getReplyFromConfig()(testCase.message, {}, cfg);

          expect(getRunEmbeddedPiAgentMock(), testCase.name).toHaveBeenCalledOnce();
          const extraSystemPrompt = getLastExtraSystemPrompt();
          for (const expectedFragment of testCase.expected) {
            expect(extraSystemPrompt, `${testCase.name}:${expectedFragment}`).toContain(
              expectedFragment,
            );
          }
          getRunEmbeddedPiAgentMock().mockClear();
        }
      });
    });
  });
}
