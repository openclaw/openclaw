import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMembersListEvidenceResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import * as combinedStore from "../../config/sessions/combined-store-gateway.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sharingStore from "../../config/sessions/session-sharing-store.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as userProfileReads from "../../state/user-profile-reads.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBoardViewTicket } from "../board-view-ticket.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import {
  authorizeResolvedSessionMutation,
  resolveSessionMutationAuthorization,
} from "../session-sharing.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  initializeSessionReadContext,
  identifiedClient as preparedClient,
} from "./sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import {
  callSessionSharingHandler as call,
  identifiedClient,
  sessionSharingTestContext as context,
} from "./sessions-sharing.test-support.js";
import type { GatewayRequestContext } from "./types.js";

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

describe("session sharing authority", () => {
  it("adds, lists, and removes session members without caller-thread SQL after collaboration admission", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:sharing-authority";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "sharing-authority",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
        },
      );
      // Collaboration owns its cold admission; the worker-only entry seed does not admit it.
      await sharingStore.removeSessionMember(
        { agentId: "main", sessionKey },
        "absent-admission-fixture-member",
      );
      const manager = preparedClient("owner");
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      try {
        expect(
          (
            await call(
              "session.members.add",
              { sessionKey, identityId: "owner" },
              requestContext,
              manager,
            )
          )[0]?.[0],
        ).toBe(true);
        expect(
          (
            await call("session.members.listEvidence", { sessionKey }, requestContext, manager)
          )[0]?.[1],
        ).toMatchObject({ role: "owner", members: [{ identityId: "owner", addedBy: "owner" }] });
        expect(
          (
            await call(
              "session.members.remove",
              { sessionKey, identityId: "owner" },
              requestContext,
              manager,
            )
          )[0]?.[0],
        ).toBe(true);
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
    });
  });

  it("refuses membership evidence after a published foreign ownership change", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:sharing-snapshot-owner";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "sharing-snapshot-owner",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
      const manager = preparedClient("owner");
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const projection = getSessionRowProjection(requestContext)!;
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const readMembers = sharingStore.readSessionMembersInWorker;
      vi.spyOn(sharingStore, "readSessionMembersInWorker").mockImplementationOnce(async (input) => {
        const snapshot = await readMembers(input);
        const writer = new DatabaseSync(database.path);
        try {
          writer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdActor.id', ?) WHERE session_key = ?",
            )
            .run("other", sessionKey);
        } finally {
          writer.close();
        }
        sessionChanges.emit({ agentId: "main", sessionKey });
        await projection.prepareSelection();
        const current = projection.sharingTarget({ key: sessionKey, agentId: "main" });
        expect(current?.entry.sessionId).toBe(snapshot.entry?.sessionId);
        expect(current?.entry.lifecycleRevision).toBe(snapshot.entry?.lifecycleRevision);
        expect(current?.entry.createdActor).toMatchObject({ id: "other" });
        return snapshot;
      });
      await expect(
        call("session.members.listEvidence", { sessionKey }, requestContext, manager),
      ).rejects.toThrow("session ownership changed before sharing read");
    });
  });

  it("refuses revoked managers and dirty membership at the worker commit grant", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:sharing-guest" },
        {
          sessionId: "sharing-guest",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "guest" },
        },
      );
      for (const method of ["session.members.add", "session.members.remove"] as const) {
        for (const change of ["caller", "role", "dirty"] as const) {
          const sessionKey = `agent:main:${method}-${change}`;
          const scope = { agentId: "main", sessionKey };
          await upsertSessionEntryCore(scope, {
            sessionId: sessionKey,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "owner" },
          });
          addSessionMember(scope, { identityId: "owner", addedBy: "owner" });
          const manager = preparedClient(change === "role" ? "admin" : "owner");
          if (change === "role") {
            manager.connect.scopes = ["operator.admin"];
          }
          const requestContext = context(vi.fn());
          await initializeSessionReadContext(requestContext);
          const projection = getSessionRowProjection(requestContext)!;
          const target = projection.sharingTarget({ key: sessionKey, agentId: "main" })!;
          const before = await sharingStore.readSessionMembersInWorker(scope);
          const createAdmission = admission.createSqliteWorkerOperationAdmission;
          let reachedCommit = false;
          const gate = vi
            .spyOn(admission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((callback, attachment) =>
              createAdmission((request, grant) => {
                if (request.stage === "commit") {
                  reachedCommit = true;
                  if (change === "caller") {
                    manager.invalidated = true;
                  } else if (change === "role") {
                    manager.connect.scopes = ["operator.read", "operator.write"];
                  } else {
                    sessionChanges.emit({ all: true, scope: "stores" });
                    expect(
                      projection.hasMembership(target.storePath, target.storeKey, "owner"),
                    ).toBe(true);
                    expect(
                      projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status,
                    ).toBe("pending");
                  }
                }
                return callback(request, grant);
              }, attachment),
            );
          try {
            // Add a new member or remove an existing one so rollback has an observable result.
            await expect(
              call(
                method,
                {
                  sessionKey,
                  identityId: method === "session.members.add" ? "guest" : "owner",
                },
                requestContext,
                manager,
              ),
            ).rejects.toThrow(
              change === "dirty"
                ? "Session access facts are unavailable"
                : "session ownership changed before sharing mutation",
            );
            expect(reachedCommit, `${method}: ${change}`).toBe(true);
            expect(requestContext.broadcast).not.toHaveBeenCalled();
          } finally {
            gate.mockRestore();
          }
          expect(await sharingStore.readSessionMembersInWorker(scope)).toEqual(before);
        }
      }
    });
  });

  it("keeps the original session bound while membership preparation yields", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:sharing-preparation";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "original", updatedAt: 1 });
      addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
      const manager = preparedClient("admin");
      manager.connect.scopes = ["operator.admin"];
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const projection = getSessionRowProjection(requestContext)!;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepare = projection.prepareMembership.bind(projection);
      vi.spyOn(projection, "prepareMembership").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        await prepare();
      });
      sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
      const pending = call(
        "session.members.remove",
        { sessionKey, identityId: "guest" },
        requestContext,
        manager,
      );
      const outcome = pending.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "sharing skipped membership preparation",
        );
        replaceSessionEntrySync(scope, { sessionId: "replacement", updatedAt: Date.now() });
        addSessionMember(scope, { identityId: "guest", addedBy: "replacement-owner" });
      } finally {
        release.resolve();
      }
      expect(await outcome).toBeInstanceOf(SessionMutationFactsUnavailableError);
      expect((await sharingStore.readSessionMembersInWorker(scope)).members).toMatchObject([
        { identityId: "guest", addedBy: "replacement-owner" },
      ]);
      expect(requestContext.broadcast).not.toHaveBeenCalled();
    });
  });

  it.each(["session.members.list", "session.members.add"] as const)(
    "rechecks the current manager after profile enumeration for %s",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = "agent:main:profile-enumeration-authority";
        const owner = ensureProfileForEmail("owner-enumeration@example.test");
        const foreign = ensureProfileForEmail("foreign-enumeration@example.test");
        const member = ensureProfileForEmail("member-enumeration@example.test");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "profile-enumeration-authority",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
        const client = identifiedClient(owner.id);
        const requestContext = context(vi.fn());
        await initializeSessionReadContext(requestContext);
        const ready = createDeferredCore();
        const release = createDeferredCore();
        const enumerate = userProfileReads.listProfiles;
        const read = vi.spyOn(userProfileReads, "listProfiles").mockImplementationOnce(async () => {
          const profiles = await enumerate().catch((error: unknown) => {
            ready.reject(error);
            throw error;
          });
          ready.resolve();
          await release.promise;
          return profiles;
        });
        const respond = vi.fn();
        const pending = sessionSharingHandlers[method]!({
          params: {
            sessionKey,
            ...(method === "session.members.add" ? { identityId: member.id } : {}),
          },
          context: requestContext,
          client,
          respond,
        } as never);
        const rejected = expect(pending).rejects.toThrow(/session .* before sharing/);
        try {
          await ready.promise;
          client.authenticatedUserProfile = identifiedClient(foreign.id).authenticatedUserProfile;
          release.resolve();
          await rejected;
          expect(respond).not.toHaveBeenCalled();
          expect(
            (await readSessionMembersInWorker({ agentId: "main", sessionKey })).members,
          ).toEqual([]);
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
          read.mockRestore();
        }
      });
    },
  );
});

describe("session sharing board ticket authority", () => {
  afterEach(() => closeOpenClawAgentDatabasesForTest());
  it("authorizes tickets against their signed agent and issuing Gateway", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "session-main-global", updatedAt: 1, visibility: "shared" },
      );
      await upsertSessionEntryCore(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "session-work-global",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, work: {} },
        },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      let gatewayAActive = true;
      const gatewayARef: { value?: GatewayRequestContext } = {};
      const gatewayA: GatewayRequestContext = {
        ...context(vi.fn(), cfg),
        resolveGatewayContext: () => (gatewayAActive ? gatewayARef.value : undefined),
      };
      gatewayARef.value = gatewayA;
      const gatewayBRef: { value?: GatewayRequestContext } = {};
      const gatewayB: GatewayRequestContext = {
        ...context(vi.fn(), cfg),
        resolveGatewayContext: () => gatewayBRef.value,
      };
      gatewayBRef.value = gatewayB;
      const issueTicket = (agentId?: string) =>
        createBoardViewTicket({
          sessionKey: "global",
          ...(agentId ? { agentId } : {}),
          name: "status",
          revision: 1,
          viewGeneration: agentId ? "a".repeat(32) : "b".repeat(32),
          authority: {
            gatewayContext: gatewayA,
            resolveGatewayContext: gatewayA.resolveGatewayContext!,
          },
        }).ticket;
      const ticket = issueTicket("work");
      const unscopedTicket = issueTicket();
      const memberClient = identifiedClient("outsider@example.com");

      expect(
        resolveSessionMutationAuthorization({
          client: memberClient,
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("owner@example.com"),
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toBeNull();
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("owner@example.com"),
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: gatewayB,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
      gatewayAActive = false;
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("owner@example.com"),
          method: "board.event",
          requestParams: { ticket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
      expect(
        resolveSessionMutationAuthorization({
          client: memberClient,
          method: "board.action",
          requestParams: { ticket: unscopedTicket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    });
  });
});
