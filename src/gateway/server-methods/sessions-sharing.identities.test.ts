import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  SessionMembersListEvidenceResultSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionMemberPermissionLevel } from "../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
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
import { setDisplayName, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
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
const seedOwned = (key: string, owner = "owner") =>
  seed(key, key, { createdActor: { type: "human", source: "profile", id: owner } });

it("admits current profiles and non-human creators, rejecting orphan human provenance", () =>
  withState(async () => {
    const owner = ensureProfileForEmail("sharing-owner@example.test");
    const member = ensureProfileForEmail("sessionless-member@example.test");
    const sessionKey = "agent:main:member-admission";
    await seed(sessionKey, sessionKey, {
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    const rejected = ["unknown-identity"];
    for (const incognito of [false, true]) {
      for (const source of ["channel", "unknown", "profile"] as const) {
        const id = `${source}-${incognito ? "private" : "durable"}-orphan`;
        rejected.push(id);
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey: `agent:main:${incognito ? "dashboard:incognito-" : ""}${id}`,
          },
          {
            sessionId: id,
            updatedAt: 1,
            ...(incognito ? { incognito: true } : {}),
            createdActor: { type: "human", source, id },
          },
        );
      }
    }
    for (const type of ["agent", "system"] as const) {
      await seed(`agent:main:${type}-creator`, type, { createdActor: { type, id: type } });
    }
    const { invoke } = await sharingSession(sessionKey, identifiedClient(owner.id));
    const listed = Value.Decode(
      SessionMembersListEvidenceResultSchema,
      (await invoke("session.members.listEvidence"))[0]?.[1],
    );
    expect(listed.owner).toMatchObject({ id: owner.id });
    for (const id of rejected) {
      expect.soft(listed.identities.map((identity) => identity.id)).not.toContain(id);
      expect.soft(await invoke("session.members.add", { identityId: id })).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.INVALID_REQUEST,
            message: "unknown identity",
          }),
        ],
      ]);
    }
    expect
      .soft((await readSessionMembersInWorker({ agentId: "main", sessionKey })).members)
      .toEqual([]);
    for (const identityId of [owner.id, member.id, "agent", "system"]) {
      expect(await invoke("session.members.add", { identityId })).toEqual([
        [true, { ok: true, sessionKey, identityId }, undefined],
      ]);
      if (identityId === member.id) {
        expect(
          await authorizeResolvedSessionMutationAsync({
            cfg: {},
            client: identifiedClient(member.id),
            sessionKey,
            agentId: "main",
          }),
        ).toBeNull();
      }
      expect(await invoke("session.members.remove", { identityId })).toEqual([
        [true, { ok: true, sessionKey, identityId }, undefined],
      ]);
    }
    // Listing historical rows is cleanup evidence, never admission authority.
    const legacyId = rejected[1]!;
    addSessionMember({ agentId: "main", sessionKey }, { identityId: legacyId, addedBy: owner.id });
    expect((await invoke("session.members.listEvidence"))[0]?.[1]).toMatchObject({
      members: [expect.objectContaining({ identityId: legacyId })],
      identities: expect.arrayContaining([expect.objectContaining({ id: legacyId })]),
    });
    expect((await invoke("session.members.add", { identityId: legacyId }))[0]?.[0]).toBe(false);
    expect((await invoke("session.members.remove", { identityId: legacyId }))[0]?.[0]).toBe(true);
    expect((await readSessionMembersInWorker({ agentId: "main", sessionKey })).members).toEqual([]);
  }));

it("lists sharing evidence and adds members independently of placement display failures", () =>
  withState(async () => {
    const sessionKey = "agent:main:sharing-display-failure";
    const member = ensureProfileForEmail("sharing-display-member@example.test");
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
      const expectedEvidence = await call(
        "session.members.listEvidence",
        { sessionKey },
        requestContext,
      );
      expect(expectedEvidence[0]?.[1]).toMatchObject({
        members: [{ identityId: "guest", addedBy: "owner", addedAt: 1 }],
      });
      vi.spyOn(placements, "readProjection").mockRejectedValue(
        new Error("placement display unavailable"),
      );
      sessionChanges.emit({ all: true, scope: "worker-placements" });
      expect(await call("session.members.listEvidence", { sessionKey }, requestContext)).toEqual(
        expectedEvidence,
      );
      expect(
        await call("session.members.add", { sessionKey, identityId: member.id }, requestContext),
      ).toEqual([[true, { ok: true, sessionKey, identityId: member.id }, undefined]]);
      expect((await readSessionMembersInWorker({ agentId: "main", sessionKey })).members).toEqual(
        expect.arrayContaining([expect.objectContaining({ identityId: member.id })]),
      );
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
    const requestContext = context(vi.fn(), {
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
    });
    setRuntimeConfigSnapshot(requestContext.getRuntimeConfig());
    await call("session.members.list", { sessionKey }, requestContext);
    const projection = getSessionRowProjection(requestContext)!;
    await projection.ensureMaterialized();
    const expected = [
      { type: "agent", id: "research", label: "Alpha Research" },
      { type: "agent", id: "incognito-creator", label: "Incognito" },
      { type: "human", id: profile.id, label: "Member" },
    ];
    const scans = vi.spyOn(combinedStore, "loadCombinedSessionStoreForGatewayCore");
    vi.spyOn(userProfileReads, "listProfiles").mockRejectedValue(
      new Error("Profile worker enumeration is unavailable"),
    );
    const parse = vi.spyOn(JSON, "parse");
    for (const method of ["session.members.list", "session.members.listEvidence"] as const) {
      const listed = await call(method, { sessionKey }, requestContext);
      expect(listed[0]?.[1]).toMatchObject({ identities: expected });
    }
    expect(scans).not.toHaveBeenCalled();
    expect(
      await call("session.members.add", { sessionKey, identityId: profile.id }, requestContext),
    ).toEqual([[true, { ok: true, sessionKey, identityId: profile.id }, undefined]]);
    expect(parse.mock.calls.flat()).not.toContainEqual(expect.stringContaining(savedPrompt));
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
    await seedOwned(sessionKey);
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
    await seedOwned(sessionKey);
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
    const guest = ensureProfileForEmail("sharing-guest@example.test");
    await seedOwned("agent:main:sharing-guest", guest.id);
    for (const [method, change] of [
      ["session.members.add", "caller"],
      ["session.members.remove", "role"],
      ["session.members.add", "dirty"],
    ] as const) {
      const sessionKey = `agent:main:${method}-${change}`;
      const scope = { agentId: "main", sessionKey };
      await seedOwned(sessionKey);
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
            expect(projection.hasMembership(target.storePath, target.storeKey, "owner")).toBe(true);
            expect(projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status).toBe(
              "pending",
            );
          }
        }
        return admit(request, grant);
      });
      try {
        // Add a new member or remove an existing one so rollback has an observable result.
        await expect(
          invoke(method, { identityId: method === "session.members.add" ? guest.id : "owner" }),
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
      await seedOwned(sessionKey, owner.id);
      const client = identifiedClient(owner.id);
      const { requestContext, projection } = await sharingSession(sessionKey, client);
      const prepare = projection.prepareSelection.bind(projection);
      const ready = createDeferredCore();
      const release = createDeferredCore();
      const read = vi
        .spyOn(projection, "prepareSelection")
        .mockImplementationOnce(async (...args) => {
          await prepare(...args);
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
it("authorizes board mutations against the signed agent", () =>
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
    const gatewayA = context(vi.fn(), cfg);
    gatewayA.resolveGatewayContext = () => gatewayA;
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
      signedTicket = ticket,
    ) => {
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        context: gatewayA,
        method: "board.action",
        requestParams: { ticket: signedTicket, agentId: "work" },
      });
      result.authorization?.release?.();
      return result.error;
    };

    expect(await authorize(memberClient)).toMatchObject({
      details: { code: "SESSION_PARTICIPATION_REQUIRED" },
    });
    expect(await authorize()).toBeNull();
    expect(await authorize(memberClient, unscopedTicket)).toHaveProperty(
      "details.code",
      "SESSION_MUTATION_TARGET_REQUIRED",
    );
  }));

it("projects current participation and exact choices through the sharing handlers", () =>
  withState(async () => {
    const profile = (name: string, role?: string) => {
      const created = ensureProfileForEmail(`${name}@example.test`);
      if (role) {
        setUserProfileRole(created.id, role);
      }
      return created;
    };
    const owner = profile("owner");
    const gatewayOwner = ensureGatewayOwnerProfile("Gateway owner");
    const baseline = profile("baseline");
    const explicit = profile("explicit");
    const inherited = profile("inherited", "writer");
    const viewOnly = profile("view-only", "viewOnly");
    const limited = profile("limited", "limited");
    const denied = profile("denied", "denied");
    const sandboxed = profile("sandboxed", "sandboxed");
    const wrongAgent = profile("other-agent", "otherAgent");
    type Role = NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>["definitions"][string];
    const role = (others: Role["sessions"]["others"], overrides: Partial<Role> = {}): Role => ({
      sessions: { others },
      agents: "*",
      scopes: ["operator.read", "operator.write"],
      ...overrides,
    });
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "baseline",
          definitions: {
            baseline: role("suggest"),
            writer: role("write"),
            viewOnly: role("view"),
            limited: role("suggest", { scopes: ["operator.read"] }),
            denied: role("none"),
            sandboxed: role("write", { sandbox: "required" }),
            otherAgent: role("write", { agents: ["other"] }),
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:permissions";
    await seed(sessionKey, "permissions", {
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    let requestContext = context(vi.fn(), cfg);
    const client = identifiedClient(owner.id);
    const invoke = (method: Parameters<typeof call>[0], params: Record<string, unknown> = {}) =>
      call(method, { sessionKey, ...params }, requestContext, client);
    const read = async () => {
      const result = await invoke("session.members.listEvidence");
      expect(result[0]?.[0]).toBe(true);
      return Value.Decode(SessionMembersListEvidenceResultSchema, result[0]?.[1]);
    };
    await invoke("session.members.add", { identityId: explicit.id });
    const first = await read();
    const permission = (id: string) => first.permissions?.find((row) => row.identityId === id);
    for (const [person, level, options] of [
      [baseline, "read", ["read", "send"]],
      [explicit, "send", ["read", "send"]],
      [inherited, "send", ["send"]],
      [limited, "read", ["read"]],
      [sandboxed, "read", ["read"]],
      [wrongAgent, "read", ["read"]],
    ] as const) {
      expect(permission(person.id)).toEqual({ identityId: person.id, level, options });
    }
    expect(permission(denied.id)).toBeUndefined();
    expect(permission(owner.id)).toBeUndefined();
    expect(permission(gatewayOwner.id)).toBeUndefined();

    await invoke("session.members.add", { identityId: baseline.id });
    const expectPermission = async (
      person: { id: string },
      level: SessionMemberPermissionLevel,
      options: SessionMemberPermissionLevel[],
    ) =>
      expect((await read()).permissions).toContainEqual({ identityId: person.id, level, options });
    await expectPermission(baseline, "send", ["read", "send"]);
    await invoke("session.members.remove", { identityId: baseline.id });
    await invoke("session.visibility.set", { visibility: "suggest" });
    await expectPermission(baseline, "suggest", ["suggest", "send"]);
    await expectPermission(viewOnly, "read", ["read", "send"]);
    setUserProfileRole(baseline.id, "writer");
    await expectPermission(baseline, "send", ["send"]);

    for (const visibility of ["shared", "draft"] as const) {
      await invoke("session.visibility.set", { visibility });
      expect((await read()).permissions).toEqual([]);
    }
    await invoke("session.visibility.set", { visibility: "read-only" });
    const unconfiguredCfg = {};
    setRuntimeConfigSnapshot(unconfiguredCfg);
    requestContext = context(vi.fn(), unconfiguredCfg);
    const unconfigured = await read();
    expect(unconfigured.permissions).toEqual(
      expect.arrayContaining([
        { identityId: baseline.id, level: "read", options: ["read", "send"] },
        { identityId: explicit.id, level: "send", options: ["read", "send"] },
      ]),
    );
    const legacy = await invoke("session.members.list");
    expect(legacy[0]?.[1]).not.toHaveProperty("permissions");
  }));
