/* @vitest-environment jsdom */

import { ErrorCodes, GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";

async function createUnreadAcknowledgementHarness(
  options: {
    agentStatus?: GatewaySessionRow["agentStatus"];
    failRefresh?: boolean;
  } = {},
) {
  const key = "agent:main:current";
  const sessionId = "unread-session";
  const firstResponse = createDeferred<unknown>();
  const laterResponse = createDeferred<unknown>();
  let row: GatewaySessionRow & { updatedAt: number } = {
    key,
    sessionId,
    kind: "direct" as const,
    updatedAt: 20,
    unread: true,
    agentStatus: options.agentStatus,
    visibility: "shared" as const,
    sharingRole: "member" as const,
  };
  let requestCount = 0;
  const patchRequest = vi.fn(() => {
    requestCount += 1;
    return requestCount === 1 ? firstResponse.promise : laterResponse.promise;
  });
  let listRequests = 0;
  const client = createTestGatewayClient((method) => {
    if (method === "sessions.patch") {
      return patchRequest();
    }
    if (method === "sessions.list") {
      if (listRequests++ > 0 && options.failRefresh) {
        throw new Error("Synthetic roster unavailable");
      }
      return sessionsResult([row], row.updatedAt);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { pane, sessions, state, emitGatewayEvent } = createTestChatPane({ client });
  state.currentSessionId = sessionId;
  setChatHistoryLoad(state, {
    phase: "committed",
    sessions,
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: key,
    requestAgentId: undefined,
    sessionInfo: row,
  });
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
    publishActivity(
      updatedAt: number,
      fields: Pick<GatewaySessionRow, "agentStatus" | "markedUnreadAt"> = {},
    ) {
      row = { ...row, updatedAt, unread: true, ...fields };
      emitGatewayEvent("sessions.changed", { ...row, sessionKey: row.key, reason: "send" });
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
    const harness = await createUnreadAcknowledgementHarness();
    const { pane, sessions, patch, patchRequest, firstResponse } = harness;
    try {
      pane.applySessionsState(sessions.state);
      expect(patchRequest).toHaveBeenCalledTimes(1);
      expect(sessions.state.result?.sessions[0]?.unread).toBe(false);
      const firstPatch = patch.mock.results[0];
      if (firstPatch?.type !== "return") {
        throw new Error("Expected the automatic acknowledgement promise");
      }
      firstResponse.reject(error);
      await expect(firstPatch.value).rejects.toBe(error);

      // Rollback publishes synchronously, before the acknowledgement settles.
      expect(patchRequest).toHaveBeenCalledTimes(1);
      expect(sessions.state.result?.sessions[0]?.unread).toBe(true);
      expect(sessions.state.error).toBe(error.message);
      harness.publishActivity(21);
      expect(patchRequest).toHaveBeenCalledTimes(retries ? 2 : 1);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { name: "new activity", presented: true, markedUnreadAt: undefined, requests: 2 },
    { name: "hidden pane", presented: false, markedUnreadAt: undefined, requests: 1 },
    { name: "new manual reminder", presented: true, markedUnreadAt: 40, requests: 1 },
  ])(
    "settles successful reads with pending $name",
    async ({ presented, markedUnreadAt, requests }) => {
      const harness = await createUnreadAcknowledgementHarness();
      const { key, sessionId, firstResponse, pane, sessions, patch, patchRequest } = harness;
      try {
        pane.applySessionsState(sessions.state);
        expect(patchRequest).toHaveBeenCalledTimes(1);
        const firstPatch = patch.mock.results[0];
        if (firstPatch?.type !== "return") {
          throw new Error("Expected the automatic acknowledgement promise");
        }
        harness.publishActivity(40, { markedUnreadAt });
        pane.presented = presented;
        expect(patchRequest).toHaveBeenCalledTimes(1);
        firstResponse.resolve({
          ok: true,
          key,
          path: "",
          entry: { sessionId, updatedAt: 30, lastReadAt: 30, lastActivityAt: 20 },
        });
        await expect(firstPatch.value).resolves.toMatchObject({ ok: true });
        expect(patchRequest).toHaveBeenCalledTimes(requests);
        expect(sessions.state.result?.sessions[0]).toMatchObject({
          updatedAt: 40,
          unread: requests === 1,
        });
        expect(sessions.state.result?.sessions[0]?.markedUnreadAt).toBe(markedUnreadAt);
      } finally {
        await harness.close();
      }
    },
  );

  it.each([false, true])(
    "reconciles acknowledged agent status when refresh fails (newer status: %s)",
    async (hasNewerStatus) => {
      const initialStatus = { note: "Waiting for input", expiresAt: Date.now() + 60_000 };
      const newerStatus = hasNewerStatus
        ? { note: "New attention request", expiresAt: initialStatus.expiresAt + 1 }
        : undefined;
      const harness = await createUnreadAcknowledgementHarness({
        agentStatus: initialStatus,
        failRefresh: true,
      });
      const { key, sessionId, pane, sessions, patch, patchRequest, firstResponse } = harness;
      try {
        pane.applySessionsState(sessions.state);
        expect(patchRequest).toHaveBeenCalledTimes(1);
        const firstPatch = patch.mock.results[0];
        if (firstPatch?.type !== "return") {
          throw new Error("Expected the automatic acknowledgement promise");
        }
        if (newerStatus) {
          harness.publishActivity(40, { agentStatus: newerStatus });
        }
        firstResponse.resolve({
          ok: true,
          key,
          path: "",
          entry: { sessionId, updatedAt: 30, lastReadAt: 30, lastActivityAt: 20 },
        });
        await expect(firstPatch.value).resolves.toMatchObject({ ok: true });
        expect(sessions.state.error).toContain("Synthetic roster unavailable");

        // An unrelated publication must not revive status the Gateway cleared.
        pane.applySessionsState(sessions.state);
        expect(patchRequest).toHaveBeenCalledTimes(newerStatus ? 2 : 1);
        expect(sessions.state.result?.sessions[0]?.agentStatus).toEqual(newerStatus);
      } finally {
        await harness.close();
      }
    },
  );

  it("does not clear unread from a hidden retained pane", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture({ patch }),
    });
    const sessionsState = (presented: boolean) => {
      pane.presented = presented;
      pane.applySessionsState({
        result: sessionsResult(
          [
            {
              key: "agent:main:current",
              kind: "direct",
              label: "Background activity",
              updatedAt: 20,
              unread: true,
            },
          ],
          20,
        ),
        agentId: "main",
        loading: false,
        error: null,
        deletedSessions: [],
        modelOverrides: {},
        groups: [],
        groupSettings: [],
        sectionOrder: [],
      });
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
      result: sessionsResult([row], 20),
      agentId: "main",
      loading: false,
      error: null,
      deletedSessions: [],
      modelOverrides: {},
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    });
    pane.presented = true;

    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main", expectedMarkedUnreadAt: 20 },
    );
  });
});
