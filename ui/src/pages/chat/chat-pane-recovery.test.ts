/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitStoredChatComposerQueueItemResult } from "./composer-queue-persistence.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

function sessionsResult(row: GatewaySessionRow): SessionsListResult {
  return { ...createSessionsListResult({ defaultsModel: null }), sessions: [row] };
}

function queuedSendFixture(options: { attempted?: boolean; initialIdle?: boolean } = {}) {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const listRefresh = createDeferred<SessionsListResult>();
  const active: GatewaySessionRow = {
    key: "agent:main",
    kind: "direct",
    updatedAt: 10,
    activeRunIds: options.initialIdle ? [] : ["server-run"],
    hasActiveRun: !options.initialIdle,
    status: options.initialIdle ? "done" : "running",
    ...(options.initialIdle ? { lastRunId: "server-run" } : {}),
  };
  const idle: GatewaySessionRow = {
    ...active,
    updatedAt: 11,
    activeRunIds: [],
    hasActiveRun: false,
    lastRunId: "server-run",
    status: "done",
  };
  const messages: unknown[] = [];
  const host = makeChatHost({
    chatQueue: [
      {
        id: "queued-after-server-run",
        text: "send after idle",
        createdAt: 1,
        sendAttempts: options.attempted ? 1 : 0,
        sendRunId: "queued-send-run",
        sendState: options.attempted ? "unconfirmed" : "waiting-idle",
        sessionKey: "agent:main",
      },
    ],
    requestHandlers: {
      "sessions.list": () => listRefresh.promise,
      "chat.history": () => ({ messages, sessionInfo: idle }),
      "chat.send": (params: { message: string; idempotencyKey: string }) => {
        messages.push({
          role: "user",
          content: params.message,
          __openclaw: {
            id: "queued-user",
            seq: 1,
            idempotencyKey: `${params.idempotencyKey}:user`,
          },
        });
        return { runId: params.idempotencyKey, status: "started", messageSeq: 1 };
      },
    },
    sessionsResult: sessionsResult(active),
  });
  const admission = captureChatOutboxAdmission(host, host.sessionKey);
  expect(admitStoredChatComposerQueueItemResult(host, admission, host.chatQueue[0]!)).toBe(
    "admitted",
  );
  const { pane } = createTestChatPane({ client: host.client!, sessions: host.sessions });
  pane.state = host as unknown as ChatPageHost;
  pane.applySessionsState(host.sessions.state);
  const unsubscribe = host.sessions.subscribe((state) => pane.applySessionsState(state));
  cleanups.push(() => {
    pane.active = false;
    unsubscribe();
    host.sessions.dispose();
  });
  return {
    idle,
    host,
    listRefresh,
    pane,
    calls: (method: string) => host.request.mock.calls.filter(([name]) => name === method),
    readIdle: async () => {
      const pending = host.sessions.refresh({ force: true });
      listRefresh.resolve(sessionsResult(idle));
      await pending;
    },
  };
}

const recovered = {
  ok: true as const,
  key: "agent:main:current",
  sessionId: "recovered-session",
  continuation: { status: "started" as const, runId: "recovery-run" },
};
const recoveryTarget = {
  agentId: "main",
  key: "agent:main:current",
  sessionId: "interrupted-session",
  recoveryCycleId: "restart-cycle-1",
};

function recoveryFixture(recover: SessionCapability["recover"]) {
  const sessions = createSessionCapabilityFixture({ recover });
  const fixture = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
  const navigate = vi.fn();
  const { pane, state } = fixture;
  pane.onPaneSessionChange = navigate;
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.write"] },
    features: { methods: ["sessions.recover"] },
  } as typeof pane.context.gateway.snapshot.hello;
  state.sessionsResult = sessionsResult({
    key: state.sessionKey,
    sessionId: recoveryTarget.sessionId,
    kind: "direct",
    updatedAt: 1,
    restartRecoveryStatus: "tombstoned",
    restartRecoveryCycleId: recoveryTarget.recoveryCycleId,
  });
  return { ...fixture, sessions, navigate };
}

it("unlocks the composer when shared session state settles the exact local run", () => {
  const sessions = createSessionCapabilityFixture();
  const { pane, state } = createTestChatPane({
    client: {} as GatewayBrowserClient,
    sessions,
  });
  state.chatRunId = "run-missed-terminal";
  state.chatStream = "answer already rendered";

  Object.assign(pane.context.sessions.state, {
    result: sessionsResult({
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 20,
      status: "done",
      hasActiveRun: false,
      lastRunId: "run-missed-terminal",
    }),
    agentId: "main",
    loading: false,
    error: null,
    deletedSessions: [],
  });
  pane.applySessionsState(pane.context.sessions.state);

  expect(state).toMatchObject({ chatRunId: null, chatStream: null });
});

it("releases a restored queued send when the canonical session state records idle", async () => {
  const { pane, host, listRefresh, idle, calls } = queuedSendFixture();
  pane.active = true;
  await vi.waitFor(() =>
    expect(host.request.mock.calls.map(([method]) => method)).toEqual(["sessions.list"]),
  );

  listRefresh.resolve(sessionsResult(idle));
  await vi.waitFor(() => expect(host.chatQueue).toEqual([]));
  expect(calls("chat.send")).toHaveLength(1);
});

it("keeps a queued send parked after a non-canonical idle publication", async () => {
  const { host, idle, calls } = queuedSendFixture();
  host.sessions.reconcile(idle);
  await Promise.resolve();

  expect(host.sessions.canonicalListRevision).toBe(0);
  expect(host.chatQueue).toHaveLength(1);
  expect([...calls("chat.history"), ...calls("chat.send")]).toEqual([]);
});

it("recovers the first canonical idle row and new terminal runs without repeating unchanged reads", async () => {
  const { host, idle, calls, readIdle } = queuedSendFixture({
    attempted: true,
    initialIdle: true,
  });
  const historyReads = () => calls("chat.history").length;
  await readIdle();
  await vi.waitFor(() => expect(historyReads()).toBe(1));
  await host.sessions.refresh({ force: true });
  await Promise.resolve();
  expect(historyReads()).toBe(1);
  expect(host.chatQueue).toHaveLength(1);

  idle.lastRunId = "new-terminal-run";
  await host.sessions.refresh({ force: true });
  await vi.waitFor(() => expect(historyReads()).toBe(2));
  expect(host.chatQueue).toHaveLength(1);
  expect(calls("chat.send")).toHaveLength(0);
});

it("waits for a fresh canonical idle read after a queued pane attaches to an existing cache", async () => {
  const { host, calls, readIdle } = queuedSendFixture({ attempted: true, initialIdle: true });
  await readIdle();
  const historyReads = () => calls("chat.history").length;
  await vi.waitFor(() => expect(historyReads()).toBe(1));
  const { pane, state } = createTestChatPane({
    client: host.client!,
    sessions: host.sessions,
  });
  state.sessionKey = host.sessionKey;
  // Both panes must read the queued outbox from the same gateway owner.
  state.settings.gatewayUrl = host.settings.gatewayUrl ?? "";
  state.chatQueue = [...host.chatQueue];
  pane.applySessionsState(host.sessions.state);
  const unsubscribe = host.sessions.subscribe((next) => pane.applySessionsState(next));
  cleanups.push(unsubscribe);
  expect(historyReads()).toBe(1);

  await host.sessions.refresh({ force: true });
  await vi.waitFor(() => expect(historyReads()).toBe(2));
  expect(state.chatQueue).toHaveLength(1);
});

it.each([false, true])(
  "resumes in place without losing the draft (reconnected: %s)",
  async (reconnected) => {
    const created = createDeferred<Awaited<ReturnType<SessionCapability["recover"]>>>();
    const { pane, state, sessions, navigate } = recoveryFixture(
      vi
        .fn<SessionCapability["recover"]>()
        .mockImplementationOnce(() => created.promise)
        .mockResolvedValueOnce(recovered),
    );
    state.chatMessage = "Keep my follow-up draft";
    const attachments = [
      { id: "draft-image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
    ];
    state.chatAttachments = attachments;

    expect(pane.restartRecoveryComposerBanner()).toMatchObject({
      title: "This task was interrupted by a restart.",
      text: "Your transcript is safe. Resume to continue in this session.",
      tone: "neutral",
      icon: "warning",
      actionLabel: "Resume",
      actionStyle: "primary",
      busy: false,
    });

    const pending = pane.recoverSession();
    await vi.waitFor(() => expect(sessions.recover).toHaveBeenCalledOnce());
    expect(pane.restartRecoveryComposerBanner()).toMatchObject({
      actionLabel: "Resume",
      actionStyle: "primary",
      busy: true,
      busyLabel: "Resuming…",
    });
    if (reconnected) {
      state.connected = false;
      state.connectionEpoch = ++pane.connectionGeneration;
      state.connected = true;
      state.connectionEpoch = ++pane.connectionGeneration;
    }
    created.resolve(recovered);
    await expect(pending).resolves.toBe(!reconnected);
    if (reconnected) {
      await expect(pane.recoverSession()).resolves.toBe(true);
      expect(sessions.recover).toHaveBeenCalledTimes(2);
    }

    expect(sessions.recover).toHaveBeenCalledWith({
      ...recoveryTarget,
      mode: "in-place",
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      sessionKey: "agent:main:current",
      chatMessage: "Keep my follow-up draft",
    });
    expect(state.chatAttachments).toBe(attachments);
  },
);

it.each([false, true])(
  "retries rejected continuation (new session required: %s)",
  async (newSession) => {
    const message = newSession
      ? "This provider cannot safely resume tool work in place."
      : "Continuation was not started.";
    const { pane, state, sessions, navigate } = recoveryFixture(
      vi
        .fn<SessionCapability["recover"]>()
        .mockResolvedValueOnce({
          ...recovered,
          sessionId: newSession ? "interrupted-session" : recovered.sessionId,
          continuation: {
            status: "rejected",
            error: {
              code: "UNAVAILABLE",
              message,
              ...(newSession ? { details: { reason: "restart-safe-tools-unavailable" } } : {}),
            },
          },
        })
        .mockResolvedValueOnce(
          newSession
            ? {
                ...recovered,
                key: "agent:main:replacement",
                sessionId: "replacement-session",
                continuation: { status: "started", runId: "replacement-run" },
              }
            : recovered,
        ),
    );

    await expect(pane.recoverSession()).resolves.toBe(false);
    expect(state.chatError).toBe(message);
    expect(navigate).not.toHaveBeenCalled();
    if (!newSession) {
      expect(pane.restartRecoveryComposerBanner()?.actionLabel).toBe("Resume");
      await expect(pane.recoverSession()).resolves.toBe(true);
      expect(sessions.recover).toHaveBeenCalledTimes(2);
      expect(navigate).not.toHaveBeenCalled();
      return;
    }
    expect(pane.restartRecoveryComposerBanner()?.actionLabel).toBe("Resume in new session");
    const original = state.sessionsResult!.sessions[0]!;
    for (const changed of [
      { ...original, restartRecoveryCycleId: "later-cycle" },
      { ...original, sessionId: "different-session" },
      { ...original, key: "agent:main:other" },
    ]) {
      state.sessionsResult = sessionsResult(changed);
      expect(pane.restartRecoveryComposerBanner()?.actionLabel).toBe("Resume");
    }
    state.sessionsResult = sessionsResult(original);
    pane.restartRecoveryComposerBanner()?.onAction();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(pane.paneId, "agent:main:replacement"),
    );
    expect(sessions.recover).toHaveBeenLastCalledWith({
      ...recoveryTarget,
      mode: "new-session",
    });
  },
);
