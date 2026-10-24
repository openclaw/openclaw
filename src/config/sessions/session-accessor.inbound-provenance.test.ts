import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import {
  loadSessionEntry,
  recordInboundSessionMeta,
  replaceSessionEntry,
  updateSessionLastRoute,
} from "./session-accessor.js";

it("does not stamp a conversation route or blank name as the creating actor", async () => {
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
        SenderName: "  ",
      },
    });
    expect(participant).toMatchObject({
      createdVia: "channel",
      createdActor: {
        type: "human",
        source: "channel",
        id: "webchat:person-1",
      },
    });
    expect(
      loadSessionEntry({ sessionKey: participantKey, storePath })?.createdActor?.label,
    ).toBeUndefined();
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
});

it.each(["metadata", "last-route"] as const)(
  "creates one native generation through %s without rotating repeated or existing rows",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const storePath = resolveDefaultSessionStorePath("main");
      const sessionKey = `agent:main:telegram:dm:inbound-${kind}`;
      const scope = { storePath, sessionKey };
      const ctx = {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        SessionKey: sessionKey,
      };
      const write = (createIfMissing = true) =>
        kind === "metadata"
          ? recordInboundSessionMeta({ ...scope, ctx, createIfMissing })
          : updateSessionLastRoute({ ...scope, channel: "telegram", to: "123", createIfMissing });
      await write(false);
      expect(loadSessionEntry(scope)).toBeUndefined();
      await write();
      const created = expectDefined(loadSessionEntry(scope), "created inbound row");
      expect(created.lifecycleRevision).toEqual(expect.any(String));
      expect(created.lifecycleRevision).not.toBe("");
      await write();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: created.sessionId,
        lifecycleRevision: created.lifecycleRevision,
        updatedAt: created.updatedAt,
      });
      await replaceSessionEntry(scope, { sessionId: "legacy", updatedAt: 10 });
      await write();
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "legacy", updatedAt: 10 });
      expect(loadSessionEntry(scope)?.lifecycleRevision).toBeUndefined();
    });
  },
);
