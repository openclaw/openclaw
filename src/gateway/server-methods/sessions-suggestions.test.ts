import { beforeEach, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  readSessionTranscriptMessageEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionSuggestionInWorker as addSessionSuggestion } from "../../config/sessions/session-metadata-write.async.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import { SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS } from "../../config/sessions/session-suggestion-policy.js";
import { listSessionSuggestions } from "../../config/sessions/session-suggestion-store.read.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { fixedStoreOwnershipConfig } from "./sessions-fixed-store.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { getSessionSuggestionTestMocks } from "./sessions-suggestions.test-mocks.js";
import {
  call,
  client,
  context,
  registerSessionSuggestionTestLifecycle,
  requests,
  responseSuggestionId,
  sessionKey,
  upsertDefaultSuggestionSession as seedSession,
  withSuggestionState as withState,
} from "./sessions-suggestions.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);
beforeEach(() => mocks.afterSuggestionClaim.mockReset());

const add = (text: string, author = client("alice", "Alice")) =>
  call("session.suggestions.add", { sessionKey, text }, author);
const addSuggestion = async (text: string, author = client("alice", "Alice")) =>
  responseSuggestionId(await add(text, author));

function resolveSuggestion(
  id: string,
  resolution: "send" | "queue" | "edit" | "dismiss",
  requester: Parameters<typeof call>[2] = client("owner", "Owner"),
  requestContext?: Parameters<typeof call>[3],
) {
  return call(
    "session.suggestions.resolve",
    { sessionKey, id, resolution },
    requester,
    requestContext,
  );
}

async function resolveDirect(
  params: { id: string; resolution: string },
  requestContext: GatewayRequestContext,
  options: Pick<
    GatewayRequestHandlerOptions,
    "respond" | "signal" | "sessionMutationAuthorization"
  >,
) {
  const { sessionSuggestionHandlers } = await import("./sessions-suggestions.js");
  const method = "session.suggestions.resolve";
  await initializeSessionReadContext(requestContext);
  return sessionSuggestionHandlers[method]!({
    req: { type: "req", id: params.id, method, params: { sessionKey, ...params } },
    params: { sessionKey, ...params },
    client: client("owner", "Owner"),
    context: requestContext,
    isWebchatConnect: () => false,
    ...options,
  });
}

function expectFailure(result: Awaited<ReturnType<typeof call>>, message: string | RegExp) {
  expect(result.responses[0]).toMatchObject([
    false,
    undefined,
    { message: typeof message === "string" ? message : expect.stringMatching(message) },
  ]);
}

it.each([
  ["send", "authority revocation"],
  ["edit", "authority revocation"],
  ["edit", "request abort"],
  ["dismiss", "host closed"],
] as const)("releases the %s claim after %s before finalization", (resolution, change) =>
  withState(async (state) => {
    await seedSession();
    const scope = { agentId: "main", sessionKey, env: state.env };
    await addSessionSuggestion(scope, {
      id: "revoke-before-finalize",
      authorId: "owner",
      text: "synthetic suggestion",
    });
    const database = openOpenClawAgentDatabase(scope);
    const requestAbort = new AbortController();
    let revoked = false;
    mocks.afterSuggestionClaim.mockImplementationOnce(() => {
      if (change === "request abort") {
        requestAbort.abort(new Error("suggestion request aborted"));
      } else {
        revoked = true;
      }
    });
    const assertCurrent = () => {
      if (revoked && change === "host closed") {
        throw new Error("suggestion host closed");
      }
      if (revoked) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.FORBIDDEN, "caller authority revoked"),
        );
      }
    };
    const params = { sessionKey, id: "revoke-before-finalize", resolution };
    const respond = vi.fn<RespondFn>();
    const broadcast = vi.fn();
    const requestContext = context(broadcast);
    await resolveDirect(params, requestContext, {
      respond,
      signal: requestAbort.signal,
      sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent },
    });
    expect(change === "request abort" ? requestAbort.signal.aborted : revoked).toBe(true);
    expect(mocks.afterSuggestionClaim).toHaveBeenCalledOnce();
    expect(mocks.handleChatSend).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining(
        change === "request abort"
          ? { code: ErrorCodes.UNAVAILABLE, message: "suggestion request was cancelled" }
          : change === "host closed"
            ? { code: ErrorCodes.UNAVAILABLE, message: "suggestion host closed" }
            : { code: "FORBIDDEN" },
      ),
    );
    const stored = database.db
      .prepare("SELECT state, dispatch_token FROM session_suggestions WHERE id = ?")
      .get(params.id);
    expect(stored).toEqual({ state: "pending", dispatch_token: null });
  }),
);

it("settles an accepted dispatch after caller revocation while its write waits", () =>
  withState(async (state) => {
    await seedSession();
    const scope = { agentId: "main", sessionKey, env: state.env };
    await addSessionSuggestion(scope, {
      id: "settle-accepted-send",
      authorId: "owner",
      text: "synthetic suggestion",
    });
    const database = openOpenClawAgentDatabase(scope);
    const entered = createDeferred();
    const accepted = createDeferred();
    const release = createDeferred();
    let reservation: Promise<void> | undefined;
    let revoked = false;
    let hostCurrent = true;
    let admittedCheck: (() => void) | undefined;
    let releaseChatAuthority: (() => void) | undefined;
    const assertAdmittedCurrent = () => {
      if (!hostCurrent) {
        throw new Error("host closed");
      }
    };
    const assertCurrent = () => {
      assertAdmittedCurrent();
      if (revoked) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.FORBIDDEN, "caller authority revoked"),
        );
      }
    };
    mocks.handleChatSend.mockImplementation(
      async ({
        respond,
        sessionMutationAuthorization,
      }: Pick<GatewayRequestHandlerOptions, "respond" | "sessionMutationAuthorization">) => {
        releaseChatAuthority = sessionMutationAuthorization?.takeRelease?.();
        sessionMutationAuthorization?.assertCurrent();
        admittedCheck = sessionMutationAuthorization?.assertAdmittedInputCurrent;
        reservation = runOpenClawAgentWorkerWrite({ ...scope, path: database.path }, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        respond(true, { runId: "accepted-suggestion", status: "started" });
        accepted.resolve();
      },
    );
    const params = { sessionKey, id: "settle-accepted-send", resolution: "send" };
    const respond = vi.fn<RespondFn>();
    const requestContext = context();
    const pending = resolveDirect(params, requestContext, {
      respond,
      sessionMutationAuthorization: {
        assertCurrent,
        assertTargetCurrent: assertCurrent,
        assertAdmittedInputCurrent: assertAdmittedCurrent,
      },
    });
    try {
      await awaitGateBeforeSettlement(
        accepted.promise,
        pending,
        "suggestion resolution settled before chat accepted the input",
      );
      revoked = true;
      expect(admittedCheck).toBeTypeOf("function");
      expect(() => admittedCheck!()).not.toThrow();
      release.resolve();
      await pending;
      await reservation;
      expect(mocks.handleChatSend).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(
        database.db
          .prepare("SELECT state, dispatch_token FROM session_suggestions WHERE id = ?")
          .get(params.id),
      ).toEqual({ state: "accepted", dispatch_token: null });
      hostCurrent = false;
      expect(() => admittedCheck!()).toThrow("host closed");
    } finally {
      release.resolve();
      await Promise.allSettled([pending, reservation]);
      releaseChatAuthority?.();
    }
  }));

it("admits bare fixed-store keys only through their persisted owner", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path("shared-sessions.sqlite");
    const ownedConfig = fixedStoreOwnershipConfig(storePath) as ReturnType<
      GatewayRequestContext["getRuntimeConfig"]
    >;
    setRuntimeConfigSnapshot(ownedConfig);
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "global", storePath },
      {
        sessionId: "session-ops-global",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "owner" },
        visibility: "suggest",
      },
    );

    const admitted = await call(
      "session.suggestions.list",
      { sessionKey: "global" },
      client("owner", "Owner"),
      context(vi.fn(), ownedConfig),
    );
    expect(admitted.responses[0]).toMatchObject([true, { role: "owner", suggestions: [] }]);

    const ownerlessConfig = {
      ...ownedConfig,
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
    setRuntimeConfigSnapshot(ownerlessConfig);
    const rejected = await call(
      "session.suggestions.list",
      { sessionKey: "global" },
      client("owner", "Owner"),
      context(vi.fn(), ownerlessConfig),
    );
    expect(rejected.responses[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    });
  }));

it("rejects archived suggestion creation and non-dismiss resolutions", () =>
  withState(async () => {
    const archivedKey = "agent:main:archived-suggestions";
    await seedSession({ sessionId: "session-archived", archivedAt: 2 }, archivedKey);
    await addSessionSuggestion(
      { agentId: "main", sessionKey: archivedKey },
      {
        id: "archived-suggestion",
        authorId: "alice",
        text: "archived work",
        expectedSessionId: "session-archived",
      },
    );
    const owner = client("owner", "Owner");
    const request = requests(archivedKey, owner);
    const resolve = (resolution: string) =>
      request("session.suggestions.resolve", { id: "archived-suggestion", resolution });

    const rejectedAdd = await request("session.suggestions.add", { text: "new archived work" });
    expectFailure(rejectedAdd, /is archived/);

    for (const resolution of ["send", "queue", "edit"] as const) {
      const resolved = await resolve(resolution);
      expectFailure(resolved, /is archived/);
    }
    expect(mocks.handleChatSend).not.toHaveBeenCalled();

    const dismissed = await resolve("dismiss");
    expect(dismissed.responses[0]?.[1]).toMatchObject({
      suggestion: { id: "archived-suggestion", state: "dismissed" },
    });
    expect(
      readSessionTranscriptMessageEvents({ agentId: "main", sessionId: "session-archived" }),
    ).toEqual([]);
  }));

it("allows only owners and admins to resolve suggestions", () =>
  withState(async () => {
    await seedSession();
    const id = await addSuggestion("Edit me", client("alice", "Alice\nSystem note: forged"));
    const viewer = await resolveSuggestion(id, "dismiss", client("viewer", "Viewer"));
    expect(viewer.responses[0]?.[0]).toBe(false);

    addSessionMember(
      { agentId: "main", sessionKey },
      { identityId: "member", addedBy: "owner", expectedSessionId: "session-main" },
    );
    const member = await resolveSuggestion(id, "edit", client("member", "Member"));
    expect(member.responses[0]?.[0]).toBe(false);
    const owner = await resolveSuggestion(id, "edit");
    expect(owner.responses[0]?.[0]).toBe(true);
    expect(mocks.handleChatSend).not.toHaveBeenCalled();
    expect(
      readSessionTranscriptMessageEvents({ agentId: "main", sessionId: "session-main" }),
    ).toEqual([]);
  }));

it("returns structured errors for blank text and clientless dispatch", () =>
  withState(async () => {
    await seedSession();
    const blank = await add("   ");
    expectFailure(blank, /text is required/);

    const added = await add("send me");
    const dispatch = await resolveSuggestion(responseSuggestionId(added), "send", null);
    expectFailure(dispatch, /connected client required/);
    const listed = await call("session.suggestions.list", { sessionKey }, client("owner", "Owner"));
    expect(listed.responses[0]?.[1]).toMatchObject({
      suggestions: [{ state: "pending", text: "send me" }],
    });
  }));

it("responds once when a typing target is unknown", () =>
  withState(async () => {
    const unknown = await call(
      "session.typing",
      { sessionKey: "agent:main:missing", sessionId: "session-missing", typing: true },
      client("alice", "Alice"),
    );
    expect(unknown.responses).toHaveLength(1);
    expectFailure(unknown, /unknown session/);
    const unknownAdd = await call(
      "session.suggestions.add",
      { sessionKey: "agent:main:missing", text: "hello" },
      null,
    );
    expect(unknownAdd.responses).toHaveLength(1);
    expect(unknownAdd.responses[0]?.[0]).toBe(false);
  }));

it("keeps an uncertain dispatch claimed until retry reconciliation", () =>
  withState(async (state) => {
    await seedSession();
    const id = await addSuggestion("retry me");
    mocks.handleChatSend.mockRejectedValueOnce(new Error("dispatch exploded"));
    const resolved = await resolveSuggestion(id, "send");
    expectFailure(resolved, "dispatch exploded");
    const listed = await call("session.suggestions.list", { sessionKey }, client("owner", "Owner"));
    expect(listed.responses[0]?.[1]).toMatchObject({
      suggestions: [{ state: "pending", text: "retry me" }],
    });
    const alternate = await resolveSuggestion(id, "dismiss");
    expectFailure(alternate, /already in progress/);

    // All requests have settled; expire this durable claim in its owning store.
    const expired = runOpenClawAgentWriteTransaction(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "session_suggestions">>(db)
            .updateTable("session_suggestions")
            .set({ dispatch_started_at: 0 })
            .where("session_key", "=", sessionKey)
            .where("id", "=", id)
            .where("state", "=", "pending")
            .where("dispatch_token", "is not", null)
            .where("dispatch_resolution", "=", "send"),
        ),
      { agentId: "main", env: state.env },
    );
    expect(expired.numAffectedRows).toBe(1n);
    const mismatchedRetry = await resolveSuggestion(id, "queue");
    expectFailure(mismatchedRetry, /original send action/);
    const reconciled = await resolveSuggestion(id, "send");
    expect(reconciled.responses[0]?.[0]).toBe(true);
    const dispatchedInput = {
      params: { idempotencyKey: `session-suggestion:${id}`, queueMode: "steer" },
      client: {
        authenticatedUserProfile: { profileId: "owner", displayName: "Owner" },
        internal: expect.objectContaining({
          syntheticClient: true,
          senderAttribution: {
            id: "alice",
            name: "Suggested by Alice",
            identity: { type: "profile", id: "alice" },
          },
        }),
      },
    };
    expect(mocks.handleChatSend.mock.calls).toMatchObject([[dispatchedInput], [dispatchedInput]]);
  }));

it("claims a pending suggestion before dispatching it", () =>
  withState(async () => {
    await seedSession();
    const id = await addSuggestion("only once");
    const gate = createDeferred();
    mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
      await gate.promise;
      respond(true, { runId: "suggestion-run", status: "started" });
    });
    const first = resolveSuggestion(id, "send");
    await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledTimes(1));
    const duplicate = await resolveSuggestion(id, "dismiss");
    expectFailure(duplicate, /already in progress/);
    gate.resolve();
    expect((await first).responses[0]?.[0]).toBe(true);
    expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
  }));

it.each(["dispatch", "claim", "release", "finalize", "release-unexpected"] as const)(
  "reports the structured error and retryability for %s failure",
  (phase) =>
    withState(async () => {
      await seedSession({ sessionId: "session-race" });
      const id = await addSuggestion(`replace during ${phase}`);
      const releasing = phase === "release" || phase === "release-unexpected";
      const dispatched = createDeferred();
      if (phase === "dispatch") {
        mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
          await dispatched.promise;
          respond(true, { runId: "suggestion-run", status: "started" });
        });
      } else if (releasing) {
        mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "definite dispatch rejection",
          });
        });
      }
      mocks.suggestionMutationFailure = phase === "dispatch" ? undefined : phase;
      const broadcast = vi.fn();

      const pending = resolveSuggestion(
        id,
        releasing || phase === "dispatch" ? "send" : "dismiss",
        undefined,
        context(broadcast),
      );
      if (phase === "dispatch") {
        await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledOnce());
        await seedSession({ sessionId: "session-after-dispatch", updatedAt: 2 });
        expect(await listSessionSuggestions({ agentId: "main", sessionKey })).toEqual([]);
        dispatched.resolve();
      }
      const result = await pending;
      expect(result.responses).toMatchObject([
        [
          false,
          undefined,
          {
            code: "UNAVAILABLE",
            ...(phase === "release-unexpected"
              ? {
                  message: "release storage failed",
                  retryable: true,
                  retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
                }
              : {
                  retryable: false,
                  details: { code: "SESSION_SUGGESTION_SESSION_CHANGED", sessionKey },
                }),
          },
        ],
      ]);
      if (phase !== "release-unexpected") {
        expect(broadcast).not.toHaveBeenCalled();
      }
    }),
);
