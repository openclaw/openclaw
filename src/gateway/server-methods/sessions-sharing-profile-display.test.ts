import { describe, expect, it, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  recordInboundSessionMeta,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
  soloClient,
} from "./sessions-sharing.test-support.js";

describe("sharing owner display", () => {
  it.each([
    { senderName: "  Slack owner  ", label: "Slack owner" },
    { senderName: undefined, label: undefined },
  ])("presents channel owner attribution with name $senderName", async ({ senderName, label }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("channel-id-collision@example.test");
      setDisplayName(profile.id, "Gateway profile name");
      const sessionKey = "agent:main:slack:channel:c-owner:thread:123.456";
      // Channel ids are opaque; matching a profile id must not adopt its display or identity.
      await recordInboundSessionMeta({
        storePath: resolveDefaultSessionStorePath("main"),
        sessionKey,
        ctx: {
          Provider: "slack",
          Surface: "slack",
          ChatType: "channel",
          From: "slack:channel:C-OWNER",
          To: "channel:C-OWNER",
          SenderId: profile.id,
          SenderName: senderName,
          SessionKey: sessionKey,
        },
      });
      const client = soloClient();
      client.connect.scopes = ["operator.admin"];
      const responses = await callSessionSharingHandler(
        "session.members.listEvidence",
        { sessionKey },
        sessionSharingTestContext(vi.fn()),
        client,
      );
      expect(responses[0]?.[0]).toBe(true);
      expect(responses[0]?.[1]).toMatchObject({
        owner: { type: "human", id: profile.id, label },
        role: "admin",
      });
      expect(responses[0]?.[1]).not.toHaveProperty("owner.identity");
    });
  });

  it("hydrates persisted profile attribution on every read without changing the access identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("sharing-owner@example.test");
      const sessionKey = "agent:main:sharing-profile-display";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "sharing-profile-display",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const context = sessionSharingTestContext(vi.fn());
      const client = identifiedClient(profile.id, "Old login name");
      for (const name of ["Current owner", "Renamed owner"]) {
        setDisplayName(profile.id, name);
        const responses = await callSessionSharingHandler(
          "session.members.listEvidence",
          { sessionKey },
          context,
          client,
        );
        expect(responses[0]?.[0]).toBe(true);
        expect(responses[0]?.[1]).toMatchObject({
          owner: { id: profile.id, label: name, identity: { type: "profile", id: profile.id } },
          identities: expect.arrayContaining([
            expect.objectContaining({ id: profile.id, label: name }),
          ]),
          role: "owner",
        });
      }
    });
  });
});
