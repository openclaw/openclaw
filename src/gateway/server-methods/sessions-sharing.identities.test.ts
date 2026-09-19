import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  SessionMembersListEvidenceResultSchema,
  type SessionSharingIdentity,
} from "../../../packages/gateway-protocol/src/index.js";
import * as combinedStore from "../../config/sessions/combined-store-gateway.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureProfileForEmail, listProfiles, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { authorizeResolvedSessionMutation } from "../session-sharing.js";
import {
  callSessionSharingHandler as call,
  identifiedClient,
  sessionSharingTestContext as context,
} from "./sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("session member picker identities", () => {
  it("limits creators to the current combined-store scope across configuration changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const stores = [state.path("picker-selected.sqlite"), state.path("picker-other.sqlite")];
      for (const [index, storePath] of stores.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: `agent:main:scope-${index}` },
          {
            sessionId: `scope-${index}`,
            updatedAt: 1,
            createdActor: { type: "agent", id: `creator-${index}` },
          },
        );
      }
      const initialConfig: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {} },
        },
        session: { store: stores[0] },
      };
      let cfg = initialConfig;
      const requestContext = context(vi.fn(), cfg);
      requestContext.getRuntimeConfig = () => cfg;
      for (const [index, storePath] of stores.entries()) {
        cfg = { ...initialConfig, session: { store: storePath } };
        sessionChanges.emit({ all: true, scope: "config" });
        const expected = Object.values(
          combinedStore.loadCombinedSessionStoreForGatewayCore(cfg, { projection: "list" }).store,
        ).map((entry) => ({ type: entry.createdActor!.type, id: entry.createdActor!.id }));
        expect(expected).toEqual([{ type: "agent", id: `creator-${index}` }]);
        const listed = await call(
          "session.members.listEvidence",
          { sessionKey: `agent:main:scope-${index}` },
          requestContext,
        );
        expect(listed[0]?.[1]).toMatchObject({ identities: expected });
        expect(getSessionRowProjection(requestContext)!.selectEntries()).toHaveLength(2);
      }
    });
  });

  it("lists current identities and adds members without decoding unrelated saved prompts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:profile-member";
      const profile = ensureProfileForEmail("member@example.com");
      setDisplayName(profile.id, "Member");
      const selectable = (await listProfiles()).find((item) => item.id === profile.id);
      expect(selectable).toMatchObject({ id: profile.id, displayName: "Member" });
      if (!selectable) {
        throw new Error("expected member profile in picker identities");
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-profile-member",
          updatedAt: 1,
          visibility: "read-only",
        },
      );
      const savedPrompt = "unrelated saved sharing prompt".repeat(512);
      for (const [agentId, createdActor] of [
        ["main", { type: "human", source: "profile", id: profile.id, label: "Old member name" }],
        ["research", { type: "agent", id: "research", label: "Alpha Research" }],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: `agent:${agentId}:unrelated-sharing` },
          {
            sessionId: `unrelated-sharing-${agentId}`,
            updatedAt: 1,
            createdActor,
            skillsSnapshot: { prompt: savedPrompt, skills: [] },
          },
        );
      }
      for (const [agentId, key, id, label, archivedAt] of [
        ["main", "agent:main:archived", "archived-creator", "Archive", 1],
        ["main", "agent:main:duplicate-a", "duplicate", "First label", undefined],
        ["main", "agent:main:duplicate-z", "duplicate", "Last label", 1],
        ["main", "global", "sentinel-main", "Main sentinel", undefined],
        ["research", "global", "sentinel-research", "Research sentinel", undefined],
      ] as const) {
        replaceSessionEntrySync(
          { agentId, sessionKey: key },
          {
            sessionId: key + agentId,
            updatedAt: 1,
            archivedAt,
            createdActor: { type: "agent", id, label },
          },
        );
      }
      const incognitoKey = "agent:main:dashboard:incognito-picker";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: incognitoKey },
        {
          sessionId: "incognito-picker",
          updatedAt: 1,
          incognito: true,
          createdActor: { type: "agent", id: "incognito-creator", label: "Incognito" },
        },
      );
      const profileOnly = ensureProfileForEmail("profile-only@example.com");
      setDisplayName(profileOnly.id, "Profile only");
      const requestContext = context(vi.fn(), {
        agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      });
      await call("session.members.list", { sessionKey }, requestContext);
      const projection = getSessionRowProjection(requestContext)!;
      await projection.ensureMaterialized();
      const legacy = new Map<string, SessionSharingIdentity>();
      // Reference the old combined-store reduction, including its federation order.
      for (const actor of [
        ...Object.values(
          combinedStore.loadCombinedSessionStoreForGatewayCore(requestContext.getRuntimeConfig(), {
            projection: "list",
          }).store,
        ).map((entry) => entry.createdActor),
        ...(await listProfiles()).map((item) => ({
          type: "human" as const,
          id: item.id,
          label: item.displayName ?? undefined,
        })),
      ]) {
        if (!actor?.id) {
          continue;
        }
        const label = actor.label ?? legacy.get(actor.id)?.label;
        legacy.set(actor.id, { type: actor.type, id: actor.id, ...(label ? { label } : {}) });
      }
      const expected = [...legacy.values()].toSorted(
        (a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id) || a.id.localeCompare(b.id),
      );
      expect(expected).toEqual(
        expect.arrayContaining([
          { type: "agent", id: "archived-creator", label: "Archive" },
          { type: "agent", id: "duplicate", label: "Last label" },
          { type: "agent", id: "incognito-creator", label: "Incognito" },
          { type: "human", id: profile.id, label: "Member" },
          { type: "human", id: profileOnly.id, label: "Profile only" },
        ]),
      );
      expect(expected.filter((identity) => identity.id.startsWith("sentinel-"))).toHaveLength(1);
      const scans = vi.spyOn(combinedStore, "loadCombinedSessionStoreForGatewayCore");
      const parse = JSON.parse;
      let unrelatedDecodes = 0;
      const parsed = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        if (typeof value === "string" && value.includes(savedPrompt)) {
          unrelatedDecodes++;
        }
        return parse(value, reviver);
      });
      try {
        for (const method of ["session.members.list", "session.members.listEvidence"] as const) {
          const listed = await call(method, { sessionKey }, requestContext);
          expect(listed[0]?.[1]).toMatchObject({ identities: expected });
        }
        expect(scans).not.toHaveBeenCalled();
        expect(
          projection.capture({ agentId: "main", key: "agent:main:archived" })?.materialized,
        ).toBeUndefined();
        expect(
          await call(
            "session.members.add",
            { sessionKey, identityId: selectable.id },
            requestContext,
          ),
        ).toEqual([[true, { ok: true, sessionKey, identityId: profile.id }, undefined]]);
      } finally {
        parsed.mockRestore();
        scans.mockRestore();
      }
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: identifiedClient(profile.id, "Member"),
          sessionKey,
          agentId: "main",
        }),
      ).toBeNull();
      expect(unrelatedDecodes).toBe(0);
    });
  });

  it("refreshes picker creators after creation and deletion without retaining request actors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:picker-target";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: "picker-target", updatedAt: 1 },
      );
      const requestContext = context(vi.fn());
      const list = async (callerId = "caller-one") => {
        const client = identifiedClient(callerId, callerId);
        client.connect.scopes = ["operator.admin"];
        return Value.Decode(
          SessionMembersListEvidenceResultSchema,
          (
            await call("session.members.listEvidence", { sessionKey }, requestContext, client)
          )[0]?.[1],
        ).identities;
      };
      expect(await list()).toEqual([{ type: "human", id: "caller-one", label: "caller-one" }]);
      for (const [suffix, label] of [
        ["a", "Earlier"],
        ["z", "Later"],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:picker-${suffix}` },
          {
            sessionId: `picker-${suffix}`,
            updatedAt: 1,
            ...(suffix === "z" ? { archivedAt: 1 } : {}),
            createdActor: { type: "agent", id: "new-creator", label },
          },
        );
        expect(await list()).toContainEqual({ type: "agent", id: "new-creator", label });
      }
      for (const suffix of ["z", "a"]) {
        const key = `agent:main:picker-${suffix}`;
        await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          archiveTranscript: false,
          target: { canonicalKey: key, storeKeys: [key] },
        });
        const identities = await list("caller-two");
        expect(identities.some((identity) => identity.id === "caller-one")).toBe(false);
        expect(identities.filter((identity) => identity.id === "new-creator")).toEqual(
          suffix === "z" ? [{ type: "agent", id: "new-creator", label: "Earlier" }] : [],
        );
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "sentinel-without-creator", updatedAt: 1 },
      );
      replaceSessionEntrySync(
        { agentId: "research", sessionKey: "global" },
        {
          sessionId: "sentinel-next",
          updatedAt: 1,
          createdActor: { type: "agent", id: "next-creator" },
        },
      );
      expect((await list()).some((identity) => identity.id === "next-creator")).toBe(false);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        archiveTranscript: false,
        target: { canonicalKey: "global", storeKeys: ["global"] },
      });
      expect(await list()).toContainEqual({ type: "agent", id: "next-creator" });
    });
  });
  it("rejects channel actors as members while keeping legacy rows removable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:channel-actor-member";
      const channelActorId = "slack:channel:C012345";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-channel-actor-member", updatedAt: 2, visibility: "shared" },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:slack-channel" },
        {
          sessionId: "session-slack-channel",
          updatedAt: 1,
          createdActor: { type: "human", source: "channel", id: channelActorId },
        },
      );
      const requestContext = context(vi.fn());

      // A channel-sourced human is not an account the operator can grant
      // access to, so it must not be offered by the picker...
      const listed = await call("session.members.list", { sessionKey }, requestContext);
      expect(listed[0]?.[1]).toMatchObject({
        identities: expect.not.arrayContaining([expect.objectContaining({ id: channelActorId })]),
      });
      // ...nor accepted if a client asks for it directly.
      expect(
        await call(
          "session.members.add",
          { sessionKey, identityId: channelActorId },
          requestContext,
        ),
      ).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.INVALID_REQUEST,
            message: "unknown identity",
          }),
        ],
      ]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([]);

      // A row written before this rule must stay listable and removable,
      // otherwise the fix would strand existing members.
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: channelActorId, addedBy: "legacy-owner", addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const legacyListed = await call("session.members.list", { sessionKey }, requestContext);
      expect(legacyListed[0]?.[1]).toMatchObject({
        members: [expect.objectContaining({ identityId: channelActorId })],
        identities: expect.arrayContaining([
          expect.objectContaining({ type: "human", id: channelActorId }),
        ]),
      });
      expect(
        await call(
          "session.members.remove",
          { sessionKey, identityId: channelActorId },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, identityId: channelActorId }, undefined]]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([]);
    });
  });
});
