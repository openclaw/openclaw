import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  recordInboundSessionMeta,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { profileSessionEntry } from "./sessions-read-cache.test-support.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
  soloClient,
} from "./sessions-sharing.test-support.js";

async function evidence(
  sessionKey: string,
  client: Parameters<typeof callSessionSharingHandler>[3],
  context = sessionSharingTestContext(vi.fn()),
) {
  const responses = await callSessionSharingHandler(
    "session.members.listEvidence",
    { sessionKey },
    context,
    client,
  );
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1];
}

it.each([
  { senderName: "  Slack owner  ", label: "Slack owner" },
  { senderName: undefined, label: undefined },
])("presents channel owner attribution with name $senderName", ({ senderName, label }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const profile = ensureProfileForEmail("channel-id-collision@example.test");
    setDisplayName(profile.id, "Gateway profile name");
    const sessionKey = "agent:main:slack:channel:c-owner:thread:123.456";
    // Channel ids are opaque; matching a profile id must not adopt its display or identity.
    await recordInboundSessionMeta({
      storePath: resolveDefaultSessionStorePath("main"),
      sessionKey,
      ctx: {
        SenderId: profile.id,
        SenderName: senderName,
      },
    });
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const result = await evidence(sessionKey, client);
    expect(result).toMatchObject({
      owner: { type: "human", id: profile.id, label },
      role: "admin",
    });
    expect(result).not.toHaveProperty("owner.identity");
  }),
);

it("hydrates persisted profile attribution on every read without changing the access identity", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const profile = ensureProfileForEmail("sharing-owner@example.test");
    const sessionKey = "agent:main:sharing-profile-display";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      profileSessionEntry("sharing-profile-display", 1, profile.id),
    );
    const context = sessionSharingTestContext(vi.fn());
    const client = identifiedClient(profile.id, "Old login name");
    for (const [index, name] of ["Current owner", "Renamed owner"].entries()) {
      const directoryEmail = `directory-only-${index}@example.test`;
      const directoryOnly = ensureProfileForEmail(directoryEmail);
      expect(setDisplayName(directoryOnly.id, null)).toMatchObject({
        displayName: null,
        githubIdentity: null,
      });
      setDisplayName(profile.id, name);
      const result = await evidence(sessionKey, client, context);
      expect(result).toMatchObject({
        owner: { id: profile.id, label: name, identity: { type: "profile", id: profile.id } },
        identities: expect.arrayContaining([
          expect.objectContaining({ id: profile.id, label: name }),
          expect.objectContaining({ id: directoryOnly.id, label: directoryEmail }),
        ]),
        role: "owner",
      });
    }
  }));
