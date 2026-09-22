/* @vitest-environment jsdom */

import { ErrorCodes, GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";

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
    ...(["shared", "read-only", "suggest", "draft", undefined] as const).map((visibility) => ({
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
      agentStatus: { note: "Working", expiresAt: Date.now() + 60_000 },
      ...session,
    };

    pane.markSessionRead(row);
    pane.markSessionRead(row);

    expect(patch).not.toHaveBeenCalled();
    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it.each([
    { visibility: "shared", sharingRole: "member", scopes: ["operator.write"] },
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
    { code: ErrorCodes.INVALID_REQUEST, retries: false },
    { code: ErrorCodes.FORBIDDEN, retries: false },
    { code: ErrorCodes.APPROVAL_NOT_FOUND, retries: false },
    { code: ErrorCodes.UNAVAILABLE, retries: true },
    { code: "CLIENT_TIMEOUT", retries: true },
  ])("handles $code read failures across active snapshots", async ({ code, retries }) => {
    const error =
      code === "CLIENT_TIMEOUT"
        ? new GatewayProtocolRequestTimeoutError({
            method: "sessions.patch",
            timeoutMs: 1000,
            requestSent: true,
          })
        : new GatewayRequestError({ code, message: "Read acknowledgement rejected" });
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        throw error;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { pane } = createTestChatPane({ client: createTestGatewayClient(request) });
    const { context } = pane;
    const errors = vi.fn();
    onTestFinished(
      context.sessions.subscribe((state) => {
        if (state.error) {
          errors(state.error);
        }
      }),
    );
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 20,
      unread: true,
      agentStatus: { note: "Working", expiresAt: Date.now() + 60_000 },
    };

    pane.markSessionRead(row);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    pane.markSessionRead({ ...row, updatedAt: 21 });
    if (retries) {
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    }

    expect(request).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(errors).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(context.sessions.state.error).toBe(error.message);
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
