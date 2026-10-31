import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  recordInboundSessionMeta,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { setDisplayName as setName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { profileSessionEntry } from "./sessions-read-cache.test-support.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
  soloClient,
} from "./sessions-sharing.test-support.js";

const evidence = callSessionSharingHandler.bind(null, "session.members.listEvidence");

it.each([
  { senderName: "  Slack owner  ", label: "Slack owner" },
  { senderName: undefined, label: undefined },
])("presents channel owner attribution with name $senderName", ({ senderName, label }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const { id } = ensureProfileForEmail("channel-id-collision@example.test");
    setName(id, "Gateway profile name");
    const sessionKey = "agent:main:slack:channel:c-owner:thread:123.456";
    // Channel ids are opaque; matching a profile id must not adopt its display or identity.
    await recordInboundSessionMeta({
      storePath: resolveDefaultSessionStorePath("main"),
      sessionKey,
      ctx: { SenderId: id, SenderName: senderName },
    });
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const context = sessionSharingTestContext(vi.fn());
    const [ok, result] = (await evidence({ sessionKey }, context, client))[0]!;
    expect(ok).toBe(true);
    expect(result).toMatchObject({ owner: { type: "human", id, label }, role: "admin" });
    expect(result).not.toHaveProperty("owner.identity");
  }),
);

it("hydrates persisted profile attribution on every read without changing the access identity", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const { id } = ensureProfileForEmail("sharing-owner@example.test");
    const sessionKey = "agent:main:sharing-profile-display";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      profileSessionEntry("sharing-profile-display", 1, id),
    );
    const context = sessionSharingTestContext(vi.fn());
    const client = identifiedClient(id, "Old login name");
    for (const [index, name] of ["Current owner", "Renamed owner"].entries()) {
      const directoryEmail = `directory-only-${index}@example.test`;
      const directoryOnly = ensureProfileForEmail(directoryEmail);
      expect(setName(directoryOnly.id, null)).toMatchObject({
        displayName: null,
        githubIdentity: null,
      });
      setName(id, name);
      const [ok, result] = (await evidence({ sessionKey }, context, client))[0]!;
      expect(ok).toBe(true);
      expect(result).toMatchObject({
        owner: { id, label: name, identity: { type: "profile", id } },
        identities: expect.arrayContaining([
          expect.objectContaining({ id, label: name }),
          expect.objectContaining({ id: directoryOnly.id, label: directoryEmail }),
        ]),
        role: "owner",
      });
    }
  }));
