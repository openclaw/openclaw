import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, symlinkSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
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
import { addSessionSuggestion } from "../../config/sessions/session-suggestion-store.js";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
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
  responseSuggestionId,
  sessionKey,
  upsertDefaultSuggestionSession,
} from "./sessions-suggestions.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);
beforeEach(() => mocks.afterSuggestionClaim.mockReset());
// Register shared mocks before the handlers capture their presence dependency.
const { sessionSuggestionHandlers } = await import("./sessions-suggestions.js");

describe("session suggestion visibility and role ceilings", () => {
  it.each(["policy", "profile", "disconnect", "session", "membership", "projection"] as const)(
    "rechecks %s after a delayed suggestion list reply",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertDefaultSuggestionSession();
        for (const authorId of ["alice", "bob"]) {
          addSessionSuggestion(
            { agentId: "main", sessionKey },
            { id: authorId, authorId, text: authorId },
          );
        }
        const policy = (others: "view" | "write"): OpenClawConfig => ({
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others },
                },
              },
            },
          },
        });
        let committed = policy(change === "membership" ? "view" : "write");
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
            committed = policy("view");
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
            expect(result.responses).toHaveLength(1);
            expect(result.responses[0]).toMatchObject(
              change === "policy" || change === "membership"
                ? [
                    true,
                    { role: "viewer", suggestions: [expect.objectContaining({ id: "alice" })] },
                  ]
                : [false, undefined, { code: "FORBIDDEN" }],
            );
          }
        } finally {
          release.resolve();
          await outcome;
        }
      });
    },
  );

  it("retains committed suggestion visibility through a tentative role relaxation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const owner = ensureProfileForEmail("policy-suggestion-owner@example.test");
      const reader = ensureProfileForEmail("policy-suggestion-reader@example.test");
      const requestClient = client(reader.id, "Reader");
      requestClient.connect.scopes = ["operator.sessions.read"];
      prepareGatewayRecipientProfile(requestClient);
      const policy = (others: "view" | "write"): OpenClawConfig => ({
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { scopes: ["operator.sessions.read"], agents: "*", sessions: { others } },
            },
          },
        },
      });
      const runtime = policy("write");
      let committed = policy("view");
      await state.writeConfig(runtime);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "policy-suggestions",
          updatedAt: 1,
          visibility: "suggest",
          createdActor: { type: "human", source: "profile", id: owner.id },
        },
      );
      for (const [id, authorId] of [
        ["own-idea", reader.id],
        ["other-idea", owner.id],
      ] as const) {
        addSessionSuggestion(
          { agentId: "main", sessionKey },
          {
            id,
            authorId,
            text: id,
            expectedSessionId: "policy-suggestions",
          },
        );
      }
      const requestContext = createDirectChatContext({
        getRuntimeConfig: () => runtime,
        getCommittedRuntimeConfig: () => committed,
      });
      await initializeSessionReadContext(requestContext);
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
    });
  });

  it("enforces view, suggest, and hidden role ceilings while honoring explicit membership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const ownerProfile = ensureProfileForEmail("suggestion-owner@example.test");
      const guestProfile = ensureProfileForEmail("suggestion-guest@example.test");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: ownerProfile.id },
          visibility: "suggest",
        },
      );
      const guest = client(guestProfile.id, "Guest");
      const roleConfig = (others: "none" | "view" | "suggest"): OpenClawConfig => ({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      });

      const denied = await call(
        "session.suggestions.add",
        { sessionKey, text: "view-only suggestion" },
        guest,
        context(vi.fn(), roleConfig("view")),
      );
      expect(denied.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("viewing sessions only"),
      });

      const hidden = await call(
        "session.suggestions.list",
        { sessionKey },
        guest,
        context(vi.fn(), roleConfig("none")),
      );
      expect(hidden.responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: `unknown session: ${sessionKey}`,
      });

      const suggested = await call(
        "session.suggestions.add",
        { sessionKey, text: "permitted suggestion" },
        guest,
        context(vi.fn(), roleConfig("suggest")),
      );
      expect(suggested.responses[0]?.[0]).toBe(true);

      addSessionMember(
        { agentId: "main", sessionKey },
        {
          identityId: guestProfile.id,
          addedBy: ownerProfile.id,
          expectedSessionId: "session-main",
        },
      );
      const invited = await call(
        "session.suggestions.add",
        { sessionKey, text: "explicitly invited member" },
        guest,
        context(vi.fn(), roleConfig("view")),
      );
      expect(invited.responses[0]?.[0]).toBe(true);
    });
  });

  it("hides draft suggestions from members while owner and admin can list", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const draftKey = "agent:main:draft-suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: draftKey },
        {
          sessionId: "session-draft",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "draft",
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey: draftKey },
        { identityId: "member", addedBy: "owner", expectedSessionId: "session-draft" },
      );
      addSessionSuggestion(
        { agentId: "main", sessionKey: draftKey },
        {
          id: "draft-suggestion",
          authorId: "member",
          text: "private draft suggestion",
          expectedSessionId: "session-draft",
        },
      );

      const member = client("member", "Member");
      const expectHiddenDraft = (result: Awaited<ReturnType<typeof call>>) => {
        expect(result.responses[0]?.[0]).toBe(false);
        expect(result.responses[0]?.[1]).toBeUndefined();
        expect(result.responses[0]?.[2]).toMatchObject({
          message: "session is draft for this connection",
          details: {
            code: "SESSION_PARTICIPATION_REQUIRED",
            sessionKey: draftKey,
            visibility: "draft",
          },
        });
      };

      expectHiddenDraft(await call("session.suggestions.list", { sessionKey: draftKey }, member));
      expectHiddenDraft(
        await call("session.suggestions.add", { sessionKey: draftKey, text: "leak draft" }, member),
      );
      expectHiddenDraft(
        await call(
          "session.suggestions.resolve",
          { sessionKey: draftKey, id: "draft-suggestion", resolution: "dismiss" },
          member,
        ),
      );
      expect(
        (
          await call(
            "session.typing",
            { sessionKey: draftKey, sessionId: "session-draft", typing: true },
            member,
          )
        ).responses[0]?.[1],
      ).toEqual({ ok: true, broadcast: false });

      const ownerList = await call(
        "session.suggestions.list",
        { sessionKey: draftKey },
        client("owner", "Owner"),
      );
      expect(ownerList.responses[0]?.[1]).toMatchObject({
        role: "owner",
        suggestions: [{ id: "draft-suggestion", text: "private draft suggestion" }],
      });
      const adminList = await call(
        "session.suggestions.list",
        { sessionKey: draftKey },
        client("admin", "Admin", true),
      );
      expect(adminList.responses[0]?.[1]).toMatchObject({
        role: "admin",
        suggestions: [{ id: "draft-suggestion", text: "private draft suggestion" }],
      });
    });
  });

  it("keeps incognito suggestion and typing surfaces admin-only", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      const incognitoKey = "agent:main:dashboard:incognito-suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: incognitoKey },
        {
          sessionId: "session-incognito",
          updatedAt: 1,
          incognito: true,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
      await addSessionSuggestionInWorker(
        { agentId: "main", sessionKey: incognitoKey },
        {
          id: "incognito-suggestion",
          authorId: "owner",
          text: "private suggestion",
          expectedSessionId: "session-incognito",
        },
      );
      const owner = client("owner", "Owner");
      const expectHidden = (result: Awaited<ReturnType<typeof call>>) => {
        expect(result.responses[0]?.[0]).toBe(false);
        expect(result.responses[0]?.[1]).toBeUndefined();
        expect(result.responses[0]?.[2]?.message).toBe(
          `Incognito session "${incognitoKey}" was not found.`,
        );
      };

      expectHidden(await call("session.suggestions.list", { sessionKey: incognitoKey }, owner));
      expectHidden(
        await call("session.suggestions.add", { sessionKey: incognitoKey, text: "probe" }, owner),
      );
      expectHidden(
        await call(
          "session.suggestions.resolve",
          { sessionKey: incognitoKey, id: "incognito-suggestion", resolution: "dismiss" },
          owner,
        ),
      );
      expectHidden(
        await call(
          "session.typing",
          { sessionKey: incognitoKey, sessionId: "wrong-session", typing: true },
          owner,
        ),
      );
      expectHidden(
        await call(
          "session.typing",
          { sessionKey: incognitoKey, sessionId: "session-incognito", typing: true },
          owner,
        ),
      );

      const adminList = await call(
        "session.suggestions.list",
        { sessionKey: incognitoKey },
        client("admin", "Admin", true),
      );
      expect(adminList.responses[0]?.[1]).toMatchObject({
        role: "admin",
        suggestions: [{ id: "incognito-suggestion", text: "private suggestion" }],
      });

      mocks.presence = ["admin", "other-admin"].map((id) => ({
        user: { id, identity: { type: "profile", id } },
        watchedSessions: [incognitoKey],
      }));
      const broadcast = vi.fn();
      const typingContext = context(broadcast);
      const admin = client("admin", "Admin", true);
      const typeDraft = (preview: string) =>
        call(
          "session.typing",
          { sessionKey: incognitoKey, sessionId: "session-incognito", typing: true, preview },
          admin,
          typingContext,
        );
      expect((await typeDraft("first private draft")).responses[0]?.[1]).toEqual({
        ok: true,
        broadcast: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect((await typeDraft("latest private draft")).responses[0]?.[1]).toEqual({
        ok: true,
        broadcast: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast).toHaveBeenCalledTimes(2);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({
        sessionKey: incognitoKey,
        sessionId: "session-incognito",
        preview: "latest private draft",
      });
    });
  });
});

describe("session suggestion store binding", () => {
  it.each([
    ["directory-alias", "send"],
    ["incognito", "queue"],
  ] as const)(
    "dispatches a %s suggestion with %s through its original store",
    async (layout, resolution) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1,
          ...(incognito ? { incognito: true } : {}),
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        });
        const cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId } },
            entries: { ops: {} },
          },
        };
        const aliasStorePath = state.statePath("selected", "session.sqlite");
        if (!incognito) {
          const nativeTarget = resolveSqliteTargetFromSessionStorePath(physicalStorePath, scope);
          await closeOpenClawAgentDatabaseByPathAsync(nativeTarget.path, nativeTarget.agentId);
          symlinkSync(state.statePath("original"), state.statePath("selected"), "junction");
          cfg.session = { store: aliasStorePath };
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
        const requester = client("owner", "Owner", incognito);
        const added = await call(
          "session.suggestions.add",
          { sessionKey: key, agentId, text: "Keep this suggestion bound to its original store." },
          requester,
          requestContext,
        );
        expect(added.responses[0]).toMatchObject([
          true,
          { suggestion: { sessionKey: key, agentId, state: "pending" } },
        ]);
        const id = responseSuggestionId(added);
        const listed = await call(
          "session.suggestions.list",
          { sessionKey: key, agentId },
          requester,
          requestContext,
        );
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
            expect(row).toBeDefined();
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

        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey: key, agentId, id, resolution },
          requester,
          requestContext,
        );

        expect(resolved.responses).toHaveLength(1);
        expect(resolved.responses[0]).toMatchObject([
          true,
          { suggestion: { id, sessionKey: key, agentId, state: "accepted" } },
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
      });
    },
  );
});

describe("suggestions queued behind provider review", () => {
  it.for(["add", "edit", "dismiss", "queue"] as const)(
    "preserves the lifecycle boundary for %s without replacing the session",
    async (action, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const metadataWrites =
          await import("../../config/sessions/session-metadata-write.async.js");
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
        const periodic = scheduled.periodic;
        await upsertSessionEntryCore(scope, {
          sessionId: "provider-review-suggestion",
          lifecycleRevision: "provider-review-generation",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        });
        const originalEntry = loadSessionEntry(scope)!;
        const originalSessionId = originalEntry.sessionId;
        if (!originalSessionId) {
          throw new Error("expected a seeded suggestion session");
        }
        const options = { ...scope, path: database.path };
        const id = "queued-provider-review-suggestion";
        if (action !== "add") {
          addSessionSuggestion(scope, { id, authorId: "owner", text: "Synthetic suggestion" });
        }
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
          sessionId: originalSessionId,
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
            maintenance = Promise.resolve(periodic());
            review = reviewScope.run(true, () =>
              compareSessionProviderReview(
                {
                  ...scope,
                  storePath: database.path,
                  sessionId: originalSessionId,
                  lifecycleRevision: originalEntry.lifecycleRevision,
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
              request,
              "suggestion finished before its metadata writer entered the queue",
            ),
            signal,
          );
          expect(loadSessionEntry(scope)?.providerReview).toBeUndefined();
          release.resolve();
          const [result, paused] = await withinTest(Promise.all([request, review!]), signal);
          expect(paused.providerReview).toEqual(providerReview);
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: originalEntry.sessionId,
            lifecycleRevision: originalEntry.lifecycleRevision,
            providerReview,
          });
          expect(result.responses).toHaveLength(1);
          const rejected = action === "add" || action === "edit";
          if (rejected) {
            expect(result.responses[0]).toMatchObject([
              false,
              undefined,
              { message: expect.stringContaining("paused as a precaution") },
            ]);
            expect(broadcast).not.toHaveBeenCalled();
          } else {
            expect(result.responses[0]).toMatchObject([
              true,
              { suggestion: { id, state: action === "dismiss" ? "dismissed" : "accepted" } },
            ]);
          }
          if (action === "add") {
            expect(await listSessionSuggestions(scope)).toEqual([]);
          } else {
            expect(
              database.db
                .prepare("SELECT state, dispatch_token FROM session_suggestions WHERE id = ?")
                .get(id),
            ).toEqual({
              state:
                action === "edit" ? "pending" : action === "dismiss" ? "dismissed" : "accepted",
              dispatch_token: null,
            });
          }
          expect(mocks.handleChatSend).toHaveBeenCalledTimes(action === "queue" ? 1 : 0);
        } finally {
          release.resolve();
          await Promise.allSettled([blocker, review, request, maintenance]);
        }
      });
    },
  );
});
