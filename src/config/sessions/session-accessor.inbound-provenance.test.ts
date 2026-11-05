import { expect, it } from "vitest";
import { createProfileSessionEntryFilter } from "../../gateway/session-sharing-read.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import {
  loadSessionEntry,
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

it("publishes the initial channel row as private before any observer can discover it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      session: {
        sharing: {
          creationDefaults: {
            visibility: "draft",
            sharedGroups: [{ agentId: "main", channel: "telegram", peerId: "-100123" }],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const storePath = resolveDefaultSessionStorePath("main");
    const creator = { type: "human" as const, source: "profile" as const, id: "creator" };
    const visible = createProfileSessionEntryFilter(
      { profileId: "staff", sessionCap: "write" },
      (actor) => actor?.id === "staff",
    );
    const observed: Array<{ key: string; visibility: string | undefined; visible: boolean }> = [];
    const stop = sessionChanges.subscribe((change) => {
      if (!("sessionKey" in change)) {
        return;
      }
      const entry = loadSessionEntry({ storePath, sessionKey: change.sessionKey });
      if (entry) {
        observed.push({
          key: change.sessionKey,
          visibility: entry.visibility,
          visible: visible(change.sessionKey, entry),
        });
      }
    });
    try {
      const directKey = "agent:main:telegram:direct:123:thread:42";
      const direct = await recordInboundSessionMeta({
        storePath,
        sessionKey: directKey,
        ctx: {
          Provider: "telegram",
          ChatType: "direct",
          From: "telegram:123",
          SessionCreation: { via: "channel", actor: creator },
        },
      });
      expect(direct).toMatchObject({ visibility: "draft", createdActor: creator });
      const privatePublications = observed.filter((row) => row.key === directKey);
      expect(privatePublications.length).toBeGreaterThan(0);
      expect(privatePublications.every((row) => row.visibility === "draft" && !row.visible)).toBe(
        true,
      );
      const groupKey = "agent:main:telegram:group:-100123";
      const group = await recordInboundSessionMeta({
        storePath,
        sessionKey: groupKey,
        // Presentation is deliberately wrong: the canonical source owns this decision.
        ctx: {
          Provider: "webchat",
          ChatType: "direct",
          SessionCreation: { via: "channel", actor: creator },
        },
      });
      expect(group?.visibility).toBe("shared");
      expect(group && visible(groupKey, group)).toBe(true);
      const routeKey = "agent:main:telegram:other-bot:direct:123:thread:42";
      const route = await updateSessionLastRoute({
        storePath,
        sessionKey: routeKey,
        channel: "telegram",
      });
      expect(route?.visibility).toBe("draft");
      // Policy changes apply only to creation; they cannot replace explicit stored choices.
      setRuntimeConfigSnapshot({
        session: { sharing: { creationDefaults: { visibility: "draft" } } },
      });
      const preserved = await recordInboundSessionMeta({
        storePath,
        sessionKey: groupKey,
        ctx: { Provider: "telegram", ChatType: "group" },
      });
      expect(preserved?.visibility).toBe("shared");
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
