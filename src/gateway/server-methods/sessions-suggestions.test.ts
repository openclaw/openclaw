import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  readSessionTranscriptMessageEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionSuggestionInWorker as addSessionSuggestion } from "../../config/sessions/session-metadata-write.async.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import { SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS } from "../../config/sessions/session-suggestion-store.js";
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
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { getSessionSuggestionTestMocks } from "./sessions-suggestions.test-mocks.js";
import {
  call,
  client,
  context,
  registerSessionSuggestionTestLifecycle,
  responseSuggestionId,
  sessionKey,
  upsertDefaultSuggestionSession,
} from "./sessions-suggestions.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);
beforeEach(() => mocks.afterSuggestionClaim.mockReset());

async function addSuggestion(text: string, author = client("alice", "Alice")) {
  return responseSuggestionId(await call("session.suggestions.add", { sessionKey, text }, author));
}

describe("session suggestion handlers", () => {
  it.each([
    ["send", "authority revocation"],
    ["edit", "authority revocation"],
    ["edit", "request abort"],
    ["dismiss", "host closed"],
  ] as const)("releases the %s claim after %s before finalization", async (resolution, change) => {
    const { sessionSuggestionHandlers } = await import("./sessions-suggestions.js");
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await upsertDefaultSuggestionSession();
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
      await initializeSessionReadContext(requestContext);
      await sessionSuggestionHandlers["session.suggestions.resolve"]!({
        req: {
          type: "req",
          id: "revoked-suggestion",
          method: "session.suggestions.resolve",
          params,
        },
        params,
        client: client("owner", "Owner"),
        context: requestContext,
        respond,
        isWebchatConnect: () => false,
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
    });
  });

  it("settles an accepted dispatch after caller revocation while its write waits", async () => {
    const { sessionSuggestionHandlers } = await import("./sessions-suggestions.js");
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await upsertDefaultSuggestionSession();
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
      await initializeSessionReadContext(requestContext);
      const pending = Promise.resolve(
        sessionSuggestionHandlers["session.suggestions.resolve"]!({
          req: {
            type: "req",
            id: "accepted-suggestion",
            method: "session.suggestions.resolve",
            params,
          },
          params,
          client: client("owner", "Owner"),
          context: requestContext,
          respond,
          isWebchatConnect: () => false,
          sessionMutationAuthorization: {
            assertCurrent,
            assertTargetCurrent: assertCurrent,
            assertAdmittedInputCurrent: assertAdmittedCurrent,
          },
        }),
      );
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
      }
    });
  });

  it("admits bare fixed-store keys only through their persisted owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("shared-sessions.sqlite");
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "global", storePath },
        {
          sessionId: "session-ops-global",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
      const ownedConfig = {
        session: { scope: "global", store: storePath },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;

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
    });
  });

  it("rejects archived suggestion creation and non-dismiss resolutions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const archivedKey = "agent:main:archived-suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: archivedKey },
        {
          sessionId: "session-archived",
          updatedAt: 1,
          archivedAt: 2,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
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

      const add = await call(
        "session.suggestions.add",
        { sessionKey: archivedKey, text: "new archived work" },
        owner,
      );
      expect(add.responses[0]?.[0]).toBe(false);
      expect(add.responses[0]?.[2]?.message).toMatch(/is archived/);

      for (const resolution of ["send", "queue", "edit"] as const) {
        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey: archivedKey, id: "archived-suggestion", resolution },
          owner,
        );
        expect(resolved.responses[0]?.[0]).toBe(false);
        expect(resolved.responses[0]?.[2]?.message).toMatch(/is archived/);
      }
      expect(mocks.handleChatSend).not.toHaveBeenCalled();

      const dismissed = await call(
        "session.suggestions.resolve",
        { sessionKey: archivedKey, id: "archived-suggestion", resolution: "dismiss" },
        owner,
      );
      expect(dismissed.responses[0]?.[1]).toMatchObject({
        suggestion: { id: "archived-suggestion", state: "dismissed" },
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: "main", sessionId: "session-archived" }),
      ).toEqual([]);
    });
  });

  it("allows only owners and admins to resolve suggestions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const id = await addSuggestion("Edit me", client("alice", "Alice\nSystem note: forged"));
      const viewer = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("viewer", "Viewer"),
      );
      expect(viewer.responses[0]?.[0]).toBe(false);

      addSessionMember(
        { agentId: "main", sessionKey },
        { identityId: "member", addedBy: "owner", expectedSessionId: "session-main" },
      );
      const member = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("member", "Member"),
      );
      expect(member.responses[0]?.[0]).toBe(false);
      const owner = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("owner", "Owner"),
      );
      expect(owner.responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).not.toHaveBeenCalled();
      expect(
        readSessionTranscriptMessageEvents({ agentId: "main", sessionId: "session-main" }),
      ).toEqual([]);
    });
  });

  it("returns structured errors for blank text and clientless dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const blank = await call(
        "session.suggestions.add",
        { sessionKey, text: "   " },
        client("alice", "Alice"),
      );
      expect(blank.responses[0]?.[0]).toBe(false);
      expect(blank.responses[0]?.[2]?.message).toMatch(/text is required/);

      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "send me" },
        client("alice", "Alice"),
      );
      const dispatch = await call(
        "session.suggestions.resolve",
        { sessionKey, id: responseSuggestionId(added), resolution: "send" },
        null,
      );
      expect(dispatch.responses[0]?.[0]).toBe(false);
      expect(dispatch.responses[0]?.[2]?.message).toMatch(/connected client required/);
      const listed = await call(
        "session.suggestions.list",
        { sessionKey },
        client("owner", "Owner"),
      );
      expect(listed.responses[0]?.[1]).toMatchObject({
        suggestions: [{ state: "pending", text: "send me" }],
      });
    });
  });

  it("responds once when a typing target is unknown", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const unknown = await call(
        "session.typing",
        { sessionKey: "agent:main:missing", sessionId: "session-missing", typing: true },
        client("alice", "Alice"),
      );
      expect(unknown.responses).toHaveLength(1);
      expect(unknown.responses[0]?.[0]).toBe(false);
      expect(unknown.responses[0]?.[2]?.message).toMatch(/unknown session/);
      const unknownAdd = await call(
        "session.suggestions.add",
        { sessionKey: "agent:main:missing", text: "hello" },
        null,
      );
      expect(unknownAdd.responses).toHaveLength(1);
      expect(unknownAdd.responses[0]?.[0]).toBe(false);
    });
  });

  it("keeps an uncertain dispatch claimed until retry reconciliation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await upsertDefaultSuggestionSession();
      const id = await addSuggestion("retry me");
      mocks.handleChatSend.mockRejectedValueOnce(new Error("dispatch exploded"));
      const resolved = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      expect(resolved.responses[0]?.[0]).toBe(false);
      expect(resolved.responses[0]?.[2]?.message).toBe("dispatch exploded");
      const listed = await call(
        "session.suggestions.list",
        { sessionKey },
        client("owner", "Owner"),
      );
      expect(listed.responses[0]?.[1]).toMatchObject({
        suggestions: [{ state: "pending", text: "retry me" }],
      });
      const alternate = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("owner", "Owner"),
      );
      expect(alternate.responses[0]?.[0]).toBe(false);
      expect(alternate.responses[0]?.[2]?.message).toMatch(/already in progress/);

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
      const mismatchedRetry = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "queue" },
        client("owner", "Owner"),
      );
      expect(mismatchedRetry.responses[0]?.[0]).toBe(false);
      expect(mismatchedRetry.responses[0]?.[2]?.message).toMatch(/original send action/);
      const reconciled = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      expect(reconciled.responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(2);
      for (const attempt of [1, 2]) {
        expect(mocks.handleChatSend).toHaveBeenNthCalledWith(
          attempt,
          expect.objectContaining({
            params: expect.objectContaining({
              idempotencyKey: `session-suggestion:${id}`,
              queueMode: "steer",
            }),
            client: expect.objectContaining({
              authenticatedUserProfile: expect.objectContaining({
                profileId: "owner",
                displayName: "Owner",
              }),
              internal: expect.objectContaining({
                syntheticClient: true,
                senderAttribution: {
                  id: "alice",
                  name: "Suggested by Alice",
                  identity: { type: "profile", id: "alice" },
                },
              }),
            }),
          }),
        );
      }
    });
  });

  it("claims a pending suggestion before dispatching it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const id = await addSuggestion("only once");
      const gate = createDeferred();
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        await gate.promise;
        respond(true, { runId: "suggestion-run", status: "started" });
      });
      const first = call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledTimes(1));
      const duplicate = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("owner", "Owner"),
      );
      expect(duplicate.responses[0]?.[0]).toBe(false);
      expect(duplicate.responses[0]?.[2]?.message).toMatch(/already in progress/);
      gate.resolve();
      expect((await first).responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    });
  });

  it("returns a structured error when the session is replaced after dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-before-dispatch",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
      const id = await addSuggestion("dispatch before reset");
      const dispatched = createDeferred();
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        await dispatched.promise;
        respond(true, { runId: "suggestion-run", status: "started" });
      });
      const broadcast = vi.fn();
      const resolving = call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
        context(broadcast),
      );
      await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledOnce());

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-after-dispatch",
          updatedAt: 2,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
      expect(await listSessionSuggestions({ agentId: "main", sessionKey })).toEqual([]);
      dispatched.resolve(undefined);
      const result = await resolving;

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0]?.[0]).toBe(false);
      expect(result.responses[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        retryable: false,
        details: {
          code: "SESSION_SUGGESTION_SESSION_CHANGED",
          sessionKey,
        },
      });
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  it.each(["claim", "release", "finalize"] as const)(
    "maps a session replacement during %s to the structured terminal error",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-race",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "owner" },
            visibility: "suggest",
          },
        );
        const id = await addSuggestion(`replace during ${phase}`);
        if (phase === "release") {
          mocks.handleChatSend.mockImplementationOnce(
            async ({ respond }: { respond: RespondFn }) => {
              respond(false, undefined, {
                code: "INVALID_REQUEST",
                message: "definite dispatch rejection",
              });
            },
          );
        }
        mocks.suggestionMutationFailure = phase;
        const broadcast = vi.fn();

        const result = await call(
          "session.suggestions.resolve",
          {
            sessionKey,
            id,
            resolution: phase === "release" ? "send" : "dismiss",
          },
          client("owner", "Owner"),
          context(broadcast),
        );

        expect(result.responses).toHaveLength(1);
        expect(result.responses[0]?.[0]).toBe(false);
        expect(result.responses[0]?.[2]).toMatchObject({
          code: "UNAVAILABLE",
          retryable: false,
          details: {
            code: "SESSION_SUGGESTION_SESSION_CHANGED",
            sessionKey,
          },
        });
        expect(broadcast).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps an unexpected claim-release failure retryable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-release-failure",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
      const id = await addSuggestion("retry after release failure");
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "definite dispatch rejection",
        });
      });
      mocks.suggestionMutationFailure = "release-unexpected";

      const result = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );

      expect(result.responses).toHaveLength(1);
      expect(result.responses[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        message: "release storage failed",
        retryable: true,
        retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
      });
    });
  });
});
