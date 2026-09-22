import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
} from "./sessions-sharing.test-support.js";

describe("sharing owner display", () => {
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
