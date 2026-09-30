import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import { loadSessionEntry, updateSessionLastRoute } from "./session-accessor.sqlite-entry.js";

it.each([
  { senderName: "  Display Name  ", label: "Display Name" },
  { senderName: undefined, label: undefined },
  { senderName: "  ", label: undefined },
])(
  "stamps last-route creation with sender name $senderName, never the conversation route",
  async ({ senderName, label }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const storePath = resolveDefaultSessionStorePath("main");
      const participantKey = "agent:main:webchat:dm:route-participant";
      const participant = await updateSessionLastRoute({
        storePath,
        sessionKey: participantKey,
        channel: "webchat",
        to: "webchat:room-1",
        ctx: {
          From: "webchat:room-1",
          SenderId: "webchat:person-1",
          SenderName: senderName,
        },
      });
      expect(participant).toMatchObject({
        createdVia: "channel",
        createdActor: {
          type: "human",
          source: "channel",
          id: "webchat:person-1",
          ...(label ? { label } : {}),
        },
      });
      expect(loadSessionEntry({ sessionKey: participantKey, storePath })?.createdActor?.label).toBe(
        label,
      );
      await updateSessionLastRoute({
        storePath,
        sessionKey: participantKey,
        ctx: { SenderId: "webchat:person-2", SenderName: "Another participant" },
      });
      expect(loadSessionEntry({ sessionKey: participantKey, storePath })?.createdActor).toEqual(
        participant?.createdActor,
      );

      const senderlessKey = "agent:main:webchat:dm:route-senderless";
      const senderless = await updateSessionLastRoute({
        storePath,
        sessionKey: senderlessKey,
        channel: "webchat",
        to: "webchat:room-2",
        ctx: { From: "webchat:room-2", SenderName: "Name without an identity" },
      });
      expect(senderless?.createdVia).toBe("channel");
      expect(senderless?.createdActor).toBeUndefined();
    });
  },
);
