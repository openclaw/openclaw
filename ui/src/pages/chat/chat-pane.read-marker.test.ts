/* @vitest-environment jsdom */

import { ErrorCodes, GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";

function createReadMarkerPane(result: Record<string, never> | null = null) {
  const patch = vi.fn().mockResolvedValue(result);
  const { pane, state } = createTestChatPane({
    client: {} as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture({ patch }),
  });
  return { pane, state, patch };
}

describe("chat pane read markers", () => {
  it("does not turn optimistic read rollback into another patch during restart", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    onTestFinished(() => {
      clock.mockRestore();
      random.mockRestore();
    });
    const rejected = createDeferred<unknown>();
    const trailing = createDeferred<unknown>();
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "read-restart-session",
      kind: "direct",
      updatedAt: 20,
      unread: true,
    };
    const patch = vi.fn().mockReturnValueOnce(rejected.promise).mockReturnValue(trailing.promise);
    const { pane, sessions } = createTestChatPane({
      client: createTestGatewayClient((method) => {
        if (method === "sessions.list") {
          return sessionsResult([row], 20);
        }
        if (method === "sessions.patch") {
          return patch();
        }
        return {};
      }),
    });
    onTestFinished(() => sessions.dispose());
    await sessions.refresh({ force: true });
    onTestFinished(sessions.subscribe((state) => pane.applySessionsState(state)));
    pane.applySessionsState(sessions.state);
    expect(patch).toHaveBeenCalledOnce();

    rejected.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "sessions.patch unavailable during gateway restart",
        retryable: true,
        retryAfterMs: 1_000,
        details: { reason: "gateway-restarting" },
      }),
    );
    await rejected.promise.catch(() => undefined);
    // Drain the mutation, its rollback publications, and the pane's completion handler.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(patch).toHaveBeenCalledOnce();
    clock.mockReturnValue(1_099);
    for (let update = 0; update < 40; update += 1) {
      pane.applySessionsState(sessions.state);
    }
    expect(patch).toHaveBeenCalledOnce();
    clock.mockReturnValue(1_100);
    pane.applySessionsState(sessions.state);
    expect(patch).toHaveBeenCalledTimes(2);
    for (let update = 0; update < 40; update += 1) {
      pane.applySessionsState(sessions.state);
    }
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { restartPending: true },
    { suspensionPhase: "preparing" as const },
    { suspensionPhase: "draining" as const },
    { suspensionPhase: "prepared" as const },
  ])("pauses parent and hidden-run acknowledgements while unavailable: %j", (unavailable) => {
    const { pane, state, patch } = createReadMarkerPane({});
    const row: GatewaySessionRow = { key: state.sessionKey, kind: "direct", unread: true };
    state.sessionsResult = sessionsResult(
      [
        row,
        {
          key: "agent:main:subagent:background",
          kind: "direct",
          spawnedBy: row.key,
          status: "done",
          unread: true,
          updatedAt: 20,
        },
      ],
      20,
    );
    Object.assign(pane.context.gateway.snapshot, unavailable);
    for (let update = 0; update < 40; update += 1) {
      pane.markSessionRead(row);
    }
    expect(patch).not.toHaveBeenCalled();
    Object.assign(pane.context.gateway.snapshot, {
      restartPending: false,
      suspensionPhase: "accepting",
    });
    pane.markSessionRead(row);
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("marks an unread failure read even when its regular unread flag is false", () => {
    const { pane, patch } = createReadMarkerPane();

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
    const { pane, patch } = createReadMarkerPane();

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
    const { pane, state, patch } = createReadMarkerPane();
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
    const { pane, patch } = createReadMarkerPane({});
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
    const { pane, patch } = createReadMarkerPane();
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
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    onTestFinished(() => clock.mockRestore());
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
    clock.mockReturnValue(600);
    pane.markSessionRead({ ...row, updatedAt: 21 });
    if (retries) {
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    }

    expect(request).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(errors).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(context.sessions.state.error).toBe(error.message);
  });

  it("does not clear unread from a hidden retained pane", () => {
    const { pane, patch } = createReadMarkerPane();
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

  it("acknowledges a manual unread marker when a retained pane is presented again", () => {
    const { pane, patch } = createReadMarkerPane({});
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

  describe("hidden runs folded into the parent", () => {
    const parentKey = "agent:main:current";
    const parent: GatewaySessionRow = {
      key: parentKey,
      kind: "direct",
      updatedAt: 10,
      unread: false,
    };
    const run = (name: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
      key: `agent:main:subagent:${name}`,
      kind: "direct",
      spawnedBy: parentKey,
      updatedAt: 20,
      status: "done",
      unread: true,
      ...extra,
    });

    function createParentPane(rows: GatewaySessionRow[]) {
      const pane = createReadMarkerPane({});
      pane.state.sessionsResult = sessionsResult([parent, ...rows], 20);
      return pane;
    }

    it("acknowledges unread hidden runs when the parent is already read", () => {
      const nested = run("nested", { spawnedBy: "agent:main:subagent:done" });
      const { pane, patch } = createParentPane([run("done"), nested]);

      pane.markSessionRead(parent);
      pane.markSessionRead(parent);

      expect(patch.mock.calls).toEqual([
        [
          "agent:main:subagent:done",
          { unread: false },
          { agentId: "main", expectedMarkedUnreadAt: null },
        ],
        [nested.key, { unread: false }, { agentId: "main", expectedMarkedUnreadAt: null }],
      ]);
    });

    it("does not acknowledge a hidden child's active attention when its parent opens", () => {
      const blocked = run("blocked", {
        agentStatus: {
          note: "Waiting for debugger authentication",
          attention: "key",
          expiresAt: Date.now() + 60_000,
        },
      });
      const { pane, state, patch } = createParentPane([blocked]);
      pane.markSessionRead(parent);
      expect(patch).not.toHaveBeenCalled();
      state.sessionsResult = sessionsResult([parent, { ...blocked, agentStatus: undefined }], 21);
      pane.markSessionRead(parent);
      expect(patch).toHaveBeenCalledExactlyOnceWith(
        blocked.key,
        { unread: false },
        { agentId: "main", expectedMarkedUnreadAt: null },
      );
    });

    it("leaves persistent children, read runs, failures, and manual markers unread", () => {
      const { pane, patch } = createParentPane([
        {
          key: "agent:main:dashboard:child",
          kind: "direct",
          parentSessionKey: parentKey,
          spawnedBy: parentKey,
          updatedAt: 20,
          unread: true,
        },
        run("read", { unread: false }),
        run("failed", { status: "failed" }),
        run("marked", { markedUnreadAt: 15 }),
      ]);

      pane.markSessionRead(parent);

      expect(patch).not.toHaveBeenCalled();
    });

    it("acknowledges newer run activity only on a later read", () => {
      const { pane, state, patch } = createParentPane([run("done", { unread: false })]);

      pane.markSessionRead(parent);
      expect(patch).not.toHaveBeenCalled();

      state.sessionsResult = sessionsResult([parent, run("done", { updatedAt: 30 })], 30);
      pane.markSessionRead(parent);

      expect(patch).toHaveBeenCalledOnce();
      expect(patch).toHaveBeenCalledWith(
        "agent:main:subagent:done",
        { unread: false },
        { agentId: "main", expectedMarkedUnreadAt: null },
      );
    });

    it.each([
      { code: ErrorCodes.UNAVAILABLE, calls: 2 },
      { code: ErrorCodes.INVALID_REQUEST, calls: 1 },
    ])(
      "retries a hidden run after a $code failure only when transient",
      async ({ code, calls }) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(0);
        onTestFinished(() => clock.mockRestore());
        const { pane, patch } = createParentPane([run("done")]);
        patch.mockRejectedValueOnce(new GatewayRequestError({ code, message: "ack failed" }));

        pane.markSessionRead(parent);
        await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
        await Promise.resolve();
        clock.mockReturnValue(600);
        pane.markSessionRead(parent);

        expect(patch).toHaveBeenCalledTimes(calls);
      },
    );

    it("does not acknowledge hidden runs from a parent the caller only views", () => {
      const { pane, patch } = createParentPane([run("done")]);

      pane.markSessionRead({ ...parent, visibility: "shared", sharingRole: "viewer" });

      expect(patch).not.toHaveBeenCalled();
    });
  });
});
