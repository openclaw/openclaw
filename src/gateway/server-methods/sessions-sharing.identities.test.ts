import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMembersListEvidenceResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import * as combinedStore from "../../config/sessions/combined-store-gateway.native.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as sharingStore from "../../config/sessions/session-sharing-store.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import * as userProfileReads from "../../state/user-profile-reads.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createBoardViewTicket } from "../board-view-ticket.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import { authorizeResolvedSessionMutationAsync } from "../session-sharing.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  initializeSessionReadContext,
  identifiedClient as preparedClient,
} from "./sessions-read-cache.test-support.js";
import {
  createSharingState,
  seedSharingSession as seed,
} from "./sessions-sharing-state.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import {
  callSessionSharingHandler as call,
  identifiedClient,
  sessionSharingTestContext as context,
} from "./sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

const seedSync = (
  sessionKey: string,
  entry: Partial<Parameters<typeof replaceSessionEntrySync>[1]> = {},
  agentId = "main",
) =>
  replaceSessionEntrySync(
    { agentId, sessionKey },
    { sessionId: sessionKey, updatedAt: 1, ...entry },
  );

async function sharingSession(sessionKey: string, manager = preparedClient("owner")) {
  const requestContext = context(vi.fn());
  await initializeSessionReadContext(requestContext);
  return {
    requestContext,
    projection: getSessionRowProjection(requestContext)!,
    invoke: (method: Parameters<typeof call>[0], params: Record<string, unknown> = {}) =>
      call(method, { sessionKey, ...params }, requestContext, manager),
  };
}

const withState = createSharingState(() => setRuntimeConfigSnapshot({}));

it("lists sharing evidence independently of placement display failures", () =>
  withState(async () => {
    const sessionKey = "agent:main:sharing-display-failure";
    seedSync(sessionKey);
    addSessionMember(
      { agentId: "main", sessionKey },
      { identityId: "guest", addedBy: "owner", addedAt: 1 },
    );
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
      for (const method of ["session.members.listEvidence", "session.members.list"] as const) {
        expect(await call(method, { sessionKey }, requestContext)).toEqual(expected);
      }
    } finally {
      projection.dispose();
    }
  }));

it("limits creators to the current combined-store scope across configuration changes", () =>
  withState(async (state) => {
    const stores = [state.path("picker-selected.sqlite"), state.path("picker-other.sqlite")];
    const initialConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {} },
      },
      session: { store: stores[0] },
    };
    let cfg = initialConfig;
    setRuntimeConfigSnapshot(cfg);
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
    const requestContext = context(vi.fn(), cfg);
    requestContext.getRuntimeConfig = () => cfg;
    for (const [index, storePath] of stores.entries()) {
      cfg = { ...initialConfig, session: { store: storePath } };
      setRuntimeConfigSnapshot(cfg);
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
  }));

it("lists current identities and adds members without decoding unrelated saved prompts", () =>
  withState(async () => {
    const sessionKey = "agent:main:profile-member";
    const profile = ensureProfileForEmail("member@example.com");
    setDisplayName(profile.id, "Member");
    await seed(sessionKey, "session-profile-member", { visibility: "read-only" });
    const savedPrompt = "unrelated saved sharing prompt".repeat(512);
    for (const [agentId, createdActor] of [
      ["main", { type: "human", source: "profile", id: profile.id, label: "Old member name" }],
      ["research", { type: "agent", id: "research", label: "Alpha Research" }],
    ] as const) {
      await seed(
        `agent:${agentId}:unrelated-sharing`,
        `unrelated-sharing-${agentId}`,
        {
          createdActor,
          skillsSnapshot: { prompt: savedPrompt, skills: [] },
        },
        agentId,
      );
    }
    for (const [agentId, key, id, label, archivedAt] of [
      ["main", "agent:main:archived", "archived-creator", "Archive", 1],
      ["main", "agent:main:duplicate-a", "duplicate", "First label", undefined],
      ["main", "agent:main:duplicate-z", "duplicate", "Last label", 1],
      ["main", "global", "sentinel-main", "Main sentinel", undefined],
      ["research", "global", "sentinel-research", "Research sentinel", undefined],
    ] as const) {
      seedSync(
        key,
        { sessionId: key + agentId, archivedAt, createdActor: { type: "agent", id, label } },
        agentId,
      );
    }
    const incognitoKey = "agent:main:dashboard:incognito-picker";
    await replaceSessionEntry(
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
    setRuntimeConfigSnapshot(requestContext.getRuntimeConfig());
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
    vi.spyOn(userProfileReads, "listProfiles").mockRejectedValue(
      new Error("Profile worker enumeration is unavailable"),
    );
    const parse = JSON.parse;
    let unrelatedDecodes = 0;
    vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (typeof value === "string" && value.includes(savedPrompt)) {
        unrelatedDecodes++;
      }
      return parse(value, reviver);
    });
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
    expect(unrelatedDecodes).toBe(0);
    vi.restoreAllMocks();
    expect(
      await authorizeResolvedSessionMutationAsync({
        cfg: {},
        client: identifiedClient(profile.id, "Member"),
        sessionKey,
        agentId: "main",
      }),
    ).toBeNull();
  }));

it("refreshes picker creators after creation and deletion without retaining request actors", () =>
  withState(async () => {
    const sessionKey = "agent:main:picker-target";
    seedSync(sessionKey);
    const requestContext = context(vi.fn());
    const remove = (key: string) =>
      deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
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
      seedSync(`agent:main:picker-${suffix}`, {
        ...(suffix === "z" ? { archivedAt: 1 } : {}),
        createdActor: { type: "agent", id: "new-creator", label },
      });
      expect(await list()).toContainEqual({ type: "agent", id: "new-creator", label });
    }
    for (const suffix of ["z", "a"]) {
      const key = `agent:main:picker-${suffix}`;
      await remove(key);
      const identities = await list("caller-two");
      expect(identities.some((identity) => identity.id === "caller-one")).toBe(false);
      expect(identities.filter((identity) => identity.id === "new-creator")).toEqual(
        suffix === "z" ? [{ type: "agent", id: "new-creator", label: "Earlier" }] : [],
      );
    }
    seedSync("global");
    seedSync(
      "global",
      { sessionId: "sentinel-next", createdActor: { type: "agent", id: "next-creator" } },
      "research",
    );
    expect((await list()).some((identity) => identity.id === "next-creator")).toBe(false);
    await remove("global");
    expect(await list()).toContainEqual({ type: "agent", id: "next-creator" });
  }));
it("adds, lists, and removes session members without caller-thread SQL after collaboration admission", () =>
  withState(async () => {
    const sessionKey = "agent:main:sharing-authority";
    await seed(sessionKey, "sharing-authority", {
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    // Collaboration owns its cold admission; the worker-only entry seed does not admit it.
    await sharingStore.removeSessionMember(
      { agentId: "main", sessionKey },
      "absent-admission-fixture-member",
    );
    const { invoke } = await sharingSession(sessionKey);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect((await invoke("session.members.add", { identityId: "owner" }))[0]?.[0]).toBe(true);
    expect((await invoke("session.members.listEvidence"))[0]?.[1]).toMatchObject({
      role: "owner",
      members: [{ identityId: "owner", addedBy: "owner" }],
    });
    expect((await invoke("session.members.remove", { identityId: "owner" }))[0]?.[0]).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  }));

it("refuses membership evidence after a published foreign ownership change", async ({ signal }) => {
  await withState(async () => {
    const sessionKey = "agent:main:sharing-snapshot-owner";
    const scope = { agentId: "main", sessionKey };
    await seed(sessionKey, "sharing-snapshot-owner", {
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
    const { invoke, projection } = await sharingSession(sessionKey);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const writerEntered = createDeferredCore();
    const releaseWriter = createDeferredCore();
    const snapshotRead = createDeferredCore();
    const waitForGate = (...args: Parameters<typeof awaitGateBeforeSettlement>) =>
      withinTest(awaitGateBeforeSettlement(...args), signal);
    // Retain a real SQLite writer lock until the membership read returns.
    const reservation = runOpenClawAgentWorkerWrite(
      database,
      async () => {
        using holder = new DatabaseSync(database.path);
        holder.exec("BEGIN IMMEDIATE");
        writerEntered.resolve();
        await releaseWriter.promise;
      },
      undefined,
      signal,
    );
    const readMembers = sharingStore.readSessionMembersInWorker;
    vi.spyOn(sharingStore, "readSessionMembersInWorker").mockImplementationOnce(async (input) => {
      const snapshot = await readMembers(input);
      snapshotRead.resolve();
      // Bypass cache receipts for this fixture, but honor the native writer queue.
      await runOpenClawAgentWriteAdmission(
        database,
        () => {
          using writer = new DatabaseSync(database.path);
          writer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdActor.id', ?) WHERE session_key = ?",
            )
            .run("other", sessionKey);
        },
        false,
        undefined,
        signal,
      );
      sessionChanges.emit({ agentId: "main", sessionKey });
      await projection.prepareSelection();
      const current = projection.sharingTarget({ key: sessionKey, agentId: "main" });
      expect(current?.entry.sessionId).toBe(snapshot.entry?.sessionId);
      expect(current?.entry.lifecycleRevision).toBe(snapshot.entry?.lifecycleRevision);
      expect(current?.entry.createdActor).toMatchObject({ id: "other" });
      return snapshot;
    });
    try {
      await waitForGate(
        writerEntered.promise,
        reservation,
        "fixture writer did not retain its native reservation",
      );
      const denied = expect(invoke("session.members.listEvidence")).rejects.toThrow(
        "session ownership changed before sharing read",
      );
      await waitForGate(
        snapshotRead.promise,
        denied,
        "sharing read did not reach the foreign ownership change",
      );
      releaseWriter.resolve();
      await withinTest(denied, signal);
    } finally {
      releaseWriter.resolve();
      await reservation;
    }
  });
});

it("refuses revoked managers and dirty membership at the worker commit grant", () =>
  withState(async () => {
    await seed("agent:main:sharing-guest", "sharing-guest", {
      createdActor: { type: "human", source: "profile", id: "guest" },
    });
    for (const method of ["session.members.add", "session.members.remove"] as const) {
      for (const change of ["caller", "role", "dirty"] as const) {
        const sessionKey = `agent:main:${method}-${change}`;
        const scope = { agentId: "main", sessionKey };
        await seed(sessionKey, sessionKey, {
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        addSessionMember(scope, { identityId: "owner", addedBy: "owner" });
        const manager = preparedClient(change === "role" ? "admin" : "owner");
        if (change === "role") {
          manager.connect.scopes = ["operator.admin"];
        }
        const { invoke, requestContext, projection } = await sharingSession(sessionKey, manager);
        const target = projection.sharingTarget({ key: sessionKey, agentId: "main" })!;
        const before = await sharingStore.readSessionMembersInWorker(scope);
        let reachedCommit = false;
        const gate = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
          if (request.stage === "commit") {
            reachedCommit = true;
            if (change === "caller") {
              manager.invalidated = true;
            } else if (change === "role") {
              manager.connect.scopes = ["operator.read", "operator.write"];
            } else {
              sessionChanges.emit({ all: true, scope: "stores" });
              expect(projection.hasMembership(target.storePath, target.storeKey, "owner")).toBe(
                true,
              );
              expect(
                projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status,
              ).toBe("pending");
            }
          }
          return admit(request, grant);
        });
        try {
          // Add a new member or remove an existing one so rollback has an observable result.
          await expect(
            invoke(method, { identityId: method === "session.members.add" ? "guest" : "owner" }),
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
  }));

it("keeps the original session bound while membership preparation yields", () =>
  withState(async () => {
    const sessionKey = "agent:main:sharing-preparation";
    const scope = { agentId: "main", sessionKey };
    await seed(sessionKey, "original");
    addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
    const manager = preparedClient("admin");
    manager.connect.scopes = ["operator.admin"];
    const { invoke, requestContext, projection } = await sharingSession(sessionKey, manager);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = projection.prepareMembership.bind(projection);
    vi.spyOn(projection, "prepareMembership").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await prepare();
    });
    sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
    const pending = invoke("session.members.remove", { identityId: "guest" });
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
  }));

it.each(["session.members.list", "session.members.add"] as const)(
  "rechecks the current manager after projection preparation for %s",
  (method) =>
    withState(async () => {
      const sessionKey = "agent:main:profile-enumeration-authority";
      const owner = ensureProfileForEmail("owner-enumeration@example.test");
      const foreign = ensureProfileForEmail("foreign-enumeration@example.test");
      const member = ensureProfileForEmail("member-enumeration@example.test");
      await seed(sessionKey, "profile-enumeration-authority", {
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      const client = identifiedClient(owner.id);
      const { requestContext, projection } = await sharingSession(sessionKey, client);
      const preparation =
        method === "session.members.list" ? "prepareSelection" : "ensureMaterialized";
      const prepare = projection[preparation].bind(projection);
      const ready = createDeferredCore();
      const release = createDeferredCore();
      const read = vi.spyOn(projection, preparation).mockImplementationOnce(async () => {
        await prepare();
        ready.resolve();
        await release.promise;
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
        expect((await readSessionMembersInWorker({ agentId: "main", sessionKey })).members).toEqual(
          [],
        );
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        read.mockRestore();
      }
    }),
);
it("authorizes tickets against their signed agent and issuing Gateway", () =>
  withState(async () => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, work: {} },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    await seed("global", "session-main-global", { visibility: "shared" });
    await seed(
      "global",
      "session-work-global",
      {
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "owner@example.com" },
      },
      "work",
    );
    let gatewayAActive = true;
    const gatewayA = context(vi.fn(), cfg);
    gatewayA.resolveGatewayContext = () => (gatewayAActive ? gatewayA : undefined);
    const gatewayB = context(vi.fn(), cfg);
    gatewayB.resolveGatewayContext = () => gatewayB;
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

    const authorize = async (
      client = identifiedClient("owner@example.com"),
      requestContext = gatewayA,
      method = "board.action",
      signedTicket = ticket,
    ) => {
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        context: requestContext,
        method,
        requestParams: { ticket: signedTicket, agentId: "work" },
      });
      result.authorization?.release?.();
      return result.error;
    };

    const expectTargetRequired = async (...args: Parameters<typeof authorize>) =>
      expect(await authorize(...args)).toHaveProperty(
        "details.code",
        "SESSION_MUTATION_TARGET_REQUIRED",
      );
    expect(await authorize(memberClient)).toMatchObject({
      details: { code: "SESSION_PARTICIPATION_REQUIRED" },
    });
    expect(await authorize()).toBeNull();
    await expectTargetRequired(undefined, gatewayB);
    gatewayAActive = false;
    await expectTargetRequired(undefined, gatewayA, "board.event");
    await expectTargetRequired(memberClient, gatewayA, "board.action", unscopedTicket);
  }));
