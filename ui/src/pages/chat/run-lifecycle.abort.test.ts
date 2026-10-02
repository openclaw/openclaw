// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveSessionKey } from "../../lib/sessions/navigation.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  hasDirectSessionRun,
  replayPendingChatAbort,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";

function makeSessionsResult(rows: (Pick<GatewaySessionRow, "key"> & Partial<GatewaySessionRow>)[]) {
  return sessionsResult(
    rows.map<GatewaySessionRow>((row) => ({ kind: "direct", updatedAt: 1, ...row })),
    1,
  );
}

describe("hasAbortableSessionRun", () => {
  it("reads the target once and visits each row once per abortability check", () => {
    const target = vi.fn(() => "Agent:Main:Target");
    const keys = ["agent:main:other", "agent:main:target"].map((key) => vi.fn(() => key));
    const host = {
      get sessionKey() {
        return target();
      },
      sessionsResult: sessionsResult(
        keys.map((key, index) => ({
          get key() {
            return key();
          },
          kind: "direct" as const,
          updatedAt: 1,
          hasActiveSubagentRun: index === 1,
        })),
        1,
      ),
    };
    for (let i = 0; i < 3; i++) {
      expect(hasAbortableSessionRun(host)).toBe(true);
    }
    expect(target).toHaveBeenCalledTimes(3);
    keys.forEach((key) => expect(key).toHaveBeenCalledTimes(3));
  });

  it("recognizes the canonical main row while chat uses its main alias", () => {
    expect(
      hasAbortableSessionRun({
        chatRunId: null,
        sessionKey: "main",
        sessionsResult: makeSessionsResult([
          { key: "agent:main:main", hasActiveRun: true, status: "running" },
        ]),
      }),
    ).toBe(true);
  });
});

type AbortHost = Parameters<typeof replayPendingChatAbort>[0] &
  Parameters<typeof reconcileChatRunLifecycle>[0];

function makeAbortHost(over: Partial<AbortHost> = {}): AbortHost {
  return {
    client: null,
    connected: true,
    sessionKey: "agent:main",
    chatRunId: null,
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    hello: sessionMutationGatewayHello(),
    ...over,
  };
}

describe("handleAbortChat", () => {
  it.each([false, true])(
    "dispatches descendant Stop with preserveDraft=%s",
    async (preserveDraft) => {
      const request = vi.fn(async () => ({ status: "aborted" }));
      const host = makeAbortHost({
        client: createTestGatewayClient(request),
        chatMessage: "@Alex interrupted draft",
        chatReplyTarget: { messageId: "original", text: "Quoted source" },
        chatMentions: [{ profileId: "alex-profile", start: 0, end: 5 }],
        sessionsResult: makeSessionsResult([
          {
            key: "agent:main",
            hasActiveRun: false,
            hasActiveSubagentRun: true,
            status: "done",
          },
        ]),
      });

      expect(hasDirectSessionRun(host)).toBe(false);
      expect(hasAbortableSessionRun(host)).toBe(true);
      await handleAbortChat(host, { preserveDraft });

      expect(request).toHaveBeenCalledWith("sessions.abort", {
        key: "agent:main",
        clearQueued: true,
      });
      expect(host.chatMessage).toBe(preserveDraft ? "@Alex interrupted draft" : "");
      expect(host.chatMentions).toEqual(
        preserveDraft ? [{ profileId: "alex-profile", start: 0, end: 5 }] : [],
      );
      expect(host.chatReplyTarget).toEqual(
        preserveDraft ? { messageId: "original", text: "Quoted source" } : null,
      );
    },
  );

  it("keeps event-driven settlement when chat.abort aborts the live run", async () => {
    const request = vi.fn(async () => ({ ok: true, aborted: true, runIds: ["run-live"] }));
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      chatRunId: "run-live",
      refreshCurrentChat,
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(refreshCurrentChat).not.toHaveBeenCalled();
    expect(host.chatRunId).toBe("run-live");
  });

  it.each([false, true])(
    "keeps a replayed warning with its terminal run (replacement pending: %s)",
    async (replacementPending) => {
      const response = createDeferred<unknown>();
      const host = makeAbortHost({
        client: createTestGatewayClient(vi.fn(() => response.promise)),
        connected: false,
        chatRunId: "stopped-run",
        requestUpdate: vi.fn(),
      });
      await handleAbortChat(host, { preserveDraft: true });
      host.connected = true;
      const stopped = replayPendingChatAbort(host);
      reconcileChatRunLifecycle(host, {
        outcome: "interrupted",
        runId: "stopped-run",
        clearLocalRun: true,
        armLocalTerminalReconcile: true,
        publishRunStatus: false,
      });
      if (replacementPending) {
        host.chatQueue = [
          {
            id: "replacement",
            text: "Next turn",
            createdAt: 0,
            sendState: "sending",
            sendRunId: "replacement-run",
          },
        ];
      }
      vi.mocked(host.requestUpdate!).mockClear();
      const warning = "The stopped reply could not be saved to history.";
      response.resolve({ aborted: true, warning });
      await stopped;
      expect(host.chatRunError?.summary).toBe(replacementPending ? undefined : warning);
      expect(host.requestUpdate).toHaveBeenCalledTimes(replacementPending ? 0 : 1);
    },
  );

  it.each(["run-embedded-finished", null])(
    "refreshes a session Stop with runId=%s when no active run remains",
    async (runId) => {
      const request = vi.fn(async () => ({
        ok: true,
        abortedRunId: null,
        status: "no-active-run",
      }));
      const refreshCurrentChat = vi.fn(async () => {});
      const host = makeAbortHost({
        client: createTestGatewayClient(request),
        chatRunId: runId,
        ...(runId
          ? { chatRunSessionAbortable: true }
          : {
              sessionsResult: makeSessionsResult([
                { key: "agent:main", hasActiveRun: true, status: "running" },
              ]),
            }),
        refreshCurrentChat,
      });

      await handleAbortChat(host, { preserveDraft: true });

      expect(request).toHaveBeenCalledExactlyOnceWith("sessions.abort", {
        key: "agent:main",
        ...(runId ? { runId } : { clearQueued: true }),
      });
      expect(refreshCurrentChat).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      mode: "online",
      outcome: "failure",
      alias: "default main",
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "agent:main:main",
    },
    {
      mode: "online",
      outcome: "no-active-run",
      alias: "configured home",
      defaultAgentId: "work",
      mainKey: "home",
      mainSessionKey: "agent:work:home",
    },
    {
      mode: "replay",
      outcome: "no-active-run",
      alias: "global home",
      defaultAgentId: "work",
      mainKey: "home",
      mainSessionKey: "global",
    },
  ] as const)(
    "keeps $mode Stop's $outcome response when Gateway defaults canonicalize $alias",
    async ({ mode, outcome, defaultAgentId, mainKey, mainSessionKey }) => {
      const response = createDeferred<unknown>();
      const request = vi.fn(() => response.promise);
      const refreshCurrentChat = vi.fn(async () => {});
      const host = makeAbortHost({
        client: createTestGatewayClient(request),
        connected: mode === "online",
        sessionKey: "main",
        assistantAgentId: defaultAgentId,
        hello: {
          ...sessionMutationGatewayHello(),
          snapshot: { sessionDefaults: { defaultAgentId, mainKey, mainSessionKey } },
        },
        chatRunId: "finished-run",
        refreshCurrentChat,
        chatMessage: "Keep this draft",
      });
      let operation: Promise<void | boolean> | undefined;
      try {
        if (mode === "replay") {
          await handleAbortChat(host, { preserveDraft: true });
          expect(request).not.toHaveBeenCalled();
          host.connected = true;
          operation = replayPendingChatAbort(host);
        } else {
          operation = handleAbortChat(host, { preserveDraft: true });
        }
        expect(request).toHaveBeenCalledExactlyOnceWith("chat.abort", {
          sessionKey: "main",
          ...(mainSessionKey === "global" ? { agentId: "work" } : {}),
          runId: "finished-run",
        });
        // Only route spelling changes; the captured Gateway defaults stay fixed.
        host.sessionKey = resolveSessionKey(host.sessionKey, host.hello);
        expect(host.sessionKey).toBe(mainSessionKey);
        if (outcome === "failure") {
          response.reject(new Error("Stop acknowledgement failed"));
        } else {
          response.resolve({ ok: true, aborted: false, runIds: [] });
        }
        await operation;
        expect(refreshCurrentChat).toHaveBeenCalledTimes(outcome === "no-active-run" ? 1 : 0);
        expect(host.chatError ?? null).toBe(
          outcome === "failure" ? "Stop acknowledgement failed" : null,
        );
        expect(host.lastError ?? null).toBe(host.chatError ?? null);
        expect(host.chatRunId).toBe("finished-run");
        expect(host.chatMessage).toBe("Keep this draft");
        expect(request).toHaveBeenCalledOnce();
      } finally {
        response.resolve({ aborted: true });
        await operation;
      }
    },
  );

  it.each(["session", "run", "agent"] as const)(
    "does not refresh replacement %s work after a session-only Stop",
    async (replacement) => {
      const response = createDeferred<{ status: string }>();
      const request = vi.fn(() => response.promise);
      const refreshCurrentChat = vi.fn(async () => {});
      const host = makeAbortHost({
        client: createTestGatewayClient(request),
        refreshCurrentChat,
        chatMessage: "Keep this draft",
        ...(replacement === "agent"
          ? {
              sessionKey: "global",
              assistantAgentId: "main",
              agentsList: { defaultId: "main", scope: "global" },
            }
          : replacement === "session"
            ? {
                sessionsResult: makeSessionsResult([
                  { key: "agent:main", hasActiveRun: true, status: "running" },
                ]),
              }
            : {}),
      });

      const stopped = handleAbortChat(host, { preserveDraft: true });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "sessions.abort",
        replacement === "agent"
          ? { key: "global", agentId: "main" }
          : { key: "agent:main", clearQueued: true },
      );
      if (replacement === "session") {
        host.sessionKey = "agent:other";
      } else if (replacement === "run") {
        host.chatRunId = "replacement-run";
      } else {
        host.assistantAgentId = "work";
      }
      response.resolve({ status: "no-active-run" });
      await stopped;

      expect(refreshCurrentChat).not.toHaveBeenCalled();
      expect(host.chatRunId).toBe(replacement === "run" ? "replacement-run" : null);
      expect(host.assistantAgentId).toBe(replacement === "agent" ? "work" : undefined);
      expect(host.chatMessage).toBe("Keep this draft");
    },
  );

  it("shows reconnect guidance when an offline session run has no browser run identity", async () => {
    const request = vi.fn();
    const client = createTestGatewayClient(request);
    const host = makeAbortHost({
      client,
      connected: false,
      chatMessage: "keep this draft",
      sessionsResult: makeSessionsResult([
        { key: "agent:main", hasActiveRun: true, status: "running" },
      ]),
    });

    expect(hasAbortableSessionRun(host)).toBe(true);
    await handleAbortChat(host, { preserveDraft: true });

    expect(host.chatError).toBe("Not connected. Try again after reconnecting.");
    expect(host.lastError).toBe(host.chatError);
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.pendingAbort).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps offline exact-run stops safely queued for reconnect", async () => {
    const request = vi.fn();
    const client = createTestGatewayClient(request);
    const host = makeAbortHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "@Alex keep this draft",
      chatMentions: [{ profileId: "alex-profile", start: 0, end: 5 }],
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      recoveryScope: client.recoveryScope,
      sessionKey: "agent:main",
      conversation: { sessionKey: "agent:main" },
      runId: "run-main",
    });
    expect(host.chatMessage).toBe("@Alex keep this draft");
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatMentions).toEqual([{ profileId: "alex-profile", start: 0, end: 5 }]);
    expect(host.chatError ?? null).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("replayPendingChatAbort", () => {
  it("dispatches a queued exact browser run stop through chat.abort", async () => {
    const request = vi.fn(async () => ({ aborted: true }));
    const client = createTestGatewayClient(request);
    const host = makeAbortHost({
      client,
      pendingAbort: {
        sourceClient: client,
        recoveryScope: client.recoveryScope,
        runId: "run-main",
        sessionKey: "global",
        agentId: "work",
        conversation: { sessionKey: "global", agentId: "work" },
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "global",
      agentId: "work",
      runId: "run-main",
    });
    expect(host.pendingAbort).toBeNull();
  });

  it.each([true, false])(
    "denies a queued stop on a read-only reconnect (same scope: %s)",
    async (sameScope) => {
      const request = vi.fn();
      const client = createTestGatewayClient(request);
      const host = makeAbortHost({
        client,
        sessionKey: sameScope ? "global" : "agent:main:replacement-chat",
        assistantAgentId: "work",
        agentsList: { defaultId: "main", scope: "global" },
        chatRunId: "run-main",
        chatError: "Current scope warning",
        lastError: "Current scope warning",
        hello: {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.read"] },
          features: { methods: ["chat.abort"] },
        },
        pendingAbort: {
          sourceClient: client,
          recoveryScope: client.recoveryScope,
          runId: "run-main",
          sessionKey: "global",
          agentId: "work",
          conversation: { sessionKey: "global", agentId: "work" },
        },
      });

      await expect(replayPendingChatAbort(host)).resolves.toBe(false);

      expect(request).not.toHaveBeenCalled();
      expect(host.pendingAbort).toBeNull();
      if (sameScope) {
        expect(host.chatError).toContain("operator.sessions.write");
      } else {
        expect(host.chatError).toBe("Current scope warning");
      }
      expect(host.lastError).toBe(host.chatError);
    },
  );

  it("discards a queued stop when the reconnect uses a replacement client", async () => {
    const sourceClient = createTestGatewayClient(vi.fn());
    const replacementRequest = vi.fn();
    const host = makeAbortHost({
      client: createTestGatewayClient(replacementRequest),
      pendingAbort: {
        sourceClient,
        recoveryScope: sourceClient.recoveryScope,
        runId: "run-main",
        sessionKey: "agent:main:telegram:direct:queued-user",
        conversation: { sessionKey: "agent:main:telegram:direct:queued-user", agentId: "main" },
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(replacementRequest).not.toHaveBeenCalled();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError ?? null).toBeNull();
  });
});

describe("abort rejection publication ownership", () => {
  it.each(["current", "disconnected", "session", "agent", "client", "run"] as const)(
    "keeps replayed abort failure with its captured scope after %s",
    async (transition) => {
      const response = createDeferred<unknown>();
      const request = vi.fn(() => response.promise);
      const client = createTestGatewayClient(request);
      const refreshCurrentChat = vi.fn(async () => {});
      const host = makeAbortHost({
        client,
        connected: false,
        sessionKey: "global",
        assistantAgentId: "main",
        agentsList: { defaultId: "main", scope: "global" },
        chatRunId: "original-run",
        chatMessage: "Keep this draft",
        refreshCurrentChat,
      });
      await handleAbortChat(host, { preserveDraft: true });
      expect(request).not.toHaveBeenCalled();
      expect(host.pendingAbort?.runId).toBe("original-run");
      host.connected = true;
      const operation = replayPendingChatAbort(host);
      try {
        expect(host.pendingAbort).toBeNull();
        expect(request).toHaveBeenCalledExactlyOnceWith("chat.abort", {
          sessionKey: "global",
          agentId: "main",
          runId: "original-run",
        });
        if (transition === "session") {
          host.sessionKey = "agent:main:replacement-chat";
        } else if (transition === "agent") {
          host.assistantAgentId = "work";
        } else if (transition === "client") {
          host.client = createTestGatewayClient(vi.fn());
        } else if (transition === "run") {
          host.chatRunId = "replacement-run";
        } else if (transition === "disconnected") {
          host.connected = false;
        }
        host.chatError = "Current scope warning";
        host.lastError = "Current scope warning";
        response.reject(new Error("Synthetic Stop acknowledgement failure"));
        await expect(operation).resolves.toBe(false);
        const stillOwned = transition === "current" || transition === "disconnected";
        expect(host.chatError).toBe(
          stillOwned ? "Synthetic Stop acknowledgement failure" : "Current scope warning",
        );
        expect(host.lastError).toBe(host.chatError);
        expect(host.chatMessage).toBe("Keep this draft");
        expect(host.chatRunId).toBe(transition === "run" ? "replacement-run" : "original-run");
        expect(refreshCurrentChat).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledOnce();
        expect(host.pendingAbort).toBeNull();
        await expect(replayPendingChatAbort(host)).resolves.toBe(false);
        expect(request).toHaveBeenCalledOnce();
      } finally {
        response.resolve({ aborted: true });
        await operation;
      }
    },
  );
});
