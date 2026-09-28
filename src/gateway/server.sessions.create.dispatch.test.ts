import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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
import { dispatchInboundMessageMock, rpcReq, testState } from "./test-helpers.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

test("chat.send fences dashboard title persistence from concurrent session deletion", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  let releaseDrainProbe = () => {};
  let deletionCleanup: Promise<unknown> | undefined;
  let dispatchAdmissionsReleased: Promise<void> | undefined;
  const scheduleTitle = await actualDashboardTitleScheduler();
  dashboardTitleScheduleMocks.schedule.mockImplementationOnce((params) => {
    // Capture chat custody before the independent title admission is created.
    dispatchAdmissionsReleased = getSessionWorkAdmissionRelease({
      scope: params.storePath,
      identities: [params.sessionKey, params.admittedSessionId],
    });
    scheduleTitle(params);
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
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    dispatchStarted.resolve();
    await dispatchFinished;
    return {
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    };
  });
  try {
    const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
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
    expect(dispatchInboundMessageMock).toHaveBeenCalled();
    expect(dashboardTitleScheduleMocks.schedule).toHaveBeenCalled();
    expect(dashboardTitleScheduleMocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ rawMessage: "Help me plan the release" }),
        sessionKey,
      }),
    );
    finishDispatch?.();
    expect(dispatchAdmissionsReleased).toBeDefined();
    await dispatchAdmissionsReleased;
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey])).toBe(true);
    const drainStarted = createDeferredCore();
    const drainProbe = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey],
      assertAllowed: () => {},
      onInterrupt: () => {
        drainStarted.resolve();
        releaseDrainProbe();
      },
    });
    releaseDrainProbe = drainProbe.release;
    let deletionSettled = false;
    const deletion = directSessionReq<{ deleted: boolean }>("sessions.delete", {
      key: sessionKey,
    }).finally(() => {
      deletionSettled = true;
    });
    deletionCleanup = deletion.catch(() => {});
    // Deletion drains title work outside its mutation lock; observe the drain owner itself.
    await Promise.race([
      drainStarted.promise,
      deletion.then((result) => {
        throw new Error(`Deletion returned before draining: ${JSON.stringify(result)}`);
      }),
    ]);
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey])).toBe(true);
    expect(deletionSettled).toBe(false);

    finishTitle?.();
    const deleted = await deletion;
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  } finally {
    releaseDrainProbe();
    finishDispatch?.();
    finishTitle?.();
    await deletionCleanup;
    ws.close();
  }
});

test("chat.send persists a dashboard title while the first turn is still running", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  let dispatchFinished = false;
  let stopTitleObserver = () => {};
  const dispatchStarted = createDeferredCore();
  const titlePersisted = createDeferredCore();
  const { promise: dispatchPending, resolve: finishDispatch } = createDeferredCore();
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    dispatchStarted.resolve();
    await dispatchPending;
    dispatchFinished = true;
    return {
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    };
  });
  try {
    const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "agent:main:dashboard:title-during-turn",
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "created session key");
    stopTitleObserver = sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === sessionKey &&
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.displayName ===
          "Generated Dashboard Title"
      ) {
        titlePersisted.resolve();
      }
    });

    const sent = await rpcReq(ws, "chat.send", {
      sessionKey,
      message: "Help me plan the release",
      idempotencyKey: "dashboard-title-during-turn",
    });
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    await Promise.all([dispatchStarted.promise, titlePersisted.promise]);
    expect(dispatchInboundMessageMock).toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      displayName: "Generated Dashboard Title",
    });
    expect(dispatchFinished).toBe(false);
  } finally {
    stopTitleObserver();
    finishDispatch?.();
    ws.close();
  }
});

test("sessions.create can start the first agent turn from an initial task", async () => {
  const { storePath } = await createSessionStoreDir();
  // Register "ops" so the deleted-agent guard added in #65986 does not
  // reject the auto-started chat.send triggered by `task:`.
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    sessionId?: string;
    runStarted?: boolean;
    runId?: string;
    messageSeq?: number;
  }>(ws, "sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    task: "hello from create",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "started run id");
  if (created.payload?.messageSeq !== undefined) {
    const events = await loadTranscriptEvents({
      agentId: "ops",
      sessionId: created.payload.sessionId!,
      sessionKey: created.payload.key!,
      storePath,
    });
    const messages = events.filter((event) => asNullableRecord(event)?.type === "message");
    expect(messages[created.payload.messageSeq - 1]).toMatchObject({
      message: { role: "user", idempotencyKey: `${runId}:user` },
    });
  }

  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  expect(wait.payload?.status).toBe("ok");

  ws.close();
});

const mentionCreationOwners = [
  ["main", "per-sender"],
  ["ops", "per-sender"],
  ["main", "global"],
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
            message: "@Bob review this",
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
              { senderProfileId: alice.id, sessionKey: key, agentId, excerpt: "@Bob review this" },
            ],
          },
        });
        expect(inbox.list(sender)).toMatchObject({ ok: true, value: { items: [] } });
      } finally {
        await waitForCreatedSessionRun(context, storePath, key);
        inbox.dispose();
      }
    }),
);

test.each(mentionCreationOwners)(
  "sessions.create rejects stale mention spans before creating a session for %s under %s scope",
  (agentId, scope) =>
    withFixedOwnerSessionStore(createSessionStoreDir, scope, async () => {
      const sender = identifiedClient(
        ensureProfileForEmail("alice@invalid-mentions.example.test").id,
      );
      const created = await directSessionReq(
        "sessions.create",
        {
          agentId,
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
    }),
);

test("sessions.create forwards an attachment-only first turn", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
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

test("sessions.create rejects unusable attachment-only input before creating a session", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    attachments: [null],
  });

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("must be object");
  const listed = await directSessionReq<{ sessions?: unknown[] }>("sessions.list", {});
  expect(listed.payload?.sessions).toEqual([]);
});
