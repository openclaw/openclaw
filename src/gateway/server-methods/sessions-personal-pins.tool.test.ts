import { expect, it } from "vitest";
import { createSessionsListTool } from "../../agents/tools/sessions-list-tool.js";
import { createSessionsTool } from "../../agents/tools/sessions-tool.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import {
  PARTICIPANT_DRAFT,
  PARTICIPANT_SHARED,
  REQUESTER,
  withParticipantSessionToolsFixture,
} from "../local-request-context.session-tools.test-support.js";

it("agent tools read and write the original signed-in person's ordered pins; selecting another user cannot retarget pins", async () => {
  await withParticipantSessionToolsFixture(async ({ cfg, turn, alice, bob }) => {
    const pref = "ui.railShortcuts";
    const layout = [
      `session-rail:${PARTICIPANT_SHARED}`,
      `session:${PARTICIPANT_DRAFT}`,
      `session:${PARTICIPANT_SHARED}`,
    ];
    expect((await setCanonicalUserPreferences(alice.profileId, { [pref]: layout }))?.ok).toBe(true);
    const options = { config: cfg, agentSessionKey: REQUESTER };
    const list = createSessionsListTool(options);
    const edit = createSessionsTool(options);
    await expect(list.execute("first-pin", { pinned: true, limit: 1 })).resolves.toMatchObject({
      details: { nextOffset: 1, sessions: [{ key: PARTICIPANT_DRAFT, pinned: true }] },
    });
    await expect(
      list.execute("second-pin", { pinned: true, offset: 1, limit: 1 }),
    ).resolves.toMatchObject({
      details: { sessions: [{ key: PARTICIPANT_SHARED, pinned: true }] },
    });
    await expect(
      edit.execute("unpin", {
        action: "patch",
        targets: [{ sessionKey: PARTICIPANT_DRAFT }, { sessionKey: PARTICIPANT_SHARED }],
        pinned: false,
      }),
    ).resolves.toMatchObject({ details: { status: "updated", succeeded: [0, 1] } });
    await expect(getCanonicalUserPreferences(alice.profileId, [pref])).resolves.toMatchObject({
      entries: { [pref]: [layout[0]] },
    });
    await expect(
      edit.execute("pin", { action: "patch", sessionKey: PARTICIPANT_SHARED, pinned: true }),
    ).resolves.toMatchObject({ details: { status: "updated" } });
    expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
    await expect(
      edit.execute("wrong-person", {
        action: "patch",
        sessionKey: PARTICIPANT_SHARED,
        pinned: true,
        user: bob.profileId,
      }),
    ).rejects.toThrow(/profile|participant|personal|requester|user/i);
    await expect(getCanonicalUserPreferences(bob.profileId, [pref])).resolves.toMatchObject({
      entries: {},
    });
    await expect(getCanonicalUserPreferences(alice.profileId, [pref])).resolves.toMatchObject({
      entries: { [pref]: [layout[0], layout[2]] },
    });
  });
});
