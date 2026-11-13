import { expect, it } from "vitest";
import { createProfileSessionEntryFilter } from "../../gateway/session-sharing-read.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  updateSessionLastRoute,
  recordInboundSessionMeta,
} from "./session-accessor.sqlite-entry.js";

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

it("binds new rows before publication and never rebinds existing unset rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      session: {
        sharing: {
          accessPolicy: {
            default: "creator",
            groups: [
              { agentId: "main", channel: "telegram", peerId: "-100123", profileIds: ["staff"] },
            ],
          },
        },
      },
    };
    const storePath = resolveDefaultSessionStorePath("main");
    const creator = { type: "human" as const, source: "profile" as const, id: "creator" };
    const legacyKey = "agent:main:telegram:group:legacy";
    setRuntimeConfigSnapshot({});
    await upsertSessionEntryCore(
      { storePath, sessionKey: legacyKey },
      {
        sessionId: "legacy-before-policy",
        updatedAt: 1,
        visibility: "shared",
        createdActor: creator,
      },
    );
    setRuntimeConfigSnapshot(cfg);
    const visible = createProfileSessionEntryFilter(
      { profileId: "staff", sessionCap: "write", cfg },
      (actor) => actor?.id === "staff",
    );
    const record = (
      sessionKey: string,
      ctx: Parameters<typeof recordInboundSessionMeta>[0]["ctx"],
    ) => recordInboundSessionMeta({ storePath, sessionKey, ctx });
    const observed: Array<{ key: string; bound: boolean; visible: boolean }> = [];
    const stop = sessionChanges.subscribe((change) => {
      if (!("sessionKey" in change)) {
        return;
      }
      const entry = loadSessionEntry({ storePath, sessionKey: change.sessionKey });
      if (entry) {
        observed.push({
          key: change.sessionKey,
          bound: entry.access?.mode === "source",
          visible: visible(change.sessionKey, entry),
        });
      }
    });
    try {
      const directKey = "agent:main:telegram:direct:123:thread:42";
      const direct = await record(directKey, {
        Provider: "telegram",
        ChatType: "direct",
        SessionCreation: { via: "channel", actor: creator },
      });
      expect(direct).toMatchObject({ access: { mode: "source" }, createdActor: creator });
      expect(direct?.visibility).not.toBe("draft");
      const privatePublications = observed.filter((row) => row.key === directKey);
      expect(privatePublications.length).toBeGreaterThan(0);
      expect(privatePublications.every((row) => row.bound && !row.visible)).toBe(true);
      const groupKey = "agent:main:telegram:group:-100123";
      const group = await record(groupKey, {
        Provider: "webchat",
        ChatType: "direct",
        SessionCreation: { via: "channel", actor: creator },
      });
      expect(group?.access).toEqual({ mode: "source" });
      expect(group && visible(groupKey, group)).toBe(true);
      const routeKey = "agent:main:telegram:other-bot:direct:123:thread:42";
      expect(
        (await updateSessionLastRoute({ storePath, sessionKey: routeKey, channel: "telegram" }))
          ?.access,
      ).toEqual({ mode: "source" });
      setRuntimeConfigSnapshot({ session: { sharing: { accessPolicy: { default: "creator" } } } });
      const preserved = await record(groupKey, { Provider: "telegram", ChatType: "group" });
      expect(preserved?.access).toEqual({ mode: "source" });
      const legacy = await record(legacyKey, { Provider: "telegram", ChatType: "group" });
      expect(legacy?.access).toBeUndefined();
      expect(legacy?.visibility).toBe("shared");
      expect(legacy && visible(legacyKey, legacy)).toBe(true);
    } finally {
      stop();
    }
  });
});

it("commits creator-only source ACL before first publication without a Draft presentation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { session: { sharing: { accessPolicy: { default: "creator" } } } };
    setRuntimeConfigSnapshot(cfg);
    const storePath = resolveDefaultSessionStorePath("main");
    const key = "agent:main:telegram:bot:direct:123:thread:42";
    const visible = createProfileSessionEntryFilter(
      { profileId: "outsider", sessionCap: "write", cfg },
      () => false,
    );
    const publications: boolean[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if (!("sessionKey" in change) || change.sessionKey !== key) {
        return;
      }
      const entry = loadSessionEntry({ storePath, sessionKey: key });
      if (entry) {
        expect(entry.access).toEqual({ mode: "source" });
        expect(entry.visibility).not.toBe("draft");
        publications.push(visible(key, entry));
      }
    });
    try {
      const entry = await recordInboundSessionMeta({
        cfg,
        storePath,
        sessionKey: key,
        ctx: {
          Provider: "telegram",
          ChatType: "direct",
          SessionCreation: {
            via: "channel",
            actor: { type: "human", source: "profile", id: "creator" },
          },
        },
      });
      expect(entry?.access).toEqual({ mode: "source" });
      expect(publications.length).toBeGreaterThan(0);
      expect(publications.every((disclosed) => !disclosed)).toBe(true);
    } finally {
      stop();
    }
  }));
