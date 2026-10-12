import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi, onTestFinished } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionEntryAccessTarget,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createMentionInbox } from "./mention-inbox.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { waitForCreatedSessionRun } from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateTestHarness,
  dashboardTitleGenerationMocks,
  dashboardTitleScheduleMocks,
  chatSendOwner,
  actualDashboardTitleScheduler,
  requireNonEmptyString,
  withFixedOwnerSessionStore,
} from "./server.sessions.create.test-support.js";
import { sessionTitleRequests } from "./session-title-state.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";
import {
  dispatchInboundMessageMock,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  createCompactedSessionFixture,
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const {
  createSessionStoreDir,
  openClient,
  createSelectedGlobalSessionStore,
  resetConfiguredGlobalAgentSessionStore,
} = setupSessionCreateTestHarness();

test("sessions.create publishes repository metadata before the next socket read", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  const key = "agent:main:dashboard:repository-worker";
  try {
    const created = await rpcReq<{
      key: string;
      entry: { repositoryWorkspaceId: string };
    }>(ws, "sessions.create", {
      agentId: "main",
      key,
      repository: { url: "https://github.com/example/repository.git", ref: "main" },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const workspaceId = requireNonEmptyString(
      created.payload?.entry.repositoryWorkspaceId,
      "created repository workspace",
    );
    expect(created.payload?.key).toBe(key);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      repositoryWorkspaceId: workspaceId,
    });

    const listed = await rpcReq<{
      sessions: Array<{
        key: string;
        repositoryWorkspaceId?: string;
        repository?: { url: string; ref?: string; branch: string };
      }>;
    }>(ws, "sessions.list", { agentId: "main", limit: 100 });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject({
      repositoryWorkspaceId: workspaceId,
      repository: {
        url: "https://github.com/example/repository.git",
        ref: "main",
        branch: `openclaw/${workspaceId}`,
      },
    });
  } finally {
    ws.close();
  }
});

test("chat.send deletes a session before its pending dashboard title finishes", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  let deletionCleanup: Promise<unknown> | undefined;
  let titleCompletion: Promise<boolean> | undefined;
  let dispatchAdmissionsReleased: Promise<void> | undefined;
  const scheduleTitle = await actualDashboardTitleScheduler();
  dashboardTitleScheduleMocks.schedule.mockImplementationOnce((params, turn) => {
    // Wait for the real reply custody, independently of the pending metadata title.
    dispatchAdmissionsReleased = getSessionWorkAdmissionRelease({
      scope: params.storePath,
      identities: [params.sessionKey, params.admittedSessionId],
    });
    scheduleTitle(params, turn);
  });
  const dispatchStarted = createDeferredCore();
  const { promise: dispatchFinished, resolve: finishDispatch } = createDeferredCore();
  let finishTitle: (() => void) | undefined;
  const { promise: titleStarted, resolve: markTitleStarted } = createDeferredCore();
  dashboardTitleGenerationMocks.generate.mockImplementationOnce(async () => {
    markTitleStarted();
    await new Promise<void>((resolve) => {
      finishTitle = resolve;
    });
    return "Generated Dashboard Title";
  });
  dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
    const runId = requireNonEmptyString(replyOptions?.runId, "reply run id");
    replyOptions?.onAgentRunStart?.(runId);
    emitAgentEvent({ runId, stream: "assistant", data: { text: "Planning the release" } });
    dispatchStarted.resolve();
    await dispatchFinished;
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    return {
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    };
  });
  try {
    const created = await rpcReq<{ key: string; sessionId: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "agent:main:dashboard:title-order",
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "created session key");

    const sent = await rpcReq(ws, "chat.send", {
      sessionKey,
      message: "Help me plan the release",
      idempotencyKey: "post-dispatch-dashboard-title",
    });
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    await Promise.all([dispatchStarted.promise, titleStarted]);
    titleCompletion = sessionTitleRequests.get({
      storePath,
      sessionKey,
      sessionId: requireNonEmptyString(created.payload?.sessionId, "created session id"),
    });
    expect(titleCompletion).toBeDefined();
    finishDispatch();
    expect(dispatchAdmissionsReleased).toBeDefined();
    await dispatchAdmissionsReleased;
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey])).toBe(false);

    // Use the dispatching Gateway's terminal drain while its metadata-only title is blocked.
    const deletion = rpcReq<{ deleted: boolean }>(ws, "sessions.delete", {
      key: sessionKey,
    });
    deletionCleanup = deletion.catch(() => {});
    const deleted = await deletion;
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();

    // Join the title writer itself before proving that its late result cannot recreate the row.
    finishTitle?.();
    await expect(titleCompletion).resolves.toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  } finally {
    finishDispatch();
    finishTitle?.();
    await titleCompletion;
    await deletionCleanup;
    ws.close();
  }
});

test.each(["assistant", "item", "tool", "thinking", "approval", "empty", "error"])(
  "chat.send defers its title until %s progress or settlement",
  async (stream) => {
    const terminalOnly = stream === "empty" || stream === "error";
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openClient();
    let dispatchFinished = false;
    let stopTitleObserver = () => {};
    const dispatchStarted = createDeferredCore();
    const titlePersisted = createDeferredCore();
    const { promise: dispatchPending, resolve: finishDispatch } = createDeferredCore();
    let runId: string | undefined;
    let sessionKey: string | undefined;
    const eventContext = new AsyncLocalStorage<string>();
    dashboardTitleGenerationMocks.generate.mockImplementation(async () =>
      eventContext.getStore() ? "Wrong event context" : "Generated Dashboard Title",
    );
    dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
      runId = requireNonEmptyString(replyOptions?.runId, "reply run id");
      if (!terminalOnly) {
        replyOptions?.onAgentRunStart?.(runId);
      }
      dispatchStarted.resolve();
      await dispatchPending;
      dispatchFinished = true;
      if (!terminalOnly) {
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      }
      if (stream === "error") {
        throw new Error("Reply preparation failed");
      }
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      };
    });
    try {
      const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
        agentId: "main",
        key: `agent:main:dashboard:title-during-${stream}`,
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      sessionKey = requireNonEmptyString(created.payload?.key, "created session key");
      stopTitleObserver = sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === sessionKey &&
          loadSessionEntry({ agentId: "main", sessionKey, storePath })?.displayName
        ) {
          titlePersisted.resolve();
        }
      });

      const sent = await rpcReq(ws, "chat.send", {
        sessionKey,
        message: "Help me plan the release",
        idempotencyKey: `dashboard-title-during-${stream}`,
      });
      expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
      await dispatchStarted.promise;
      expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
      if (terminalOnly) {
        finishDispatch();
      } else {
        eventContext.run("provider event", () =>
          emitAgentEvent({
            runId: requireNonEmptyString(runId, "reply run id"),
            stream,
            data: { text: "Planning the release", phase: "update", kind: "preamble" },
          }),
        );
      }
      await titlePersisted.promise;
      emitAgentEvent({
        runId: requireNonEmptyString(runId, "reply run id"),
        stream,
        data: { text: "Continuing the release plan", phase: "update", kind: "preamble" },
      });
      expect(dashboardTitleScheduleMocks.schedule).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        displayName: "Generated Dashboard Title",
      });
      expect(dispatchFinished).toBe(terminalOnly);
    } finally {
      stopTitleObserver();
      const released = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [sessionKey],
      });
      finishDispatch?.();
      await released;
      ws.close();
    }
  },
);

test("chat.send retries a title that failed during its turn once that turn settles", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  const sessionKey = "agent:main:dashboard:title-retry-after-turn";
  let dispatchFinished = false;
  let stopTitleObserver = () => {};
  const dispatchStarted = createDeferredCore();
  const firstLabelFailed = createDeferredCore();
  const titlePersisted = createDeferredCore();
  const { promise: dispatchPending, resolve: finishDispatch } = createDeferredCore();
  const retriedAfterTurn: boolean[] = [];
  dashboardTitleGenerationMocks.generate
    .mockImplementationOnce(async () => {
      // A one-request-at-a-time model holds the label behind the running reply until it times out.
      firstLabelFailed.resolve();
      throw new Error("conversation label generation failed (primary fallback)");
    })
    .mockImplementationOnce(async () => {
      retriedAfterTurn.push(dispatchFinished);
      return "Generated Dashboard Title";
    });
  dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
    const runId = requireNonEmptyString(replyOptions?.runId, "reply run id");
    replyOptions?.onAgentRunStart?.(runId);
    emitAgentEvent({ runId, stream: "assistant", data: { text: "Planning the release" } });
    dispatchStarted.resolve();
    await dispatchPending;
    dispatchFinished = true;
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    return {
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    };
  });
  try {
    const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
      agentId: "main",
      key: sessionKey,
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    stopTitleObserver = sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === sessionKey &&
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.displayName
      ) {
        titlePersisted.resolve();
      }
    });

    const sent = await rpcReq(ws, "chat.send", {
      sessionKey,
      message: "Help me plan the release",
      idempotencyKey: "dashboard-title-retry-after-turn",
    });
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    await Promise.all([dispatchStarted.promise, firstLabelFailed.promise]);
    finishDispatch();
    await titlePersisted.promise;
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      displayName: "Generated Dashboard Title",
    });
    expect(retriedAfterTurn).toEqual([true]);
  } finally {
    stopTitleObserver();
    const released = getSessionWorkAdmissionRelease({
      scope: storePath,
      identities: [sessionKey],
    });
    finishDispatch();
    await released;
    ws.close();
  }
});

const mentionCreationOwners = [
  ["main", "per-sender"],
  ["ops", "global"],
] as const;

test.each(mentionCreationOwners)(
  "sessions.create commits its selected first-message mentions to the recipient Inbox for %s under %s scope",
  (agentId, scope) =>
    withFixedOwnerSessionStore(createSessionStoreDir, scope, async ({ storePath }) => {
      const alice = ensureProfileForEmail("alice@create-mentions.example.test");
      const bob = ensureProfileForEmail("bob@create-mentions.example.test");
      const sender = { ...identifiedClient(alice.id, "Alice"), connId: "alice-create" };
      const recipient = { ...identifiedClient(bob.id, "Bob"), connId: "bob-create" };
      const inbox = createMentionInbox({
        scheduler: createTestGatewayScheduler(),
        gatewayInstanceId: "first-message-mentions",
        getRuntimeConfig,
        getClients: () => [sender, recipient],
        broadcastToConnIds: vi.fn(),
      });
      const context = {
        mentionInbox: inbox,
        chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
        getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
          new Set(
            [sender, recipient]
              .filter((client) => !filter || filter(client))
              .map(({ connId }) => connId),
          ),
      };
      let key: string | undefined;
      try {
        const created = await directSessionReq<{
          key: string;
          sessionId: string;
          runStarted: boolean;
        }>(
          "sessions.create",
          {
            agentId,
            message: "@Bob review this: API_TOKEN = computeToken()",
            mentions: [{ profileId: bob.id, start: 0, end: 4 }],
          },
          { client: sender, context, isWebchatConnect: () => true },
        );
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        expect(created.payload?.runStarted).toBe(true);
        key = created.payload?.key;
        expect(key).toMatch(new RegExp(`^agent:${agentId}:dashboard:`));
        expect(inbox.list(recipient)).toMatchObject({
          ok: true,
          value: {
            items: [
              {
                senderProfileId: alice.id,
                sessionKey: key,
                agentId,
                excerpt: "@Bob review this: API_TOKEN = computeToken()",
              },
            ],
          },
        });
        expect(inbox.list(sender)).toMatchObject({ ok: true, value: { items: [] } });
      } finally {
        await waitForCreatedSessionRun(context, storePath, key);
        await inbox.dispose();
      }
    }),
);

test("sessions.create rejects stale mention spans before creating a selected-agent global session", () =>
  withFixedOwnerSessionStore(createSessionStoreDir, "global", async () => {
    const sender = identifiedClient(
      ensureProfileForEmail("alice@invalid-mentions.example.test").id,
    );
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "ops",
        message: "token was removed",
        mentions: [{ profileId: "bob", start: 0, end: 4 }],
      },
      { client: sender },
    );
    expect(created).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Select the people again") },
    });
    const listed = await directSessionReq<{ sessions: unknown[] }>("sessions.list", {});
    expect(listed.payload?.sessions).toEqual([]);
  }));

test("sessions.create forwards an attachment-only first turn", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { entries: { main: {} } };
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "attachment-run", status: "started" });
  });
  const attachment = {
    type: "image",
    mimeType: "image/png",
    fileName: "pixel.png",
    content:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
  };

  try {
    const created = await directSessionReq<{ runStarted?: boolean; runId?: string }>(
      "sessions.create",
      { agentId: "main", message: "", attachments: [attachment] },
    );

    expect(created.ok).toBe(true);
    expect(created.payload).toMatchObject({ runStarted: true, runId: "attachment-run" });
    expect(chatSend.mock.calls[0]?.[0].params).toMatchObject({
      message: "",
      attachments: [attachment],
    });
  } finally {
    chatSend.mockRestore();
  }
});

type CreatedSessionPayload = { key?: string; sessionId?: string; entry?: SessionEntry };

test.each(["generated key", "junction"])(
  "publishes a selected-agent session before socket reads: %s",
  async (mode) =>
    withFixedOwnerSessionStore(createSessionStoreDir, "global", async ({ storePath }) => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "global", storePath },
        { sessionId: "fixed-global-owner", updatedAt: 1 },
      );
      if (mode === "junction") {
        const dir = path.dirname(storePath);
        const alias = `${dir}-alias`;
        await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
        testState.sessionStorePath = path.join(alias, path.basename(storePath));
        const config = await getGatewayConfigModule();
        config.clearRuntimeConfigSnapshot();
        config.clearConfigCache();
      }
      const requestedKey =
        mode === "generated key" ? undefined : "agent:ops:dashboard:publication-owner";
      const { ws } = await openClient();
      try {
        const warm = await rpcReq<SessionsListResult>(ws, "sessions.list", { agentId: "ops" });
        expect(warm.ok, JSON.stringify(warm)).toBe(true);
        const created = await rpcReq<CreatedSessionPayload>(ws, "sessions.create", {
          agentId: "ops",
          key: requestedKey,
          label: "Publication owner",
        });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        const key = requireNonEmptyString(created.payload?.key, "created session key");
        const sessionId = requireNonEmptyString(created.payload?.sessionId, "created session id");
        expect(key).toMatch(/^agent:ops:dashboard:/);
        if (requestedKey) {
          expect(key).toBe(requestedKey);
        }
        expect(loadSessionEntry({ agentId: "ops", sessionKey: key, storePath })).toBeDefined();
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: "global", storePath })?.sessionId,
        ).toBe("fixed-global-owner");
        const expected = { key, sessionId, label: "Publication owner" };
        const described = await rpcReq<{ session: GatewaySessionRow | null }>(
          ws,
          "sessions.describe",
          { agentId: "ops", key },
        );
        expect(described.ok, JSON.stringify(described)).toBe(true);
        expect(described.payload?.session).toMatchObject(expected);
        const listed = await rpcReq<SessionsListResult>(ws, "sessions.list", {
          agentId: "ops",
          limit: 100,
        });
        expect(listed.ok, JSON.stringify(listed)).toBe(true);
        expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject(expected);
      } finally {
        await closeGatewayTestWebSocket(ws);
      }
    }),
);

test("sessions.create applies configured fixed-store ownership to bare keys", async () => {
  const { storePath } = await createSessionStoreDir();
  const broadcastToConnIds = vi.fn();
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  };
  testState.agentConfig = { sessionStore: { agentId: "ops" } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  try {
    const created = await directSessionReq<{ key?: string; sessionId?: string }>(
      "sessions.create",
      { key: "global" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.payload?.key).toBe("global");
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "global", storePath })?.sessionId).toBe(
      created.payload?.sessionId,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", agentId: "ops", reason: "create" }),
      new Set(["conn-1"]),
      {
        dropIfSlow: true,
        agentId: "ops",
        sessionKeys: ["global"],
        prepareSessionProjection: expect.any(Function),
      },
    );

    const conflict = await directSessionReq("sessions.create", {
      key: "global",
      agentId: "research",
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'agent "research" does not match session key agent "ops"',
      },
    });
  } finally {
    testState.agentsConfig = undefined;
    testState.agentConfig = {};
  }
});

test("sessions.create loads selected global parent from the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-parent", {
          providerOverride: "codex",
          modelOverride: "main-model",
        }),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-parent", {
          providerOverride: "openai",
          modelOverride: "work-model",
          thinkingLevel: "high",
        }),
      },
    });

    const created = await directSessionReq<CreatedSessionPayload>("sessions.create", {
      agentId: "work",
      parentSessionKey: "global",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:work:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("global");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("work-model");
    expect(created.payload?.entry?.thinkingLevel).toBe("high");

    const commandNewEvent = sessionHookMocks.triggerInternalHook.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          "type" in event &&
          event.type === "command" &&
          "action" in event &&
          event.action === "new",
      );
    expect(commandNewEvent).toMatchObject({
      context: { sessionEntry: { sessionId: "sess-work-parent" } },
    });
    expect(sessionLifecycleHookMocks.runSessionEnd.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess-work-parent",
      sessionKey: "global",
    });
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.get reads selected global messages from the requested agent store", async () => {
  const { mainStorePath, storeTemplate, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global"),
      },
    });
    await seedSessionTranscript({
      agentId: "main",
      messages: [{ role: "user", content: "main global" }],
      sessionId: "sess-main-global",
      sessionKey: "global",
      storePath: mainStorePath,
    });
    await seedSessionTranscript({
      agentId: "work",
      messages: [{ role: "user", content: "work global" }],
      sessionId: "sess-work-global",
      sessionKey: "global",
      storePath: workStorePath,
    });

    const cfg = {
      agents: { entries: { main: {}, work: {} } },
      session: { scope: "global", store: storeTemplate },
    };
    const result = await directSessionReq<{ messages?: unknown[] }>(
      "sessions.get",
      {
        key: "global",
        agentId: "work",
      },
      {
        context: {
          getRuntimeConfig: () => cfg,
        },
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const renderedMessages = JSON.stringify(result.payload?.messages ?? []);
    expect(renderedMessages).toContain("work global");
    expect(renderedMessages).not.toContain("main global");
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create checks selected global initialization in the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const broadcastToConnIds = vi.fn();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-initializing", { initializationPending: true }),
      },
    });

    const created = await directSessionReq<CreatedSessionPayload>(
      "sessions.create",
      { key: "global", agentId: "work" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.payload).toMatchObject({ key: "global" });
    expect(created.payload?.entry).not.toHaveProperty("sessionFile");
    expect(
      loadSessionEntry({ agentId: "work", sessionKey: "global", storePath: workStorePath }),
    ).toMatchObject({ sessionId: created.payload?.sessionId });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
    ).toMatchObject({ sessionId: "sess-main-initializing", initializationPending: true });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", agentId: "work", reason: "create" }),
      new Set(["conn-1"]),
      {
        dropIfSlow: true,
        agentId: "work",
        sessionKeys: ["global"],
        prepareSessionProjection: expect.any(Function),
      },
    );

    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-initializing", { initializationPending: true }),
      },
    });
    expect(
      resolveSessionEntryAccessTarget({
        cfg: getRuntimeConfig(),
        sessionKey: "global",
        agentId: "work",
      }).entry,
    ).toMatchObject({ sessionId: "sess-work-initializing", initializationPending: true });
    const blocked = await directSessionReq("sessions.create", { key: "global", agentId: "work" });
    expect(blocked).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Session global is still initializing; retry creation later.",
      },
    });
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create sends selected global initial tasks to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  onTestFinished(async () =>
    resetConfiguredGlobalAgentSessionStore({
      ...(await getGatewayConfigModule()),
      configPath: requireNonEmptyString(process.env.OPENCLAW_CONFIG_PATH, "config path"),
    }),
  );
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    runStarted?: boolean;
    runId?: string;
  }>(ws, "sessions.create", {
    key: "global",
    agentId: "work",
    task: "hello selected global",
  });

  expect(created.ok, JSON.stringify(created)).toBe(true);
  expect(created.payload?.key).toBe("global");
  expect(created.payload?.runStarted, JSON.stringify(created)).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "selected global run id");
  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  const workEntry = loadSessionEntry({
    agentId: "work",
    sessionKey: "global",
    storePath: workStorePath,
  });
  const workSessionId = requireNonEmptyString(workEntry?.sessionId, "selected global session id");
  await expect(
    loadTranscriptEvents({
      agentId: "work",
      sessionId: workSessionId,
      sessionKey: "global",
      storePath: workStorePath,
    }),
  ).resolves.toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ content: "hello selected global" }),
      type: "message",
    }),
  );
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
  ).toBeUndefined();
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
  ws.close();
});

test.each([
  {
    name: "legacy explicit target",
    explicit: false,
    defaultAgent: false,
    agentId: "main",
    key: undefined,
    expectedAgent: "main",
  },
  {
    name: "legacy ambient target",
    explicit: false,
    defaultAgent: false,
    agentId: undefined,
    key: undefined,
    expectedAgent: "main",
  },
  {
    name: "explicit fleet without default",
    fork: false,
    explicit: true,
    defaultAgent: false,
    agentId: undefined,
    key: undefined,
    expectedAgent: "work",
  },
  {
    name: "explicit fleet with another default",
    fork: false,
    explicit: true,
    defaultAgent: true,
    agentId: undefined,
    key: undefined,
    expectedAgent: "work",
  },
  {
    name: "explicit cross-agent target",
    explicit: true,
    defaultAgent: false,
    agentId: "main",
    key: undefined,
    expectedAgent: "main",
  },
  {
    name: "explicit child key",
    explicit: true,
    defaultAgent: false,
    agentId: undefined,
    key: "agent:main:dashboard:child-target",
    expectedAgent: "main",
  },
])(
  "sessions.create resolves an agent-qualified parent from its own store: $name",
  async ({ explicit, defaultAgent, agentId, key, expectedAgent, fork = true }) => {
    const { dir } = await createSessionStoreDir();
    const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
    const mainStorePath = storeTemplate.replace("{agentId}", "main");
    const workStorePath = storeTemplate.replace("{agentId}", "work");
    const workDir = path.dirname(workStorePath);
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { scope: "per-sender" };
    testState.agentsConfig = {
      ownership: explicit ? "explicit" : undefined,
      entries: { main: explicit ? {} : { default: true }, work: {} },
    };
    testState.agentConfig = defaultAgent ? { systemAgent: { agentId: "main" } } : undefined;
    const { ws } = await openClient();
    try {
      await fs.mkdir(workDir, { recursive: true });
      const parent = await createCompactedSessionFixture(workDir);
      await writeSessionStore({
        storePath: workStorePath,
        agentId: "work",
        entries: {
          main: sessionStoreEntry(parent.sessionId, { sessionFile: parent.sessionFile }),
        },
      });
      await seedSessionTranscript({
        agentId: "work",
        sessionId: parent.sessionId,
        sessionKey: "agent:work:main",
        storePath: workStorePath,
        messages: [
          { role: "user", content: "before compaction" },
          { role: "assistant", content: [{ type: "text", text: "working on it" }] },
        ],
      });

      const created = await rpcReq<{
        key?: string;
        sessionId?: string;
        entry?: {
          parentSessionKey?: string;
          sessionFile?: string;
          forkSource?: { sessionKey: string; sessionId: string };
          forkedFromParent?: boolean;
        };
      }>(ws, "sessions.create", {
        ...(agentId ? { agentId } : {}),
        ...(key ? { key } : {}),
        parentSessionKey: "agent:work:main",
        ...(fork ? { fork: true } : {}),
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.key).toMatch(new RegExp(`^agent:${expectedAgent}:dashboard:`));
      if (key) {
        expect(created.payload?.key).toBe(key);
      }
      const childKey = requireNonEmptyString(created.payload?.key, "created child key");
      const described = await rpcReq<{ session: { key: string; agentId: string } }>(
        ws,
        "sessions.describe",
        { key: childKey },
      );
      expect(described.ok, JSON.stringify(described.error)).toBe(true);
      expect(described.payload?.session).toMatchObject({ key: childKey, agentId: expectedAgent });
      expect(
        loadSessionEntry({
          agentId: expectedAgent,
          sessionKey: childKey,
          storePath: expectedAgent === "work" ? workStorePath : mainStorePath,
        }),
      ).toMatchObject({ sessionId: created.payload?.sessionId });
      expect(
        loadSessionEntry({
          agentId: expectedAgent === "work" ? "main" : "work",
          sessionKey: childKey,
          storePath: expectedAgent === "work" ? mainStorePath : workStorePath,
        }),
      ).toBeUndefined();
      expect(created.payload?.entry?.parentSessionKey).toBe("agent:work:main");
      expect(created.payload?.entry).not.toHaveProperty("sessionFile");
      if (!fork) {
        expect(created.payload?.entry).not.toHaveProperty("forkSource");
        expect(created.payload?.entry).not.toHaveProperty("forkedFromParent");
        return;
      }
      expect(created.payload?.entry?.forkSource).toEqual({
        sessionKey: "agent:work:main",
        sessionId: parent.sessionId,
      });
      expect(created.payload?.entry?.forkedFromParent).toBe(true);
      await expect(
        loadTranscriptEvents({
          sessionId: requireNonEmptyString(
            created.payload?.sessionId,
            "agent-qualified forked session id",
          ),
          sessionKey: created.payload?.key ?? "",
          agentId: expectedAgent,
          storePath: expectedAgent === "work" ? workStorePath : mainStorePath,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ content: "before compaction" }),
            type: "message",
          }),
        ]),
      );
    } finally {
      await closeGatewayTestWebSocket(ws);
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      testState.agentsConfig = undefined;
    }
  },
);
