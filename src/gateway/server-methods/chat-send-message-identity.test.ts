import { describe, expect, it, vi } from "vitest";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createUserTurnInputController,
  createClientInfo,
  createAttachments,
} from "./chat-send-user-turn.test-support.js";

describe("chat.send channel message identity", () => {
  it.each(["telegram", "slack"])(
    "does not turn a chat.send run ID into a %s message ID",
    async (originatingChannel) => {
      const { controller, readInput } = createUserTurnInputController("Send a preview");
      const prepared = await prepareChatSendUserTurn({
        request: {
          inboundMessage: "Send a preview",
          clientInfo: createClientInfo({ displayName: "ACP" }),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "c2417c98-8584-40c4-a9ce-f5c8068d1020",
          sessionKey: `agent:main:${originatingChannel}:default:direct:12345`,
        },
        admission: {
          originatingRoute: {
            originatingChannel,
            originatingTo: "12345",
            accountId: "default",
            explicitDeliverRoute: false,
          },
        },
        attachments: createAttachments({ parsedMessage: "Send a preview" }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      expect(prepared.ctx).toMatchObject({
        OriginatingChannel: originatingChannel,
        OriginatingTo: "12345",
        AccountId: "default",
      });
      expect(prepared.ctx.MessageSid).toBeUndefined();
      expect(prepared.ctx.MessageSidFull).toBeUndefined();
      expect(await readInput()).toMatchObject({
        text: "Send a preview",
        idempotencyKey: "run-1:user",
      });
    },
  );
});
