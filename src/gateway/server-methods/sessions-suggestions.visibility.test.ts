import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, symlinkSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { compareSessionProviderReview } from "../../config/sessions/provider-review-store.js";
import type { SessionProviderReview } from "../../config/sessions/provider-review.types.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionSuggestionInWorker } from "../../config/sessions/session-metadata-write.async.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { listSessionSuggestions } from "../../config/sessions/session-suggestion-store.read.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { observeSqliteWalPeriodicWork } from "../../infra/sqlite-wal-scheduler.test-support.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import type { OperatorScope } from "../operator-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import {
  bindSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
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
  upsertDefaultSuggestionSession,
  withSuggestionState,
} from "./sessions-suggestions.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);

beforeEach(() => mocks.afterSuggestionClaim.mockReset());
// Register shared mocks before the handlers capture their presence dependency.
const { sessionSuggestionHandlers } = await import("./sessions-suggestions.js");

const withState = (run: Parameters<typeof withSuggestionState>[0]) =>
  withSuggestionState(run, { prepareProfileCatalog: true });

function roleConfig(
  others: "none" | "view" | "suggest" | "write",
  scopes: OperatorScope[] = ["operator.read", "operator.write"],
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "reader",
        definitions: { reader: { scopes, agents: "*", sessions: { others } } },
      },
    },
  };
}

async function seedIdeas(
  authors: Record<string, string>,
  entry: Parameters<typeof upsertDefaultSuggestionSession>[0] = {},
  key = sessionKey,
) {
  await upsertDefaultSuggestionSession(entry, key);
  for (const [id, authorId] of Object.entries(authors)) {
    await addSessionSuggestionInWorker(
      { agentId: "main", sessionKey: key },
      { id, authorId, text: id, expectedSessionId: entry.sessionId },
    );
  }
}

it.each(["policy", "profile", "disconnect", "session", "membership", "projection"] as const)(
  "rechecks %s after a delayed suggestion list reply",
  (change) =>
    withState(async () => {
      await seedIdeas({ alice: "alice", bob: "bob" });
      let committed = roleConfig(change === "membership" ? "view" : "write");
      setRuntimeConfigSnapshot(committed);
      if (change === "membership") {
        addSessionMember(
          { agentId: "main", sessionKey },
          {
            identityId: "alice",
            addedBy: "owner",
            expectedSessionId: "session-main",
          },
        );
      }
      const requestContext = context(vi.fn(), committed);
      requestContext.getCommittedRuntimeConfig = () => committed;
      await initializeSessionReadContext(requestContext);
      const requester = client("alice", "Alice");
      const entered = createDeferred();
      const release = createDeferred();
      const run = projectionLane.pool.run.bind(projectionLane.pool);
      vi.spyOn(projectionLane.pool, "run").mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (
          reply.ok &&
          typeof reply.value === "object" &&
          !Array.isArray(reply.value) &&
          "kind" in reply.value &&
          reply.value.kind === "session-suggestions"
        ) {
          entered.resolve();
          await release.promise;
        }
        return reply;
      });
      const pending = call("session.suggestions.list", { sessionKey }, requester, requestContext);
      const outcome = pending.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Suggestion list was not dispatched",
        );
        if (change === "policy") {
          committed = roleConfig("view");
        } else if (change === "profile") {
          requester.authenticatedUserProfile = client("bob", "Bob").authenticatedUserProfile;
        } else if (change === "disconnect") {
          requester.invalidated = true;
        } else if (change === "membership") {
          removeSessionMember({ agentId: "main", sessionKey }, "alice");
        } else if (change === "projection") {
          bindSessionRowProjection(requestContext, () => undefined);
        } else {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            { sessionId: "replacement", updatedAt: 2 },
          );
        }
        release.resolve();
        if (change === "session" || change === "projection") {
          await expect(pending).rejects.toThrow(/unavailable/);
        } else {
          const result = await pending;
          expect(result.responses).toMatchObject([
            change === "policy" || change === "membership"
              ? [true, { role: "viewer", suggestions: [expect.objectContaining({ id: "alice" })] }]
              : [false, undefined, { code: "FORBIDDEN" }],
          ]);
        }
      } finally {
        release.resolve();
        await outcome;
      }
    }),
);

it("retains committed suggestion visibility through a tentative role relaxation", () =>
  withState(async (state) => {
    const owner = ensureProfileForEmail("policy-suggestion-owner@example.test");
    const reader = ensureProfileForEmail("policy-suggestion-reader@example.test");
    const requestClient = client(reader.id, "Reader");
    requestClient.connect.scopes = ["operator.sessions.read"];
    const runtime = roleConfig("write", ["operator.sessions.read"]);
    let committed = roleConfig("view", ["operator.sessions.read"]);
    await state.writeConfig(runtime);
    setRuntimeConfigSnapshot(runtime);
    await seedIdeas(
      { "own-idea": reader.id, "other-idea": owner.id },
      {
        sessionId: "policy-suggestions",
        createdActor: { type: "human", source: "profile", id: owner.id },
      },
    );
    const requestContext = createDirectChatContext({
      getRuntimeConfig: () => runtime,
      getCommittedRuntimeConfig: () => committed,
    });
    await initializeSessionReadContext(requestContext);
    prepareGatewayRecipientProfile(requestClient);
    for (const phase of ["tentative", "committed"] as const) {
      if (phase === "committed") {
        committed = runtime;
      }
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: phase,
          method: "session.suggestions.list",
          params: { sessionKey },
        },
        client: requestClient,
        context: requestContext,
        respond,
        isWebchatConnect: () => true,
        extraHandlers: sessionSuggestionHandlers,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        role: phase === "tentative" ? "viewer" : "member",
        suggestions:
          phase === "tentative"
            ? [expect.objectContaining({ id: "own-idea" })]
            : expect.arrayContaining([
                expect.objectContaining({ id: "own-idea" }),
                expect.objectContaining({ id: "other-idea" }),
              ]),
      });
    }
  }));

it("enforces view, suggest, and hidden role ceilings while honoring explicit membership", () =>
  withState(async () => {
    const ownerProfile = ensureProfileForEmail("suggestion-owner@example.test");
    const guestProfile = ensureProfileForEmail("suggestion-guest@example.test");
    await upsertDefaultSuggestionSession({
      createdActor: { type: "human", source: "profile", id: ownerProfile.id },
    });
    const guest = client(guestProfile.id, "Guest");
    const request = (others: Parameters<typeof roleConfig>[0], list = false) => {
      const cfg = roleConfig(others);
      setRuntimeConfigSnapshot(cfg);
      return call(
        list ? "session.suggestions.list" : "session.suggestions.add",
        { sessionKey, ...(list ? {} : { text: "guest suggestion" }) },
        guest,
        context(vi.fn(), cfg),
      );
    };
    const denied = await request("view");
    expect(denied.responses[0]?.[2]).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("viewing sessions only"),
    });

    const hidden = await request("none", true);
    expect(hidden.responses[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: `unknown session: ${sessionKey}`,
    });

    expect((await request("suggest")).responses[0]?.[0]).toBe(true);

    addSessionMember(
      { agentId: "main", sessionKey },
      {
        identityId: guestProfile.id,
        addedBy: ownerProfile.id,
        expectedSessionId: "session-main",
      },
    );
    expect((await request("view")).responses[0]?.[0]).toBe(true);
  }));

it.each(["draft", "incognito"] as const)("enforces %s suggestion and typing privacy", (mode) =>
  withState(async () => {
    const incognito = mode === "incognito";
    if (incognito) {
      vi.useFakeTimers();
    }
    const key = incognito
      ? "agent:main:dashboard:incognito-suggestions"
      : "agent:main:draft-suggestions";
    const sessionId = `session-${mode}`;
    const id = `${mode}-suggestion`;
    await seedIdeas(
      { [id]: incognito ? "owner" : "member" },
      {
        sessionId,
        visibility: incognito ? "suggest" : "draft",
        ...(incognito ? { incognito: true } : {}),
      },
      key,
    );
    if (!incognito) {
      addSessionMember(
        { agentId: "main", sessionKey: key },
        { identityId: "member", addedBy: "owner", expectedSessionId: sessionId },
      );
    }
    const request = requests(
      key,
      incognito ? client("owner", "Owner") : client("member", "Member"),
    );
    const expectHidden = (result: Awaited<ReturnType<typeof call>>) => {
      expect(result.responses[0]).toMatchObject([
        false,
        undefined,
        incognito
          ? { message: `Incognito session "${key}" was not found.` }
          : {
              message: "session is draft for this connection",
              details: {
                code: "SESSION_PARTICIPATION_REQUIRED",
                sessionKey: key,
                visibility: "draft",
              },
            },
      ]);
    };
    expectHidden(await request("session.suggestions.list"));
    expectHidden(await request("session.suggestions.add", { text: "probe" }));
    expectHidden(await request("session.suggestions.resolve", { id, resolution: "dismiss" }));
    const typing = await request("session.typing", { sessionId, typing: true });
    if (incognito) {
      expectHidden(typing);
      expectHidden(await request("session.typing", { sessionId: "wrong-session", typing: true }));
    } else {
      expect(typing.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });
    }
    for (const role of incognito ? ["admin"] : ["owner", "admin"]) {
      const listed = await requests(
        key,
        client(role, role, role === "admin"),
      )("session.suggestions.list");
      expect(listed.responses[0]?.[1]).toMatchObject({ role, suggestions: [{ id, text: id }] });
    }
    if (!incognito) {
      return;
    }
    mocks.presence = ["admin", "other-admin"].map((profileId) => ({
      user: { id: profileId, identity: { type: "profile", id: profileId } },
      watchedSessions: [key],
    }));
    const broadcast = vi.fn();
    const adminRequest = requests(key, client("admin", "Admin", true), context(broadcast));
    const typeDraft = async (preview: string, sent: boolean) => {
      const result = await adminRequest("session.typing", { sessionId, typing: true, preview });
      expect(result.responses[0]?.[1]).toEqual({ ok: true, broadcast: sent });
    };
    await typeDraft("first private draft", true);
    await vi.advanceTimersByTimeAsync(100);
    await typeDraft("latest private draft", false);
    await vi.advanceTimersByTimeAsync(150);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.lastCall?.[1]).toMatchObject({
      sessionKey: key,
      sessionId,
      preview: "latest private draft",
    });
  }),
);
it.each([
  ["directory-alias", "send"],
  ["incognito", "queue"],
] as const)("dispatches a %s suggestion with %s through its original store", (layout, resolution) =>
  withState(async (state) => {
    const agentId = "ops";
    const incognito = layout === "incognito";
    const key = incognito
      ? "agent:ops:dashboard:incognito-suggestions-binding"
      : "agent:ops:aliased-suggestions";
    const physicalStorePath = incognito
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })
      : state.statePath("original", "session.sqlite");
    const scope = { agentId, sessionKey: key, storePath: physicalStorePath, env: state.env };
    const sessionId = "session-store-binding";
    const aliasStorePath = state.statePath("selected", "session.sqlite");
    const cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId } },
        entries: { ops: {} },
      },
      ...(!incognito ? { session: { store: aliasStorePath } } : {}),
    };
    setRuntimeConfigSnapshot(cfg);
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
      createdActor: { type: "human", source: "profile", id: "owner" },
      visibility: "suggest",
    });
    if (!incognito) {
      const nativeTarget = resolveSqliteTargetFromSessionStorePath(physicalStorePath, scope);
      await closeOpenClawAgentDatabaseByPathAsync(nativeTarget.path, nativeTarget.agentId);
      symlinkSync(state.statePath("original"), state.statePath("selected"), "junction");
      // Gateway startup registers its writable store before capturing request authority.
      const aliasTarget = resolveSqliteTargetFromSessionStorePath(aliasStorePath, scope);
      if (!aliasTarget.agentId) {
        throw new Error("expected the seeded alias database owner");
      }
      openOpenClawAgentDatabase({
        agentId: aliasTarget.agentId,
        path: aliasTarget.path,
        env: state.env,
      });
    }
    await state.writeConfig(cfg);
    const requestContext = context(vi.fn(), cfg);
    const request = requests(key, client("owner", "Owner", incognito), requestContext, {
      agentId,
    });
    const added = await request("session.suggestions.add", { text: "Store-bound suggestion" });
    expect(added.responses[0]).toMatchObject([
      true,
      { suggestion: { sessionKey: key, agentId, state: "pending" } },
    ]);
    const id = responseSuggestionId(added);
    const listed = await request("session.suggestions.list");
    expect(listed.responses).toEqual([
      [
        true,
        {
          role: incognito ? "admin" : "owner",
          suggestions: [expect.objectContaining({ id, sessionKey: key, agentId })],
        },
      ],
    ]);
    await withReadySessionRows(
      requireSessionRowProjection(requestContext),
      () => [{ key, agentId }],
      (read) => {
        const row = read.describe({ key, agentId });
        if (!row) {
          throw new Error("expected the original suggestion row");
        }
        if (incognito) {
          expect(row.storeTarget.storePath).toBe(physicalStorePath);
          expect(read.readSource(row)).toBeUndefined();
        } else {
          expect(row.storeTarget.storePath).toBe(aliasStorePath);
          expect(read.readSource(row)?.path).toBe(realpathSync(physicalStorePath));
          expect(read.readSource(row)?.path).not.toBe(row.storeTarget.storePath);
        }
      },
    );

    const resolved = await request("session.suggestions.resolve", { id, resolution });
    expect(resolved.responses).toMatchObject([
      [true, { suggestion: { id, sessionKey: key, agentId, state: "accepted" } }],
    ]);
    expect(mocks.handleChatSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: expect.objectContaining({
          sessionKey: key,
          sessionId,
          agentId,
          queueMode: resolution === "queue" ? "followup" : "steer",
          idempotencyKey: `session-suggestion:${id}`,
        }),
      }),
    );
    expect(await listSessionSuggestions(scope)).toEqual([
      expect.objectContaining({ id, state: "accepted" }),
    ]);
  }),
);
it.for(["add", "edit", "dismiss", "queue"] as const)(
  "preserves the lifecycle boundary for %s without replacing the session",
  (action, { signal }) =>
    withState(async (state) => {
      const metadataWrites = await import("../../config/sessions/session-metadata-write.async.js");
      const scope = { agentId: "main", sessionKey, env: state.env };
      openOpenClawStateDatabase({ env: state.env });
      const scheduled = observeSqliteWalPeriodicWork();
      const database = (() => {
        try {
          return openOpenClawAgentDatabase(scope);
        } finally {
          scheduled.restore();
        }
      })();
      const originalEntry = {
        sessionId: "provider-review-suggestion",
        lifecycleRevision: "provider-review-generation",
      };
      const id = "queued-provider-review-suggestion";
      await seedIdeas(action === "add" ? {} : { [id]: "owner" }, originalEntry);
      const options = { ...scope, path: database.path };
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      await initializeSessionReadContext(requestContext);
      const release = createDeferred();
      const metadataQueued = createDeferred();
      let blocker: Promise<void> | undefined;
      let maintenance: Promise<unknown> | undefined;
      let review: ReturnType<typeof compareSessionProviderReview> | undefined;
      let request: ReturnType<typeof call> | undefined;
      const providerReview: SessionProviderReview = {
        id: "queued-provider-review",
        sessionId: originalEntry.sessionId,
        runId: "paused-provider-run",
        provider: "openai",
        model: "test-model",
        runtimeId: "openclaw",
      };
      const queueReviewBeforeNextWrite = async () => {
        const entered = createDeferred();
        blocker = agentWriteAdmission.runOpenClawAgentWorkerWrite(options, async () => {
          entered.resolve();
          await release.promise;
        });
        await withinTest(entered.promise, signal);
        const reviewQueued = createDeferred();
        // Target discovery yields before review admission; unrelated writers are not this gate.
        const reviewScope = new AsyncLocalStorage<boolean>();
        const enqueueWrite = agentWriteAdmission.runOpenClawAgentWorkerWrite;
        const observeReview = vi
          .spyOn(agentWriteAdmission, "runOpenClawAgentWorkerWrite")
          .mockImplementation((...args) => {
            const pending = enqueueWrite(...args);
            if (reviewScope.getStore()) {
              reviewQueued.resolve();
            }
            return pending;
          });
        try {
          // A real maintenance writer must not release the review-specific queue barrier.
          maintenance = Promise.resolve(scheduled.periodic());
          review = reviewScope.run(true, () =>
            compareSessionProviderReview(
              {
                ...scope,
                ...originalEntry,
                storePath: database.path,
              },
              {
                expectedReview: undefined,
                nextReview: providerReview,
                assertCurrent: () => signal.throwIfAborted(),
              },
            ),
          );
          await withinTest(
            awaitGateBeforeSettlement(
              reviewQueued.promise,
              review,
              "provider review finished before its writer entered the queue",
            ),
            signal,
          );
        } finally {
          observeReview.mockRestore();
          reviewScope.disable();
        }
      };
      if (action === "add") {
        const add = metadataWrites.addSessionSuggestionInWorker;
        vi.spyOn(metadataWrites, "addSessionSuggestionInWorker").mockImplementation(
          async (...args) => {
            // Capture lifecycle facts before introducing the preceding writer.
            await queueReviewBeforeNextWrite();
            const pending = add(...args);
            metadataQueued.resolve();
            return pending;
          },
        );
      } else {
        const finalize = metadataWrites.finalizeSessionSuggestionClaimInWorker;
        vi.spyOn(metadataWrites, "finalizeSessionSuggestionClaimInWorker").mockImplementation(
          (...args) => {
            const pending = finalize(...args);
            metadataQueued.resolve();
            return pending;
          },
        );
        if (action === "edit" || action === "dismiss") {
          mocks.afterSuggestionClaim.mockImplementationOnce(queueReviewBeforeNextWrite);
        } else {
          mocks.handleChatSend.mockImplementationOnce(
            async ({ respond }: { respond: RespondFn }) => {
              respond(true, { runId: `session-suggestion:${id}`, status: "started" });
              await queueReviewBeforeNextWrite();
            },
          );
        }
      }
      try {
        request = call(
          action === "add" ? "session.suggestions.add" : "session.suggestions.resolve",
          action === "add"
            ? { sessionKey, text: "Synthetic suggestion" }
            : { sessionKey, id, resolution: action },
          client("owner", "Owner"),
          requestContext,
        );
        await withinTest(
          awaitGateBeforeSettlement(
            metadataQueued.promise,
            request.then((result) => {
              if (!result.responses.some(([ok]) => ok)) {
                throw new Error(
                  `suggestion failed before its metadata writer entered the queue: ${JSON.stringify(result.responses)}`,
                );
              }
              return result;
            }),
            "suggestion finished before its metadata writer entered the queue",
          ),
          signal,
        );
        expect(loadSessionEntry(scope)?.providerReview).toBeUndefined();
        release.resolve();
        const [result, paused] = await withinTest(Promise.all([request, review!]), signal);
        expect(paused.providerReview).toEqual(providerReview);
        expect(loadSessionEntry(scope)).toMatchObject({ ...originalEntry, providerReview });
        const rejected = action === "add" || action === "edit";
        expect(result.responses).toMatchObject([
          rejected
            ? [false, undefined, { message: expect.stringContaining("paused as a precaution") }]
            : [
                true,
                { suggestion: { id, state: action === "dismiss" ? "dismissed" : "accepted" } },
              ],
        ]);
        if (rejected) {
          expect(broadcast).not.toHaveBeenCalled();
        }
        if (action === "add") {
          expect(await listSessionSuggestions(scope)).toEqual([]);
        } else {
          expect(
            database.db
              .prepare("SELECT state, dispatch_token FROM session_suggestions WHERE id = ?")
              .get(id),
          ).toEqual({
            state: action === "edit" ? "pending" : action === "dismiss" ? "dismissed" : "accepted",
            dispatch_token: null,
          });
        }
        expect(mocks.handleChatSend).toHaveBeenCalledTimes(action === "queue" ? 1 : 0);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, review, request, maintenance]);
      }
    }),
);
