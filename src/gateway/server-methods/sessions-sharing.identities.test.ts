import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMembersListEvidenceResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import * as combinedStore from "../../config/sessions/combined-store-gateway.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { authorizeResolvedSessionMutation } from "../session-sharing.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  callSessionSharingHandler as call,
  identifiedClient,
  sessionSharingTestContext as context,
} from "./sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("session member picker identities", () => {
  it("lists sharing evidence independently of placement display failures", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:sharing-display-failure";
      const scope = { agentId: "main", sessionKey };
      replaceSessionEntrySync(scope, { sessionId: "sharing-display-failure", updatedAt: 1 });
      addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 1 });
      const requestContext = context(vi.fn());
      const placements = createWorkerSessionPlacementStore();
      const projection = await createSessionRowProjection({
        cfg: requestContext.getRuntimeConfig(),
        modelCatalog: [],
        placementFactsReader: placements,
      });
      bindSessionRowProjection(requestContext, () => projection);
      try {
        await projection.ensureMaterialized();
        const expected = await call("session.members.listEvidence", { sessionKey }, requestContext);
        expect(expected[0]?.[1]).toMatchObject({
          members: [{ identityId: "guest", addedBy: "owner", addedAt: 1 }],
        });
        vi.spyOn(placements, "readProjection").mockRejectedValue(
          new Error("placement display unavailable"),
        );
        sessionChanges.emit({ all: true, scope: "worker-placements" });
        expect(await call("session.members.listEvidence", { sessionKey }, requestContext)).toEqual(
          expected,
        );
        expect(await call("session.members.list", { sessionKey }, requestContext)).toEqual(
          expected,
        );
      } finally {
        projection.dispose();
      }
    });
  });

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
        const expected = [{ type: "agent", id: `creator-${index}` }];
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
      const expected = [
        { type: "agent", id: "research", label: "Alpha Research" },
        { type: "agent", id: "archived-creator", label: "Archive" },
        { type: "agent", id: "incognito-creator", label: "Incognito" },
        { type: "agent", id: "duplicate", label: "Last label" },
        { type: "agent", id: "sentinel-main", label: "Main sentinel" },
        { type: "human", id: profile.id, label: "Member" },
        { type: "human", id: profileOnly.id, label: "Profile only" },
      ];
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
          await call("session.members.add", { sessionKey, identityId: profile.id }, requestContext),
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
});
