// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  hasDirectSessionRun,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";

function makeSessionsResult(rows: (Pick<GatewaySessionRow, "key"> & Partial<GatewaySessionRow>)[]) {
  return sessionsResult(
    rows.map<GatewaySessionRow>((row) => ({ kind: "direct", updatedAt: 1, ...row })),
    1,
  );
}

describe("hasAbortableSessionRun", () => {
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

type AbortHost = Parameters<typeof replayPendingChatAbort>[0];

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
  it("dispatches sessions.abort when only descendant work remains", async () => {
    const request = vi.fn(async () => ({ status: "aborted" }));
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      chatMessage: "@Alex interrupted draft",
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
    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:main",
      clearQueued: true,
    });
    expect(host.chatMessage).toBe("");
    expect(host.chatMentions).toEqual([]);
  });

  it("routes recovered embedded Stop through sessions.abort with its run id", async () => {
    const request = vi.fn(async () => ({ status: "aborted" }));
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      chatRunId: "run-embedded-recovered",
      chatRunSessionAbortable: true,
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:main",
      runId: "run-embedded-recovered",
    });
    expect(request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
  });

  it("settles through the authoritative refresh when chat.abort reports nothing to abort", async () => {
    // The Gateway finished this run, but its lifecycle notifications never reached the browser.
    const request = vi.fn(async () => ({ ok: true, aborted: false, runIds: [] }));
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      chatRunId: "run-finished",
      refreshCurrentChat,
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "agent:main",
      runId: "run-finished",
    });
    expect(refreshCurrentChat).toHaveBeenCalledTimes(1);
    // Only the refreshed Gateway row may clear the run; a finalizing run keeps ownership.
    expect(host.chatRunId).toBe("run-finished");
    expect(host.chatError ?? null).toBeNull();
  });

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

  it("settles a recovered embedded run when sessions.abort reports no active run", async () => {
    const request = vi.fn(async () => ({ ok: true, abortedRunId: null, status: "no-active-run" }));
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      chatRunId: "run-embedded-finished",
      chatRunSessionAbortable: true,
      refreshCurrentChat,
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:main",
      runId: "run-embedded-finished",
    });
    expect(refreshCurrentChat).toHaveBeenCalledTimes(1);
  });

  it("settles a session-only Stop when sessions.abort reports no active run", async () => {
    // Cached session activity keeps Stop visible without a browser-owned run ID.
    const request = vi.fn(async () => ({ ok: true, abortedRunId: null, status: "no-active-run" }));
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      chatRunId: null,
      refreshCurrentChat,
      sessionsResult: makeSessionsResult([
        { key: "agent:main", hasActiveRun: true, status: "running" },
      ]),
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:main",
      clearQueued: true,
    });
    expect(refreshCurrentChat).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a session the Stop was not captured for", async () => {
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      chatRunId: null,
      refreshCurrentChat,
      sessionsResult: makeSessionsResult([
        { key: "agent:main", hasActiveRun: true, status: "running" },
      ]),
    });
    // The selection moves to another session while the abort is in flight.
    host.client = createTestGatewayClient(
      vi.fn(async () => {
        host.sessionKey = "agent:other";
        return { ok: true, abortedRunId: null, status: "no-active-run" };
      }),
    );

    await handleAbortChat(host, { preserveDraft: true });

    expect(refreshCurrentChat).not.toHaveBeenCalled();
  });

  it("does not refresh replacement work after a session-only Stop", async () => {
    const response = createDeferred<{ status: string }>();
    const request = vi.fn(() => response.promise);
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      refreshCurrentChat,
      chatMessage: "Keep this draft",
    });

    const stopped = handleAbortChat(host, { preserveDraft: true });
    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:main",
      clearQueued: true,
    });
    host.chatRunId = "replacement-run";
    response.resolve({ status: "no-active-run" });
    await stopped;

    expect(refreshCurrentChat).not.toHaveBeenCalled();
    expect(host.chatRunId).toBe("replacement-run");
    expect(host.chatMessage).toBe("Keep this draft");
  });

  it("does not refresh another global agent after a session-only Stop", async () => {
    const response = createDeferred<{ status: string }>();
    const request = vi.fn(() => response.promise);
    const refreshCurrentChat = vi.fn(async () => {});
    const host = makeAbortHost({
      client: createTestGatewayClient(request),
      refreshCurrentChat,
      sessionKey: "global",
      assistantAgentId: "main",
      agentsList: { defaultId: "main", scope: "global" },
    });

    const stopped = handleAbortChat(host, { preserveDraft: true });
    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "global",
      agentId: "main",
    });
    host.assistantAgentId = "work";
    response.resolve({ status: "no-active-run" });
    await stopped;

    expect(refreshCurrentChat).not.toHaveBeenCalled();
    expect(host.assistantAgentId).toBe("work");
  });

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
      sessionKey: "agent:main",
      runId: "run-main",
    });
    expect(host.chatMessage).toBe("@Alex keep this draft");
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
        runId: "run-main",
        sessionKey: "global",
        agentId: "work",
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

  it("denies a queued exact-run stop when the reconnect is read-only", async () => {
    const request = vi.fn();
    const client = createTestGatewayClient(request);
    const host = makeAbortHost({
      client,
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["chat.abort"] },
      },
      pendingAbort: {
        sourceClient: client,
        runId: "run-main",
        sessionKey: "global",
        agentId: "work",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError).toContain("operator.write");
    expect(host.lastError).toBe(host.chatError);
  });

  it("consumes an ambiguously failed exact-run stop without retrying it", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway closed before acknowledgement");
    });
    const client = createTestGatewayClient(request);
    const host = makeAbortHost({
      client,
      pendingAbort: {
        sourceClient: client,
        runId: "run-main",
        sessionKey: "agent:main:telegram:direct:queued-user",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(request).toHaveBeenCalledOnce();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError).toBe("gateway closed before acknowledgement");
    expect(host.lastError).toBe("gateway closed before acknowledgement");
  });

  it("discards a queued stop when the reconnect uses a replacement client", async () => {
    const sourceClient = createTestGatewayClient(vi.fn());
    const replacementRequest = vi.fn();
    const host = makeAbortHost({
      client: createTestGatewayClient(replacementRequest),
      pendingAbort: {
        sourceClient,
        runId: "run-main",
        sessionKey: "agent:main:telegram:direct:queued-user",
      },
    });

    await expect(replayPendingChatAbort(host)).resolves.toBe(false);

    expect(replacementRequest).not.toHaveBeenCalled();
    expect(host.pendingAbort).toBeNull();
    expect(host.chatError ?? null).toBeNull();
  });
});
