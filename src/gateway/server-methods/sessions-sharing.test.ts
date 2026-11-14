import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
  SessionMembersListEvidenceResultSchema,
  SessionSharingEvidenceEventSchema,
  SessionSharingEventSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareSessionGenerationFacts } from "../../config/sessions/session-delivery-generation.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import * as sharingLifecycle from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../local-user-ingress.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
  canReceiveSessionEvent,
  prepareProjectedSessionSharing,
} from "../session-sharing.js";
import { canReceivePreparedSessionEvent } from "../session-sharing.test-utils.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { controlUiHandlers } from "./control-ui.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { fixedStoreOwnershipConfig } from "./sessions-fixed-store.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { sessionReadHandlers as registeredSessionReadHandlers } from "./sessions-read.js";
import {
  createSharingState,
  seedSharingSession as seed,
} from "./sessions-sharing-state.test-support.js";
import {
  callSessionSharingHandler as call,
  identifiedClient,
  sessionSharingTestContext as context,
  soloClient,
} from "./sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function listSessions(
  client: GatewayClient,
  params: Record<string, unknown>,
  overrides: Partial<GatewayRequestContext> = {},
) {
  const requestContext = { ...context(vi.fn()), ...overrides };
  await initializeSessionReadContext(requestContext);
  const responses: Parameters<RespondFn>[] = [];
  await registeredSessionReadHandlers["sessions.list"]?.({
    req: { type: "req", id: "session-list-test", method: "sessions.list" },
    params,
    client,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1] as SessionsListResult | undefined;
}

function profileActor(id = "owner@example.com") {
  return { type: "human", source: "profile", id } as const;
}

function requestFor(sessionKey: string, requestContext = context(vi.fn()), client = soloClient()) {
  return (method: Parameters<typeof call>[0], params: Record<string, unknown> = {}) =>
    call(method, { sessionKey, ...params }, requestContext, client);
}

function addMember(sessionKey: string, identityId: string, addedBy = "owner@example.com") {
  expect(
    addSessionMember({ agentId: "main", sessionKey }, { identityId, addedBy, addedAt: 1 }).inserted,
  ).toBe(true);
}

function seedIncognito(sessionKey: string, storePath: string, sessionId: string) {
  return upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId,
      updatedAt: 2,
      incognito: true,
      visibility: "shared",
      createdActor: profileActor(),
    },
  );
}

function setVisibility(sessionKey: string, visibility: "shared" | "draft") {
  return patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({ visibility }));
}

function hasSession(result: SessionsListResult | undefined, key: string) {
  return result?.sessions.some((session) => session.key === key);
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function sessionMembersListEvidenceResult(responses: Parameters<RespondFn>[]) {
  const response = responses[0];
  if (response?.[0] !== true || response[1] === undefined) {
    throw new Error("expected one successful Gateway response");
  }
  return Value.Decode(SessionMembersListEvidenceResultSchema, response[1]);
}

function sharingEvents(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.flatMap(([name, event]) =>
    name === "session.sharing" ? [Value.Decode(SessionSharingEventSchema, event)] : [],
  );
}

function sharingEvidenceEvents(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.flatMap(([name, event]) =>
    name === "session.sharing.evidence"
      ? [Value.Decode(SessionSharingEvidenceEventSchema, event)]
      : [],
  );
}

const withState = createSharingState(() => captureRuntimeConfigAsyncReader()());

it("preserves profile actors and distinguishes unknown from absent profileless evidence", () =>
  withState(async () => {
    const member = ensureProfileForEmail("sharing-evidence-member@example.com");
    const profiled = identifiedClient("profile-ada", "Ada");
    const unknown = soloClient();
    attachGatewayLocalUserIngress(
      unknown,
      prepareGatewayLocalUserIngress({
        authMethod: "trusted-proxy",
        authenticatedUserExpected: true,
        isLocalClient: false,
      }),
    );
    const absent = soloClient();
    const cases = [
      { name: "present", client: profiled },
      { name: "unknown", client: unknown },
      { name: "absent", client: absent },
    ] as const;

    for (const item of cases) {
      const sessionKey = `agent:main:sharing-actor-${item.name}`;
      await seed(sessionKey, `session-sharing-actor-${item.name}`, {
        visibility: "shared",
        createdActor: item.name === "present" ? profileActor("profile-ada") : undefined,
      });
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      const request = requestFor(sessionKey, requestContext, item.client);
      const transcript = () =>
        loadTranscriptEvents({
          agentId: "main",
          sessionKey,
          sessionId: `session-sharing-actor-${item.name}`,
        });
      const before = await transcript();
      await initializeSessionReadContext(requestContext);
      requestContext.getSessionEventSubscriberConnIds = () => new Set(["legacy-client"]);
      expect((await request("session.visibility.set", { visibility: "draft" }))[0]?.[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("draft");
      expect((await request("session.members.add", { identityId: member.id }))[0]?.[0]).toBe(true);
      const listed = await request("session.members.listEvidence");
      const listing = sessionMembersListEvidenceResult(listed);
      expect(listing.members).toEqual([
        {
          identityId: member.id,
          addedAt: expect.any(Number),
          ...(item.name === "present"
            ? { addedBy: "profile-ada" }
            : item.name === "unknown"
              ? { addedByState: "unknown" }
              : {}),
        },
      ]);
      const legacyListed = await request("session.members.list");
      expect(legacyListed[0]?.[0]).toBe(item.name === "present");
      if (item.name === "present") {
        expect(legacyListed[0]?.[1]).toMatchObject({
          members: [{ identityId: member.id, addedBy: "profile-ada" }],
        });
      } else {
        expect(legacyListed[0]?.[2]?.details).toEqual({
          code: "SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED",
          recommendedMethod: "session.members.listEvidence",
        });
      }
      expect((await request("session.members.remove", { identityId: member.id }))[0]?.[0]).toBe(
        true,
      );
      expect((await readSessionMembersInWorker({ agentId: "main", sessionKey })).members).toEqual(
        [],
      );
      expect(await transcript()).toEqual(before);
      await flushPendingSessionsChangedEvents(requestContext);
      expect(requestContext.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ reason: "sharing", sessionKey }),
        new Set(["legacy-client"]),
        expect.objectContaining({ sessionKeys: [sessionKey] }),
      );
      const publishedEvents = sharingEvents(broadcast);
      expect(publishedEvents.map((event) => event.action)).toEqual(
        item.name === "present" ? ["visibility", "member-added", "member-removed"] : [],
      );
      const publishedEvidenceEvents = sharingEvidenceEvents(broadcast);
      expect(publishedEvidenceEvents.map((event) => event.action)).toEqual(
        item.name === "present" ? [] : ["visibility", "member-added", "member-removed"],
      );
      const emitted = [...publishedEvents, ...publishedEvidenceEvents];
      expect(emitted).toMatchObject([
        { sessionKey, visibility: "draft" },
        { sessionKey, identityId: member.id },
        { sessionKey, identityId: member.id },
      ]);
      for (const publication of broadcast.mock.calls.filter(([name]) =>
        name.startsWith("session.sharing"),
      )) {
        expect(publication[2]).toEqual({ sessionKeys: [sessionKey] });
      }
      for (const event of publishedEvents) {
        expect(event.actor).toMatchObject({ type: "human", id: "profile-ada", label: "Ada" });
      }
      for (const event of publishedEvidenceEvents) {
        expect(event).not.toHaveProperty("actor");
        if (item.name === "unknown") {
          expect(event).toMatchObject({ actorState: "unknown" });
        } else {
          expect(event).not.toHaveProperty("actorState");
        }
      }
      expect(JSON.stringify([publishedEvidenceEvents, listing])).not.toMatch(
        /local-operator|operator\.admin|actor-evidence:/,
      );
    }
  }));

it("keeps other sessions' in-flight delivery generations when membership changes", () =>
  withState(async () => {
    const member = ensureProfileForEmail("sharing-generation-member@example.com");
    const sharedKey = "agent:main:sharing-generation-target";
    const runningKey = "agent:main:sharing-generation-running";
    await seed(sharedKey, "session-sharing-generation-target", {
      visibility: "shared",
      createdActor: profileActor("profile-ada"),
    });
    const running = {
      sessionId: "session-sharing-generation-running",
      lifecycleRevision: "running-lifecycle",
    };
    await seed(runningKey, running.sessionId, running);
    const generation = await prepareSessionGenerationFacts({
      agentId: "main",
      storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
      sessionKey: runningKey,
      ...running,
    });
    try {
      generation.assertCurrent();
      const request = requestFor(
        sharedKey,
        context(vi.fn()),
        identifiedClient("profile-ada", "Ada"),
      );
      expect(await request("session.members.add", { identityId: member.id })).toEqual([
        [true, { ok: true, sessionKey: sharedKey, identityId: member.id }, undefined],
      ]);
      // A long automation turn in another session must survive unrelated sharing edits.
      generation.assertCurrent();
    } finally {
      generation.release();
    }
  }));

it("keeps real actor-evidence profile ids while discarding beta synthetic actors", () =>
  withState(async () => {
    const sessionKey = "agent:main:sharing-storage-projection";
    const sessionId = "session-sharing-storage-projection";
    await seed(sessionKey, sessionId);
    for (const [identityId, addedBy, addedAt] of [
      ["legacy-admin-member", "operator.admin", 1],
      ["legacy-local-member", "local-operator", 2],
      ["real-prefix-member", "actor-evidence:profile-ada", 3],
    ] as const) {
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId, addedBy, addedAt, expectedSessionId: sessionId },
        ).inserted,
      ).toBe(true);
    }

    const response = await call("session.members.listEvidence", { sessionKey }, context(vi.fn()));
    const result = sessionMembersListEvidenceResult(response);
    const member = (identityId: string) =>
      result.members.find((candidate) => candidate.identityId === identityId);
    expect(member("real-prefix-member")).toMatchObject({
      addedBy: "actor-evidence:profile-ada",
    });
    for (const identityId of ["legacy-admin-member", "legacy-local-member"]) {
      expect(member(identityId)).not.toHaveProperty("addedBy");
      expect(member(identityId)).not.toHaveProperty("addedByState");
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /actor-evidence:(unknown|unattributed)|operator\.admin|local-operator/,
    );
  }));

it("admits bare fixed-store keys only through their persisted owner", () =>
  withState(async (state) => {
    const storePath = state.path("shared-sessions.sqlite");
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "global", storePath },
      { sessionId: "session-ops-global", updatedAt: 1, visibility: "shared" },
    );
    const ownedConfig = fixedStoreOwnershipConfig(storePath);

    expect(
      await call("session.members.list", { sessionKey: "global" }, context(vi.fn(), ownedConfig)),
    ).toMatchObject([[true, { sessionKey: "global", role: "owner" }, undefined]]);

    const ownerlessConfig = fixedStoreOwnershipConfig(storePath, false);
    const rejected = await call(
      "session.members.list",
      { sessionKey: "global" },
      context(vi.fn(), ownerlessConfig),
    );
    expect(rejected[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    });
  }));

it("keeps hidden incognito rows from changing non-owner list metadata (search: idle)", async () => {
  await withState(async (state) => {
    const incognitoKey = "agent:main:dashboard:incognito-private";
    await seed("agent:main:main", "session-main");
    const viewer = identifiedClient("viewer@example.com");
    const admin = soloClient();
    admin.connect.scopes = ["operator.admin"];
    const listFor = (client: GatewayClient) =>
      listSessions(client, { search: "idle" }, { loadGatewayModelCatalog: async () => [] });

    const before = await listFor(viewer);
    await seedIncognito(
      incognitoKey,
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      "session-incognito",
    );

    for (const client of [viewer, identifiedClient("owner@example.com"), admin]) {
      const listed = await listFor(client);
      expect(listed?.path).toBe(before?.path);
      expect(hasSession(listed, incognitoKey)).toBe(false);
    }
  });
});

it("never previews sessions hidden from sessions.list", () =>
  withState(async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-preview";
    await seedIncognito(
      sessionKey,
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      "session-incognito-preview",
    );
    const previewContext = context(vi.fn());
    await initializeSessionReadContext(previewContext);
    const previewFor = async (client: GatewayClient) => {
      const responses: Parameters<RespondFn>[] = [];
      await controlUiHandlers["controlUi.sessionPreview"]?.({
        params: { sessionKey },
        client,
        context: previewContext,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
      return responses[0]?.[1];
    };

    expect(await previewFor(identifiedClient("viewer@example.com"))).toEqual({
      status: "unavailable",
    });
    const admin = soloClient();
    admin.connect.scopes = ["operator.admin"];
    expect(await previewFor(admin)).toMatchObject({
      status: "ok",
      sessionKey,
      agentId: "main",
    });
  }));

it("rejects a visibility mutation when the queued session instance changed", () =>
  withState(async () => {
    const sessionKey = "agent:main:stale-sharing-mutation";
    await seed(sessionKey, "session-authorized", { visibility: "shared" });
    const broadcast = vi.fn();
    const requestContext = context(broadcast);
    const run = sharingLifecycle.runSessionMutation;
    vi.spyOn(sharingLifecycle, "runSessionMutation").mockImplementationOnce(async (params) => {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-replaced",
          updatedAt: Date.now(),
          visibility: "shared",
        },
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe("session-replaced");
      await getSessionRowProjection(requestContext)!.prepareMembership();
      return run(params);
    });

    await expect(
      call("session.visibility.set", { sessionKey, visibility: "draft" }, requestContext),
    ).rejects.toThrow(SessionMutationFactsUnavailableError);

    const replacement = loadSessionEntry({ agentId: "main", sessionKey });
    expect(replacement?.sessionId).toBe("session-replaced");
    expect(replacement?.visibility ?? "shared").toBe("shared");
    expect(broadcast).not.toHaveBeenCalledWith(
      "session.sharing",
      expect.anything(),
      expect.anything(),
    );
  }));

it("hides drafts after asynchronous catalog preparation (search: direct)", async () => {
  await withState(async () => {
    const sessionKey = "agent:main:mid-await-draft";
    await seed(sessionKey, "session-mid-await", {
      createdActor: profileActor(),
      visibility: "shared",
    });
    addMember(sessionKey, "member@example.com");
    const outsider = identifiedClient("outsider@example.com");
    const listWith = async (client: GatewayClient) => {
      await setVisibility(sessionKey, "shared");
      return listSessions(
        client,
        { agentId: "main", search: "direct" },
        {
          readPreparedGatewayModelCatalog: async () => {
            await setVisibility(sessionKey, "draft");
            return { entries: [] };
          },
        },
      );
    };

    const outsiderList = await listWith(outsider);
    expect(hasSession(outsiderList, sessionKey)).toBe(false);
    expect(outsiderList).toMatchObject({
      count: 0,
      totalCount: 0,
      nextOffset: null,
      hasMore: false,
      owners: [],
    });
    for (const [identity, visible] of [
      ["member@example.com", false],
      ["owner@example.com", true],
    ] as const) {
      expect(hasSession(await listWith(identifiedClient(identity)), sessionKey)).toBe(visible);
    }
  });
});

it("refills a paged session list after its first row becomes a draft", () =>
  withState(async () => {
    const hiddenKey = "agent:main:mid-await-paged-draft";
    const visibleKey = "agent:main:mid-await-paged-visible";
    await seed(hiddenKey, "session-mid-await-paged-draft", {
      updatedAt: 2,
      createdActor: profileActor("hidden-owner@example.com"),
      visibility: "shared",
    });
    await seed(visibleKey, "session-mid-await-paged-visible", {
      createdActor: profileActor("visible-owner@example.com"),
      visibility: "shared",
    });
    const result = await listSessions(
      identifiedClient("outsider@example.com"),
      { agentId: "main", limit: 1 },
      {
        readPreparedGatewayModelCatalog: async () => {
          await setVisibility(hiddenKey, "draft");
          return { entries: [] };
        },
      },
    );

    expect(result).toMatchObject({
      count: 1,
      totalCount: 1,
      limitApplied: 1,
      nextOffset: null,
      hasMore: false,
      owners: [],
      sessions: [{ key: visibleKey }],
    });
  }));

it("revokes all member access while a session is draft and restores it when shared", () =>
  withState(async () => {
    const sessionKey = "agent:main:member-transition";
    const memberClient = identifiedClient("member@example.com");
    await seed(sessionKey, "session-member-transition", {
      createdActor: profileActor(),
      visibility: "shared",
    });
    addMember(sessionKey, "member@example.com");
    const requestContext = {
      ...context(vi.fn()),
      execApprovalManager: {
        lookupLocalApprovalId: () => ({ kind: "exact", id: "approval-1" }),
        getLocalSnapshot: () => ({ request: { sessionKey, agentId: "main" } }),
      },
    } as unknown as GatewayRequestContext;
    await initializeSessionReadContext(requestContext);
    const projection = getSessionRowProjection(requestContext)!;
    await projection.prepareMembership();
    const sharing = prepareProjectedSessionSharing({
      cfg: {},
      client: memberClient,
      isMember: (target, identity) =>
        projection.hasMembership(target.storePath, target.storeKey, identity),
    });
    const mutations: Array<[string, Record<string, unknown>]> = [
      ["chat.send", { sessionKey }],
      ["sessions.abort", { key: sessionKey }],
      ["sessions.dispatch", { key: sessionKey }],
      ["sessions.move", { key: sessionKey }],
      ["exec.approval.resolve", { id: "approval-1" }],
    ];
    const expectAccess = async (allowed: boolean) => {
      for (const [method, requestParams] of mutations) {
        const result = await resolveSessionMutationAuthorizationAsync({
          client: memberClient,
          method,
          requestParams,
          context: requestContext,
        });
        using _ = { [Symbol.dispose]: () => result.authorization?.release?.() };
        const error = result.error;
        if (allowed) {
          expect(error, method).toBeNull();
        } else {
          expect(error, method).toMatchObject({
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          });
        }
      }
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: memberClient as never,
          sessionKeys: [sessionKey],
          agentId: "main",
          prepared: {
            sharing,
            target: (key) => projection.sharingTarget({ key, agentId: "main" }),
          },
        }),
      ).toBe(allowed);
    };

    await expectAccess(true);
    const captured = await resolveSessionMutationAuthorizationAsync({
      client: memberClient,
      method: "sessions.dispatch",
      requestParams: { key: sessionKey },
      context: requestContext,
    });
    using _ = { [Symbol.dispose]: () => captured.authorization?.release?.() };
    expect(captured.error).toBeNull();
    await setVisibility(sessionKey, "draft");
    await expectAccess(false);
    expect(() => captured.authorization?.assertCurrent()).toThrow(
      SessionMutationAuthorizationChangedError,
    );
    await setVisibility(sessionKey, "shared");
    await expectAccess(true);
  }));

it("requires sharing/group management authority and filters aliased visibility events", () =>
  withState(async () => {
    const sessionKey = "agent:main:main";
    const requestContext = context(vi.fn());
    await seed(sessionKey, "session-main", {
      visibility: "read-only",
      category: "Projects",
    });
    await initializeSessionReadContext(requestContext);
    await getSessionRowProjection(requestContext)!.prepareMembership();
    expect(
      resolveSessionMutationAuthorization({
        client: identifiedClient("viewer"),
        method: "sessions.groups.delete",
        requestParams: { name: "Projects" },
        context: requestContext,
      }).error,
    ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
    expect(
      await call(
        "session.members.list",
        { sessionKey },
        requestContext,
        identifiedClient("viewer"),
      ),
    ).toMatchObject([
      [false, undefined, { details: { code: "SESSION_SHARING_MANAGER_REQUIRED" } }],
    ]);

    const viewerClient = identifiedClient("viewer") as never;
    for (const visibility of ["shared", "draft"] as const) {
      await setVisibility(sessionKey, visibility);
      expect(
        await canReceivePreparedSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(visibility === "shared");
    }
  }));
