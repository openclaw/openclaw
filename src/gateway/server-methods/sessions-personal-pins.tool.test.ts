import { expect, it, vi } from "vitest";
import { createSessionsListTool } from "../../agents/tools/sessions-list-tool.js";
import { createSessionsTool } from "../../agents/tools/sessions-tool.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as preferences from "../../state/user-preferences.js";
import {
  PARTICIPANT_DRAFT,
  PARTICIPANT_SHARED,
  REQUESTER,
  TARGET,
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
    expect(
      (await preferences.setCanonicalUserPreferences(alice.profileId, { [pref]: layout }))?.ok,
    ).toBe(true);
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
    await expect(
      preferences.getCanonicalUserPreferences(alice.profileId, [pref]),
    ).resolves.toMatchObject({
      entries: { [pref]: [layout[0]] },
    });
    // The original tool request can finish its personal write; a new list cannot disclose another person's draft.
    const write = preferences.setCanonicalUserPreferences;
    using intercept = vi
      .spyOn(preferences, "setCanonicalUserPreferences")
      .mockImplementationOnce(async (...args) => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: TARGET },
          { visibility: "draft" },
        );
        return write(...args);
      });
    await expect(
      edit.execute("pin", { action: "patch", sessionKey: TARGET, pinned: true }),
    ).resolves.toMatchObject({ details: { status: "updated" } });
    expect(intercept).toHaveBeenCalledOnce();
    await expect(list.execute("fresh", { pinned: true })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
    await expect(
      edit.execute("wrong-person", {
        action: "patch",
        sessionKey: PARTICIPANT_SHARED,
        pinned: true,
        user: bob.profileId,
      }),
    ).rejects.toThrow(/profile|participant|personal|requester|user/i);
    await expect(
      preferences.getCanonicalUserPreferences(bob.profileId, [pref]),
    ).resolves.toMatchObject({
      entries: {},
    });
    await expect(
      preferences.getCanonicalUserPreferences(alice.profileId, [pref]),
    ).resolves.toMatchObject({
      entries: { [pref]: [layout[0], `session:${TARGET}`] },
    });
  });
});

it("explains how to make room for a pin without dropping any saved shortcut", async () => {
  await withParticipantSessionToolsFixture(async ({ cfg, alice }) => {
    const pref = "ui.railShortcuts";
    const shortcuts = Array.from(
      { length: 100 },
      (_, i) => `session-rail:agent:main:dashboard:${String(i).padStart(3, "0")}`,
    );
    const before = [...shortcuts, `session:${PARTICIPANT_SHARED}`];
    expect(
      (await preferences.setCanonicalUserPreferences(alice.profileId, { [pref]: before }))?.ok,
    ).toBe(true);
    const tool = createSessionsTool({ config: cfg, agentSessionKey: REQUESTER });
    const patch = (sessionKey: string, pinned: boolean) =>
      tool.execute("patch-pin", { action: "patch", sessionKey, pinned });
    const read = async () =>
      (await preferences.getCanonicalUserPreferences(alice.profileId, [pref]))?.entries[pref];
    await expect(patch(PARTICIPANT_DRAFT, true)).rejects.toThrow(/remove .*pin or .*shortcut/i);
    expect(await read()).toEqual(before);
    await patch(PARTICIPANT_SHARED, false);
    await patch(PARTICIPANT_DRAFT, true);
    expect(await read()).toEqual([...shortcuts, `session:${PARTICIPANT_DRAFT}`]);
  });
});
