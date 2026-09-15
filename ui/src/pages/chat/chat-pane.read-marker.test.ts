/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";

async function createUnreadAcknowledgementHarness(markedUnreadAt?: number) {
  const key = "agent:main:current";
  const sessionId = "unread-session";
  const firstResponse = createDeferred<unknown>();
  const laterResponse = createDeferred<unknown>();
  let row = {
    key,
    sessionId,
    kind: "direct" as const,
    updatedAt: 20,
    unread: true,
    markedUnreadAt,
    visibility: "shared" as const,
    sharingRole: "viewer" as const,
  };
  let requestCount = 0;
  const patchRequest = vi.fn(() => {
    requestCount += 1;
    return requestCount === 1 ? firstResponse.promise : laterResponse.promise;
  });
  const client = createTestGatewayClient((method) => {
    if (method === "sessions.patch") {
      return patchRequest();
    }
    if (method === "sessions.list") {
      return sessionsResult([row], row.updatedAt);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { pane, sessions } = createTestChatPane({ client });
  const patch = vi.spyOn(sessions, "patch");
  await sessions.refresh({ force: true });
  const unsubscribe = sessions.subscribe(pane.applySessionsState.bind(pane));
  return {
    key,
    sessionId,
    firstResponse,
    pane,
    sessions,
    patch,
    patchRequest,
    publishActivity(updatedAt: number) {
      row = { ...row, updatedAt, unread: true };
      sessions.reconcileChanged({ ...row, reason: "send" });
    },
    async close() {
      unsubscribe();
      sessions.dispose();
      // A regression may dispatch during settlement; keep later requests bounded until disposal.
      firstResponse.resolve(null);
      laterResponse.resolve(null);
      await Promise.allSettled(
        patch.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
      );
    },
  };
}

describe("chat pane read markers", () => {
  it("marks an unread failure read even when its regular unread flag is false", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });

    pane.markSessionRead({
      key: "agent:main:current",
      kind: "direct",
      label: "Failed run",
      updatedAt: 20,
      endedAt: 20,
      status: "failed",
      unread: false,
    });

    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main", expectedMarkedUnreadAt: null },
    );
  });

  it("marks an active agent status read even without other unread state", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });

    pane.markSessionRead({
      key: "agent:main:current",
      kind: "direct",
      label: "Waiting",
      updatedAt: 20,
      unread: false,
      agentStatus: { note: "Need the staging password", expiresAt: Date.now() + 60_000 },
    });

    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main", expectedMarkedUnreadAt: null },
    );
  });

  it.each([
    {
      name: "read-only scope",
      methods: ["sessions.patch"],
      scopes: ["operator.read"],
      session: {},
    },
    {
      name: "unadvertised sessions.patch",
      methods: ["sessions.create"],
      scopes: ["operator.write"],
      session: {},
    },
    ...(["read-only", "suggest", "draft"] as const).map((visibility) => ({
      name: `${visibility} viewer participation`,
      methods: ["sessions.patch"],
      scopes: ["operator.write"],
      session: { visibility, sharingRole: "viewer" as const },
    })),
    {
      name: "draft member participation",
      methods: ["sessions.patch"],
      scopes: ["operator.write"],
      session: { visibility: "draft" as const, sharingRole: "member" as const },
    },
  ])("does not mutate unread state with $name", ({ methods, scopes, session }) => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes },
      features: { methods },
    } as ApplicationGatewaySnapshot["hello"];
    const row = {
      key: "agent:main:current",
      kind: "direct" as const,
      updatedAt: 20,
      unread: true,
      ...session,
    };

    pane.markSessionRead(row);
    pane.markSessionRead(row);

    expect(patch).not.toHaveBeenCalled();
    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it.each([
    { visibility: "shared", sharingRole: "viewer", scopes: ["operator.write"] },
    { visibility: "read-only", sharingRole: "member", scopes: ["operator.write"] },
    { visibility: "draft", sharingRole: "owner", scopes: ["operator.write"] },
    { visibility: "draft", sharingRole: "admin", scopes: ["operator.admin"] },
  ] as const)("acknowledges unread state for $visibility $sharingRole", (session) => {
    const patch = vi.fn().mockResolvedValue({});
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: [...session.scopes] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationGatewaySnapshot["hello"];
    const row = {
      key: "agent:main:current",
      kind: "direct" as const,
      updatedAt: 20,
      unread: true,
      visibility: session.visibility,
      sharingRole: session.sharingRole,
    };

    pane.markSessionRead(row);
    pane.markSessionRead(row);

    expect(patch).toHaveBeenCalledExactlyOnceWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main", expectedMarkedUnreadAt: null },
    );
  });

  it("retries the read patch after a null (unsent) resolution", async () => {
    // sessions.patch resolves null without a request when the connection
    // scope is lost; the guard must unlatch like a failure or the badge
    // stays lit until navigation.
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });
    const row = {
      key: "agent:main:current",
      kind: "direct" as const,
      label: "Unread",
      updatedAt: 20,
      unread: true,
    };

    pane.markSessionRead(row);
    await Promise.resolve();
    pane.markSessionRead(row);

    expect(patch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "activity unread", markedUnreadAt: undefined },
    { name: "manual unread", markedUnreadAt: 100 },
  ])("does not retry $name from its own rejected acknowledgement", async ({ markedUnreadAt }) => {
    const harness = await createUnreadAcknowledgementHarness(markedUnreadAt);
    const { key, firstResponse, pane, sessions, patch, patchRequest } = harness;
    try {
      pane.applySessionsState(sessions.state);
      expect(patchRequest).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith(
        key,
        { unread: false },
        { agentId: "main", expectedMarkedUnreadAt: markedUnreadAt ?? null },
      );

      firstResponse.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session is shared for this connection",
          details: {
            code: "SESSION_PARTICIPATION_REQUIRED",
            sessionKey: key,
            visibility: "shared",
          },
        }),
      );
      await vi.waitFor(() => {
        expect(sessions.state.error).toContain("session is shared for this connection");
      });

      expect(patchRequest).toHaveBeenCalledTimes(1);
      expect(sessions.state.result?.sessions[0]?.unread).toBe(true);

      harness.publishActivity(21);
      expect(patchRequest).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it("settles a successful acknowledgement without consuming newer unread activity", async () => {
    const harness = await createUnreadAcknowledgementHarness();
    const { key, sessionId, firstResponse, pane, sessions, patch, patchRequest } = harness;
    try {
      pane.applySessionsState(sessions.state);
      expect(patchRequest).toHaveBeenCalledTimes(1);
      const firstPatch = patch.mock.results[0];
      if (firstPatch?.type !== "return") {
        throw new Error("Expected the automatic acknowledgement promise");
      }

      harness.publishActivity(40);
      expect(patchRequest).toHaveBeenCalledTimes(1);
      firstResponse.resolve({
        ok: true,
        key,
        path: "",
        entry: { sessionId, updatedAt: 30, lastReadAt: 30, lastActivityAt: 20 },
      });
      await expect(firstPatch.value).resolves.toMatchObject({ ok: true });

      expect(patchRequest).toHaveBeenCalledTimes(1);
      expect(sessions.state.result?.sessions[0]).toMatchObject({ updatedAt: 40, unread: true });
      harness.publishActivity(41);
      expect(patchRequest).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it("does not clear unread from a hidden retained pane", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });
    const sessionsState = (presented: boolean) => {
      pane.presented = presented;
      pane.applySessionsState({
        result: {
          sessions: [
            {
              key: "agent:main:current",
              kind: "direct",
              label: "Background activity",
              updatedAt: 20,
              unread: true,
            },
          ],
        },
        agentId: "main",
        loading: false,
        error: null,
        deletedSessions: [],
      } as unknown as Parameters<typeof pane.applySessionsState>[0]);
    };

    // Hidden retained panes keep the subscription alive but must not mark
    // the session read — the user is not looking at it.
    sessionsState(false);
    expect(patch).not.toHaveBeenCalled();

    sessionsState(true);
    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main", expectedMarkedUnreadAt: null },
    );
  });

  it("preserves a manual unread marker received after activation", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });

    pane.markSessionRead({
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 10,
      unread: false,
    });
    pane.markSessionRead({
      key: "agent:main:current",
      kind: "direct",
      markedUnreadAt: 20,
      updatedAt: 20,
      unread: true,
    });

    expect(patch).not.toHaveBeenCalled();
  });

  it("acknowledges a manual unread marker when a retained pane is presented again", () => {
    const patch = vi.fn().mockResolvedValue({});
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });
    const row = {
      key: "agent:main:current",
      kind: "direct" as const,
      markedUnreadAt: 20,
      updatedAt: 20,
      unread: true,
    };

    pane.markSessionRead({ ...row, markedUnreadAt: undefined, unread: false });
    pane.markSessionRead(row);
    expect(patch).not.toHaveBeenCalled();

    pane.presented = false;
    pane.applySessionsState({
      result: { sessions: [row] },
      agentId: "main",
      loading: false,
      error: null,
      deletedSessions: [],
    } as unknown as Parameters<typeof pane.applySessionsState>[0]);
    pane.presented = true;

    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main", expectedMarkedUnreadAt: 20 },
    );
  });
});
