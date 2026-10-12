import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import * as chatSend from "./server-methods/chat-send-handler.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { withSessionMutationCommitGuard } from "./server-methods/session-mutation-guards.js";
import { sessionDeleteHandlers } from "./server-methods/sessions-delete.js";
import { sessionGoalHandlers } from "./server-methods/sessions-goal.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { sessionSuggestionHandlers } from "./server-methods/sessions-suggestions.js";
import { skillsLibraryHandlers } from "./server-methods/skills-library.js";
import { taskSuggestionsHandlers } from "./server-methods/task-suggestions.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import { createSessionCompanion } from "./session-companion.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const cfg = { agents: { entries: { main: {} } } };
let client: GatewayClient;
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
const context = {
  getRuntimeConfig: () => cfg,
  getCommittedRuntimeConfig: () => cfg,
  broadcast: vi.fn(),
  broadcastToConnIds: vi.fn(),
  getSessionEventSubscriberConnIds: () => new Set<string>(),
  chatAbortControllers: new Map(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: dirs.make("incognito-controls-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  actor = await openIncognitoTestActor(env, authority);
  const profile = ensureProfileForEmail("private-control@example.test");
  client = {
    ...sharingPolicyClient({ user: profile.id, scopes: ["operator.admin"] }),
    connId: "private-control",
  };
});
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR));
afterAll(async () => {
  await flushPendingSessionsChangedEvents();
  await actor?.close();
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
});

async function invoke(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  const handler = handlers[method];
  assert(handler);
  await handler({
    req: { type: "req", id: "control-test", method, params },
    params,
    context,
    client,
    isWebchatConnect: () => true,
    respond,
  });
  return respond;
}

it("returns the actor Goal receipt on retry and serves suggestion mutations without host SQL", async () => {
  const sessionKey = "agent:main:dashboard:incognito-controls";
  const sessionId = "controls";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId,
      updatedAt: 1,
      incognito: true,
      lifecycleRevision: "first",
      visibility: "suggest",
      goal: {
        schemaVersion: 1,
        id: "goal",
        objective: "Before",
        status: "paused",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    },
  });
  await initializeSessionReadContext(context);
  const host = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const request = {
        sessionKey,
        agentId: "main",
        sessionId,
        goalId: "goal",
        action: "edit",
        objective: "After",
        operationId: "edit-once",
        issuedAtMs: Date.now(),
      };
      const first = await invoke(sessionGoalHandlers, "sessions.goal.update", request);
      expect(first).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ goal: expect.objectContaining({ objective: "After" }) }),
        undefined,
      );
      const replay = await invoke(sessionGoalHandlers, "sessions.goal.update", request);
      expect(replay).toHaveBeenCalledWith(
        true,
        { ...(first.mock.calls[0]![1] as object), replayed: true },
        undefined,
      );
      // The captured physical source must survive an ambient root change before dispatch.
      vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("incognito-controls-other-root-"));
      let added: Awaited<ReturnType<typeof invoke>>;
      try {
        added = await invoke(sessionSuggestionHandlers, "session.suggestions.add", {
          sessionKey,
          text: "Check this",
        });
      } finally {
        vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      }
      expect(added).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ suggestion: expect.objectContaining({ text: "Check this" }) }),
      );
      const suggestion = (added.mock.calls[0]![1] as { suggestion: { id: string } }).suggestion;
      const listed = await invoke(sessionSuggestionHandlers, "session.suggestions.list", {
        sessionKey,
      });
      expect(listed).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ suggestions: [expect.objectContaining({ id: suggestion.id })] }),
      );
      const dismissed = await invoke(sessionSuggestionHandlers, "session.suggestions.resolve", {
        sessionKey,
        id: suggestion.id,
        resolution: "dismiss",
      });
      expect(dismissed).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ suggestion: expect.objectContaining({ state: "dismissed" }) }),
      );
    });
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
});

it("retains an actor Side chat source while writing its separate durable destination and refuses replacement", async () => {
  const sessionKey = "agent:main:dashboard:incognito-side-chat";
  const sessionId = "side-chat-source";
  const entry = { sessionId, updatedAt: 1, lifecycleRevision: "first", incognito: true as const };
  await actor.sessions.create(authority, { sessionKey, entry });
  await actor.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey,
      sessionId,
      fence: {},
      message: { role: "user", content: "Original private context", timestamp: 1 },
    },
  });
  const destination = { agentId: "main", sessionKey: "agent:main:companion-destination" };
  await upsertSessionEntryCore(destination, {
    sessionId: "durable-destination",
    updatedAt: 1,
    label: "Before",
  });
  let pause = false;
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const run = vi.fn(
    async (
      request: Parameters<NonNullable<Parameters<typeof createSessionCompanion>[0]["run"]>>[0],
    ) => {
      expect(JSON.stringify(request.messages)).toContain("Original private context");
      if (pause) {
        entered.resolve();
        await resume.promise;
      }
      request.assertSourceCurrent?.();
      await patchSessionEntryCore(destination, () => ({ label: "After" }), {
        workerGuard: { source: request.assertSourceCurrent },
      });
      return "Answer";
    },
  );
  const companion = createSessionCompanion({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    contextReader: defaultSessionCompanionContextReader,
    sessionObserver: { getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }) },
    resolveUtilityModelRef: () => "test/model",
    run,
    now: () => 10,
  });
  context.sessionCompanion = companion;
  try {
    await withIncognitoSessionActor(actor, async () => {
      const first = await invoke(sessionCompanionHandlers, "sessions.companion.ask", {
        sessionKey,
        question: "Summarize",
      });
      expect(first.mock.calls).toEqual([[true, { answer: "Answer", ts: 10 }]]);
      pause = true;
      const pending = invoke(sessionCompanionHandlers, "sessions.companion.ask", {
        sessionKey,
        question: "Again",
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Side chat returned before model execution",
        );
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath: actor.path },
          { ...entry, lifecycleRevision: "replacement" },
        );
      } finally {
        resume.resolve();
      }
      const rejected = await pending;
      expect(rejected).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    });
    expect(loadSessionEntry(destination)?.label).toBe("After");
  } finally {
    resume.resolve();
    companion.dispose();
    context.sessionCompanion = undefined;
  }
});

it("attaches actor skill pins for the next turn and refuses a detached revision", async () => {
  const sessionKey = "agent:main:dashboard:incognito-skills";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "skills", updatedAt: 1, incognito: true },
  });
  const saved = await invoke(skillsLibraryHandlers, "skills.library.save", {
    slug: "actor-skill",
    content: "---\nname: actor-skill\ndescription: Synthetic skill\n---\n# Actor skill\n",
    expectedRevision: null,
  });
  expect(saved.mock.calls).toEqual([
    [
      true,
      expect.objectContaining({ entry: expect.objectContaining({ skillId: expect.any(String) }) }),
      undefined,
    ],
  ]);
  const entry = (saved.mock.calls[0]![1] as { entry: { skillId: string; revision: string } }).entry;
  await withIncognitoSessionActor(actor, async () => {
    const attached = await invoke(skillsLibraryHandlers, "skills.library.activate", {
      sessionKey,
      skillId: entry.skillId,
      action: "attach",
    });
    expect(attached).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionActivation: "next-turn",
        selections: [expect.objectContaining({ skillId: entry.skillId, revision: entry.revision })],
      }),
      undefined,
    );
    const listed = await invoke(skillsLibraryHandlers, "skills.library.list", { sessionKey });
    expect(listed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        session: expect.objectContaining({
          selections: [expect.objectContaining({ skillId: entry.skillId })],
        }),
      }),
      undefined,
    );
    const detached = await invoke(skillsLibraryHandlers, "skills.library.activate", {
      sessionKey,
      skillId: entry.skillId,
      action: "detach",
    });
    expect(detached.mock.calls).toEqual([
      [true, expect.objectContaining({ selections: [] }), undefined],
    ]);
    const denied = await invoke(skillsLibraryHandlers, "skills.library.read", {
      sessionKey,
      skillId: entry.skillId,
      revision: entry.revision,
    });
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ details: { code: "SKILL_LIBRARY_FORBIDDEN" } }),
    );
  });
});

it("restores a refused actor task suggestion and retains accepted chat authority after its ACK", async () => {
  const sessionKey = "agent:main:dashboard:incognito-task-rollback";
  const entry = {
    sessionId: "task-rollback",
    updatedAt: 1,
    lifecycleRevision: "first",
    incognito: true as const,
  };
  await actor.sessions.create(authority, { sessionKey, entry });
  const originalActors = captureOpenClawAgentDatabaseExecution
    .listIncognito(env)
    .map((owner) => owner.identity.incarnation);
  let refuse = true;
  let acceptedAuthority: SessionMutationAuthorization | undefined;
  const delivery = vi.spyOn(chatSend, "handleChatSend").mockImplementation(async (options) => {
    const resolved = options.sessionMutationAuthorization
      ? { authorization: options.sessionMutationAuthorization, error: null }
      : resolveSessionMutationAuthorization({
          client: options.client,
          context: options.context,
          method: "chat.send",
          requestParams: options.params,
        });
    assert(!resolved.error);
    const chatAuthority = withSessionMutationCommitGuard(
      resolved.authorization,
      options.sessionMutationCommitGuard,
      undefined,
    );
    assert(chatAuthority);
    const prepared = await prepareSessionSourceAuthority(chatAuthority.assertCurrent);
    try {
      prepared.assertCurrent();
      if (refuse) {
        options.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "delivery refused before admission",
        });
      } else {
        acceptedAuthority = chatAuthority;
        options.respond(true, { runId: "accepted-task", status: "started" });
      }
    } finally {
      await prepared.release?.();
    }
  });
  const deletion = vi.spyOn(sessionDeleteHandlers, "sessions.delete");
  const host = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const created = await invoke(taskSuggestionsHandlers, "taskSuggestions.create", {
        title: "Follow up",
        prompt: "Continue the synthetic task",
        tldr: "Synthetic task",
        cwd: process.cwd(),
        sessionKey,
        agentId: "main",
      });
      expect(created.mock.calls).toEqual([
        [true, expect.objectContaining({ taskId: expect.any(String) }), undefined],
      ]);
      const taskId = (created.mock.calls[0]![1] as { taskId: string }).taskId;
      const rejected = await invoke(taskSuggestionsHandlers, "taskSuggestions.accept", {
        taskId,
        mode: "session",
      });
      expect(rejected.mock.calls).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({ message: "delivery refused before admission" }),
        ],
      ]);
      const restored = await invoke(taskSuggestionsHandlers, "taskSuggestions.list", {
        sessionKey,
      });
      expect(restored.mock.calls).toEqual([
        [true, { suggestions: [expect.objectContaining({ id: taskId })] }, undefined],
      ]);
      expect((await actor.sessions.read(authority, { sessionKey })).entry?.sessionId).toBe(
        entry.sessionId,
      );
      expect(deletion).not.toHaveBeenCalled();
      refuse = false;
      const accepted = await invoke(taskSuggestionsHandlers, "taskSuggestions.accept", {
        taskId,
        mode: "session",
      });
      expect(accepted.mock.calls).toEqual([[true, { taskId, key: sessionKey }, undefined]]);
      assert(acceptedAuthority);
      // Detached chat work prepares this same authority after the task RPC has acknowledged.
      const forwarded = await prepareSessionSourceAuthority(acceptedAuthority.assertCurrent);
      try {
        forwarded.assertCurrent();
      } finally {
        await forwarded.release?.();
      }
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: actor.path },
        { ...entry, lifecycleRevision: "replacement" },
      );
      expect(() => acceptedAuthority!.assertCurrent()).toThrow();
      expect(
        captureOpenClawAgentDatabaseExecution
          .listIncognito(env)
          .map((owner) => owner.identity.incarnation),
      ).toEqual(originalActors);
    });
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
    deletion.mockRestore();
    delivery.mockRestore();
  }
});
