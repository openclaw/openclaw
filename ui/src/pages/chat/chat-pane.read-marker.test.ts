/* @vitest-environment jsdom */

import { ErrorCodes, GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { withSessionMutationOperations } from "../../lib/sessions/session-mutation-operations.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";

const sessionKey = "agent:main:current";
const unreadRow = (extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: sessionKey,
  kind: "direct",
  updatedAt: 20,
  unread: true,
  ...extra,
});
const activeStatus = () => ({ note: "Working", expiresAt: Date.now() + 60_000 });
function authorize(
  pane: ReturnType<typeof createTestChatPane>["pane"],
  scopes: string[],
  methods = ["sessions.patch"],
) {
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes },
    features: { methods },
  } as ApplicationGatewaySnapshot["hello"];
}
function expectRead(
  patch: ReturnType<typeof vi.fn>,
  key = sessionKey,
  marked: number | null = null,
) {
  expect(patch).toHaveBeenCalledWith(
    key,
    { unread: false },
    { agentId: "main", expectedMarkedUnreadAt: marked },
  );
}
const observedSessions = (rows: GatewaySessionRow[]) => ({
  result: sessionsResult(rows, 20),
  agentId: "main",
  loading: false,
  error: null,
  deletedSessions: [],
  modelOverrides: {},
  groups: [],
  groupSettings: [],
  sectionOrder: [],
});

function commitReadMarkerHistory(
  pane: ReturnType<typeof createTestChatPane>["pane"],
  row: GatewaySessionRow = unreadRow({ sessionId: "read-marker-session" }),
) {
  const state = pane.state;
  const client = state.client;
  if (!client) {
    throw new Error("Read-marker fixture requires a connected client");
  }
  state.currentSessionId = row.sessionId;
  setChatHistoryLoad(state, {
    phase: "committed",
    sessions: state.sessions,
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    requestAgentId: undefined,
    sessionInfo: row,
  });
}

function createReadMarkerPane(result: Record<string, never> | null = null) {
  const patch = vi.fn().mockResolvedValue(result);
  const { pane, state } = createTestChatPane({
    client: {} as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture({ patch }),
  });
  commitReadMarkerHistory(pane);
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
    const row = unreadRow({ sessionId: "read-restart-session" });
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
    commitReadMarkerHistory(pane, row);
    await sessions.refresh({ force: true });
    onTestFinished(sessions.subscribe((state) => pane.applySessionsState(state)));
    pane.applySessionsState(sessions.state);
    expect(sessions.state.result?.sessions[0]?.unread).toBe(false);
    await withSessionMutationOperations(() => undefined);
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

  it("pauses parent and hidden-run acknowledgements during restart", () => {
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
    Object.assign(pane.context.gateway.snapshot, { restartPending: true });
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

    expectRead(patch);
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
    {
      name: "shared viewer participation",
      methods: ["sessions.patch"],
      scopes: ["operator.write"],
      session: { visibility: "shared" as const, sharingRole: "viewer" as const },
    },
    {
      name: "draft member participation",
      methods: ["sessions.patch"],
      scopes: ["operator.write"],
      session: { visibility: "draft" as const, sharingRole: "member" as const },
    },
    {
      name: "foreign session with narrow write scope",
      methods: ["sessions.patch"],
      scopes: ["operator.sessions.write"],
      session: { visibility: "shared" as const, sharingRole: "member" as const },
    },
  ])("does not mutate unread state with $name", ({ methods, scopes, session }) => {
    const { pane, state, patch } = createReadMarkerPane();
    authorize(pane, scopes, methods);
    const row = unreadRow({ agentStatus: activeStatus(), ...session });

    pane.markSessionRead(row);
    pane.markSessionRead(row);

    expect(patch).not.toHaveBeenCalled();
    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it.each([
    { visibility: "read-only", sharingRole: "member", scopes: ["operator.write"] },
    { visibility: "draft", sharingRole: "owner", scopes: ["operator.write"] },
    { visibility: "draft", sharingRole: "owner", scopes: ["operator.sessions.write"] },
  ] as const)("acknowledges unread state for $visibility $sharingRole", (session) => {
    const { pane, patch } = createReadMarkerPane({});
    authorize(pane, [...session.scopes]);
    const row = unreadRow({ visibility: session.visibility, sharingRole: session.sharingRole });

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
    const row = unreadRow({ label: "Unread" });

    pane.markSessionRead(row);
    await Promise.resolve();
    pane.markSessionRead(row);

    expect(patch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: ErrorCodes.INVALID_REQUEST, retries: false },
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
    commitReadMarkerHistory(pane);
    const { context } = pane;
    const errors = vi.fn();
    onTestFinished(
      context.sessions.subscribe((state) => {
        if (state.error) {
          errors(state.error);
        }
      }),
    );
    const row = unreadRow({ agentStatus: activeStatus() });

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
      Object.assign(
        pane.context.sessions.state,
        observedSessions([unreadRow({ label: "Background activity" })]),
      );
      pane.applySessionsState(pane.context.sessions.state);
    };

    // Hidden retained panes keep the subscription alive but must not mark
    // the session read — the user is not looking at it.
    sessionsState(false);
    expect(patch).not.toHaveBeenCalled();

    sessionsState(true);
    expectRead(patch);
  });

  it("acknowledges a manual unread marker when a retained pane is presented again", () => {
    const { pane, patch } = createReadMarkerPane({});
    const row = unreadRow({ markedUnreadAt: 20 });

    pane.markSessionRead({ ...row, markedUnreadAt: undefined, unread: false });
    pane.markSessionRead(row);
    expect(patch).not.toHaveBeenCalled();

    pane.presented = false;
    Object.assign(pane.context.sessions.state, observedSessions([row]));
    pane.applySessionsState(pane.context.sessions.state);
    pane.presented = true;

    expectRead(patch, sessionKey, 20);
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

    it.each(["operator.write", "operator.sessions.write"])(
      "acknowledges newer owned run activity only on a later read with %s",
      (scope) => {
        const { pane, state, patch } = createParentPane([run("done", { unread: false })]);
        authorize(pane, [scope]);
        const ownedParent = { ...parent, sharingRole: "owner" as const };

        pane.markSessionRead(ownedParent);
        expect(patch).not.toHaveBeenCalled();

        state.sessionsResult = sessionsResult(
          [ownedParent, run("done", { updatedAt: 30, sharingRole: "owner" })],
          30,
        );
        pane.markSessionRead(ownedParent);

        expect(patch).toHaveBeenCalledOnce();
        expectRead(patch, "agent:main:subagent:done");
      },
    );

    it("retries a hidden run after a transient UNAVAILABLE failure", async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(0);
      onTestFinished(() => clock.mockRestore());
      const { pane, patch } = createParentPane([run("done")]);
      patch.mockRejectedValueOnce(
        new GatewayRequestError({ code: ErrorCodes.UNAVAILABLE, message: "ack failed" }),
      );

      pane.markSessionRead(parent);
      await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
      await Promise.resolve();
      clock.mockReturnValue(600);
      pane.markSessionRead(parent);

      expect(patch).toHaveBeenCalledTimes(2);
    });
  });
});
