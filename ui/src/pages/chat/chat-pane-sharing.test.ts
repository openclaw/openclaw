/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-sharing.test/"} */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
} from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOutcome } from "../../lib/sessions/session-capability.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  ChatSessionSharingState,
  ChatSessionSharingOutcome,
} from "./components/chat-session-sharing-shared.tsx";

const { confirmPublicShare, copyPublicShare } = vi.hoisted(() => ({
  confirmPublicShare: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  copyPublicShare: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: confirmPublicShare }));
vi.mock("../../lib/clipboard.ts", () => ({ copyToClipboard: copyPublicShare }));
afterEach(() => {
  confirmPublicShare.mockReset();
  copyPublicShare.mockReset();
});

type SharingPane = TestChatPane & {
  loadSessionSharing: (row: GatewaySessionRow, force?: boolean) => Promise<void>;
  syncSelectedSessionSharing: (row: GatewaySessionRow | undefined) => void;
  sessionSharingCacheKey: (sessionKey: string) => string;
  mutateSessionSharing: (
    row: GatewaySessionRow,
    change: { visibility: SessionVisibility } | { identityId: string; member: boolean },
  ) => Promise<ChatSessionSharingOutcome>;
  setSessionPublicShare: (
    row: GatewaySessionRow,
    enabled: boolean,
  ) => Promise<ChatSessionSharingOutcome>;
  copySessionPublicLink: (row: GatewaySessionRow) => Promise<ChatSessionSharingOutcome>;
};

const SHARING_METHODS = [
  "session.visibility.set",
  "session.members.listEvidence",
  "session.members.add",
  "session.publicShare.set",
];

function setSharingAuthorization(
  pane: SharingPane,
  {
    methods = SHARING_METHODS,
    phase = "connected",
    scopes = ["operator.admin"],
  }: {
    methods?: string[];
    phase?: "connected" | "reconnecting";
    scopes?: string[];
  } = {},
): void {
  const snapshot = pane.context.gateway.snapshot;
  snapshot.phase = phase;
  snapshot.hello = {
    ...snapshot.hello,
    auth: { role: "operator", scopes },
    features: { ...snapshot.hello?.features, methods },
  } as typeof snapshot.hello;
}

function sharingPane(
  request: GatewayRequestHandler,
  sessions = createSessionCapabilityFixture(),
  gatewayUrl?: string,
) {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request, ...(gatewayUrl ? { gatewayUrl } : {}) }),
    sessions,
  });
  const pane = result.pane as SharingPane;
  setSharingAuthorization(pane);
  result.state.sessionsResult = sharingSessionsResult(sessionRow());
  result.state.sessionsResultAgentId = "main";
  return { ...result, pane };
}

function refreshingSessions() {
  return createSessionCapabilityFixture({
    reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
  });
}

function expectReplacementUntouched(
  pane: SharingPane,
  replacement: ReturnType<typeof installReplacementConnection>,
) {
  expect(replacement.request).not.toHaveBeenCalled();
  expect(replacement.sessions.reconcileMutation).not.toHaveBeenCalled();
  expect(pane.collaboration.sharingStates.get(replacement.cacheKey)).toBe(replacement.sharingState);
}

function pendingMutation(mutation: (typeof mutations)[number]) {
  const response = createDeferred<unknown>();
  const request = vi.fn((method: string) => {
    if (method !== mutation.method) {
      throw new Error(`unexpected request: ${method}`);
    }
    return response.promise;
  });
  const sessions = refreshingSessions();
  return { ...sharingPane(request, sessions), request, sessions, response };
}

function sharingState(pane: SharingPane, row: GatewaySessionRow) {
  return pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key));
}

function sessionRow(): GatewaySessionRow {
  return {
    key: "agent:main:current",
    kind: "direct",
    sessionId: "session-current",
    updatedAt: 1,
    visibility: "draft",
    sharingRole: "owner",
  };
}

function sharingSessionsResult(row: GatewaySessionRow) {
  return { ...sessionsResult([row]), path: "" };
}

function sharingResult(row: GatewaySessionRow): SessionMembersListEvidenceResult {
  return {
    sessionKey: row.key,
    members: [],
    identities: [],
    role: "owner",
    allowedVisibilities: ["shared", "draft"],
  };
}

function installReplacementConnection(
  pane: SharingPane,
  state: ChatPageHost,
  row: GatewaySessionRow,
) {
  const request = vi.fn();
  const sessions = refreshingSessions();
  const client = createGatewayBrowserClientFixture({ request });
  pane.connectionGeneration += 1;
  pane.context = createSessionContext(client, sessions);
  setSharingAuthorization(pane);
  pane.state = state;
  state.client = client;
  state.connected = true;
  state.connectionEpoch = pane.connectionGeneration;
  pane.connectedClient = client;
  const cacheKey = pane.sessionSharingCacheKey(row.key);
  const replacementState: ChatSessionSharingState = {
    loading: false,
    result: sharingResult(row),
  };
  pane.collaboration.sharingStates = new Map([[cacheKey, replacementState]]);
  return { cacheKey, request, sessions, sharingState: replacementState };
}

const mutations = [
  {
    name: "visibility",
    method: "session.visibility.set",
    invoke: (pane: SharingPane, row: GatewaySessionRow) =>
      pane.mutateSessionSharing(row, { visibility: "shared" }),
  },
  {
    name: "member",
    method: "session.members.add",
    invoke: (pane: SharingPane, row: GatewaySessionRow) =>
      pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true }),
  },
] as const;

describe("public session sharing", () => {
  it.each([true, false])(
    "confirms publication, copies a mounted link (advertised=%s), and revokes independently of team visibility",
    async (advertised) => {
      const row = sessionRow();
      const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
      let enabled = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "session.publicShare.set") {
          enabled = asOptionalRecord(params)?.enabled === true;
          return { ok: true, sessionKey: row.key, ...(enabled ? { publicShare } : {}) };
        }
        if (method === "session.members.listEvidence") {
          return { ...sharingResult(row), ...(enabled ? { publicShare } : {}) };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { pane } = sharingPane(request, undefined, "wss://example.test");
      const hello = pane.context.gateway.snapshot.hello!;
      pane.context = { ...pane.context, basePath: "/control" };
      hello.controlUiUrl = advertised
        ? "https://example.test/control/?token=never-copy"
        : undefined;
      confirmPublicShare.mockResolvedValue(true);
      copyPublicShare.mockResolvedValue(true);
      expect(await pane.setSessionPublicShare(row, true)).toEqual({ status: "success" });
      expect(request).toHaveBeenCalledWith("session.publicShare.set", {
        sessionKey: row.key,
        agentId: "main",
        expectedSessionId: "session-current",
        enabled: true,
      });
      expect(sharingState(pane, row)?.publicUrl).toBe(
        "https://example.test/control/chat/main/current",
      );
      expect(await pane.copySessionPublicLink(row)).toEqual({ status: "success" });
      expect(copyPublicShare).toHaveBeenCalledWith(
        "https://example.test/control/chat/main/current",
        expect.any(Function),
      );
      await pane.setSessionPublicShare(row, false);
      expect(request).toHaveBeenCalledWith("session.publicShare.set", {
        sessionKey: row.key,
        agentId: "main",
        expectedSessionId: "session-current",
        enabled: false,
      });
      expect(confirmPublicShare).toHaveBeenCalledTimes(1);
      expect(request.mock.calls.every(([method]) => method !== "session.visibility.set")).toBe(
        true,
      );
      expect(sharingState(pane, row)?.result?.publicShare).toBeUndefined();
    },
  );

  it.each([
    {
      name: "rehydrates public state after an off-screen publication succeeds",
      holdRefresh: false,
    },
    {
      name: "rehydrates after the post-publication refresh becomes stale off-screen",
      holdRefresh: true,
    },
  ])("$name", async ({ holdRefresh }) => {
    const row = sessionRow();
    const other = { ...sessionRow(), key: "agent:main:other", sessionId: "session-other" };
    const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
    const publication = { ok: true as const, sessionKey: row.key, publicShare };
    const evidence = { ...sharingResult(row), publicShare };
    const held = createDeferred<typeof publication | typeof evidence>();
    const initialReads = holdRefresh ? 2 : 1;
    let listCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "session.publicShare.set") {
        return holdRefresh ? Promise.resolve(publication) : held.promise;
      }
      if (method === "session.members.listEvidence") {
        listCount += 1;
        if (holdRefresh && listCount === 2) {
          return held.promise;
        }
        return Promise.resolve({
          ...sharingResult(row),
          ...(listCount > initialReads ? { publicShare } : {}),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { pane, state } = sharingPane(request);
    state.sessionKey = row.key;
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(1);
      expect(sharingState(pane, row)?.loading).toBe(false);
    });

    confirmPublicShare.mockResolvedValue(true);
    const pending = pane.setSessionPublicShare(row, true);
    if (holdRefresh) {
      await vi.waitFor(() => expect(listCount).toBe(2));
    } else {
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "session.publicShare.set",
          expect.objectContaining({ sessionKey: row.key }),
        ),
      );
    }
    state.sessionKey = other.key;
    state.sessionsResult = sharingSessionsResult(other);
    held.resolve(holdRefresh ? evidence : publication);
    await pending;

    state.sessionKey = row.key;
    state.sessionsResult = sharingSessionsResult(row);
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(initialReads + 1);
      expect(sharingState(pane, row)?.result?.publicShare).toEqual(publicShare);
    });
  });

  it.each(["cancel", "session", "connection", "scope"] as const)(
    "does not publish after %s invalidates confirmation",
    async (change) => {
      const confirmation = createDeferred<boolean>();
      confirmPublicShare.mockReturnValue(confirmation.promise);
      const request = vi.fn();
      const { pane, state } = sharingPane(request);
      const row = sessionRow();
      const pending = pane.setSessionPublicShare(row, true);
      await vi.waitFor(() => expect(confirmPublicShare).toHaveBeenCalledOnce());
      if (change === "session") {
        state.sessionsResult = sharingSessionsResult({ ...row, sessionId: "replacement" });
      } else if (change === "connection") {
        pane.connectionGeneration += 1;
      } else if (change === "scope") {
        setSharingAuthorization(pane, { scopes: ["operator.read"] });
      }
      confirmation.resolve(change !== "cancel");
      await pending;
      expect(request).not.toHaveBeenCalled();
    },
  );
});

describe("chat pane sharing authorization", () => {
  it("keeps denied sharing reads idle and hydrates when access arrives", async () => {
    const row = sessionRow();
    const request = vi.fn(async () => sharingResult(row));
    const { pane } = sharingPane(request);
    const hydration = vi.spyOn(pane, "loadSessionSharing");
    setSharingAuthorization(pane, { scopes: ["operator.sessions.write"] });

    pane.syncSelectedSessionSharing(row);
    pane.syncSelectedSessionSharing(row);

    expect(request).not.toHaveBeenCalled();

    setSharingAuthorization(pane, { scopes: ["operator.read"] });
    pane.syncSelectedSessionSharing(row);
    pane.syncSelectedSessionSharing(row);
    await hydration.mock.results.at(-1)?.value;

    expect(request).toHaveBeenCalledExactlyOnceWith("session.members.listEvidence", {
      sessionKey: row.key,
      agentId: "main",
    });
    expect(sharingState(pane, row)).toEqual({
      loading: false,
      result: sharingResult(row),
    });
  });

  it.each<{
    name: string;
    authorization?: Parameters<typeof setSharingAuthorization>[1];
    row?: Partial<GatewaySessionRow>;
    current?: Partial<GatewaySessionRow>;
    readable?: boolean;
  }>([
    { name: "read-only scope", authorization: { scopes: ["operator.read"] }, readable: true },
    {
      name: "unadvertised methods",
      authorization: { methods: ["session.members.listEvidence"] },
      readable: true,
    },
    { name: "non-manager caller", row: { sharingRole: "member" } },
    { name: "disconnected snapshot", authorization: { phase: "reconnecting" } },
    { name: "replaced incarnation", current: { sessionId: "session-replacement" } },
    { name: "revoked manager role", current: { sharingRole: "member" } },
  ])(
    "refuses sharing writes for $name",
    async ({ authorization, row: fields, current, readable }) => {
      const row = { ...sessionRow(), ...fields };
      const request = vi.fn(async (method: string) => {
        if (method === "session.members.listEvidence") {
          return sharingResult(row);
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const sessions = refreshingSessions();
      const { pane, state } = sharingPane(request, sessions);
      setSharingAuthorization(pane, authorization);
      if (current) {
        state.sessionsResult = sharingSessionsResult({ ...sessionRow(), ...current });
      }
      await pane.loadSessionSharing(row);
      await pane.mutateSessionSharing(row, { visibility: "shared" });
      await pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true });
      if (readable) {
        expect(request).toHaveBeenCalledExactlyOnceWith("session.members.listEvidence", {
          sessionKey: row.key,
          agentId: "main",
        });
      } else {
        expect(request).not.toHaveBeenCalled();
      }
      expect(sessions.reconcileMutation).not.toHaveBeenCalled();
    },
  );

  it("settles a failed forced read without retaining an older pending receipt", async () => {
    const row = sessionRow();
    const first = createDeferred<SessionMembersListEvidenceResult>();
    const second = createDeferred<SessionMembersListEvidenceResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { pane } = sharingPane(request);
    const oldLoad = pane.loadSessionSharing(row);
    const newLoad = pane.loadSessionSharing(row, true);
    const read = sharingState(pane, row)?.read;
    second.reject(new Error("Membership read failed"));
    await newLoad;
    await expect(read).resolves.toBeUndefined();
    const failed = sharingState(pane, row);
    expect(failed).toEqual({ loading: false, error: "Membership read failed" });
    first.resolve(sharingResult(row));
    await oldLoad;
    expect(sharingState(pane, row)).toBe(failed);
  });

  it("releases a stale same-key sharing load for the replacement session", async () => {
    const stale = sessionRow();
    const replacement = { ...sessionRow(), sessionId: "session-replacement" };
    const listed = createDeferred<SessionMembersListEvidenceResult>();
    const request = vi.fn((method: string) => {
      if (method !== "session.members.listEvidence") {
        throw new Error(`unexpected request: ${method}`);
      }
      return request.mock.calls.length === 1
        ? listed.promise
        : Promise.resolve(sharingResult(replacement));
    });
    const sessions = refreshingSessions();
    const { pane, state } = sharingPane(request, sessions);
    const pending = pane.loadSessionSharing(stale);
    state.sessionsResult = sharingSessionsResult(replacement);
    listed.resolve(sharingResult(stale));
    await pending;

    expect(pane.collaboration.sharingStates.has(pane.sessionSharingCacheKey(stale.key))).toBe(
      false,
    );

    await pane.loadSessionSharing(replacement);

    expect(request).toHaveBeenCalledTimes(2);
    expect(sharingState(pane, replacement)).toEqual({
      loading: false,
      result: sharingResult(replacement),
    });
  });
});

describe("sharing operation code loading", () => {
  it.each(["scope", "connection", "session"] as const)(
    "reserves one operation and rechecks %s before its deferred write",
    async (change) => {
      const request = vi.fn(async () => ({}));
      const { pane, state } = sharingPane(request);
      const row = sessionRow();
      const pending = pane.mutateSessionSharing(row, { visibility: "shared" });
      expect(sharingState(pane, row)?.loading).toBe(true);
      const duplicate = pane.mutateSessionSharing(row, { visibility: "shared" });
      if (change === "scope") {
        setSharingAuthorization(pane, { scopes: ["operator.read"] });
      } else if (change === "connection") {
        pane.connectionGeneration += 1;
      } else {
        state.sessionsResult = sharingSessionsResult({ ...row, sessionId: "replacement" });
      }
      expect(await duplicate).toEqual({ status: "unavailable" });
      expect(await pending).toEqual({ status: "unavailable" });
      expect(request).not.toHaveBeenCalled();
      expect(sharingState(pane, row)).toBeUndefined();
    },
  );
});

describe("chat pane mutation connection ownership", () => {
  it.each([
    ["connection", "resolve", mutations[0]],
    ["session", "reject", mutations[1]],
  ] as const)("drops a stale %s mutation when it later %s", async (owner, completion, mutation) => {
    const { pane, state, request, sessions, response } = pendingMutation(mutation);
    const row = sessionRow();
    const pending = mutation.invoke(pane, row);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        mutation.method,
        expect.objectContaining({ sessionKey: row.key }),
      ),
    );
    let replacement: ReturnType<typeof installReplacementConnection> | undefined;
    const cacheKey = pane.sessionSharingCacheKey(row.key);
    const replacementState = { loading: false, result: sharingResult(row) };
    if (owner === "connection") {
      replacement = installReplacementConnection(pane, state, row);
    } else {
      const successor = { ...row, sessionId: "session-replacement" };
      state.sessionsResult = sharingSessionsResult(successor);
      replacementState.result = sharingResult(successor);
      pane.collaboration.sharingStates = new Map([[cacheKey, replacementState]]);
    }
    if (completion === "resolve") {
      response.resolve({});
    } else {
      response.reject(new Error("stale mutation failed"));
    }
    await pending;

    expect(request).toHaveBeenCalledTimes(1);
    expect(sessions.reconcileMutation).not.toHaveBeenCalled();
    if (replacement) {
      expectReplacementUntouched(pane, replacement);
    } else {
      expect(pane.collaboration.sharingStates.get(cacheKey)).toBe(replacementState);
    }
    expect(state).toMatchObject({ lastError: null, chatError: null });
  });

  it("keeps a previous-session failure out of the newly selected session", async () => {
    const mutation = mutations[1];
    const { pane, state, request, sessions, response } = pendingMutation(mutation);
    const previous = sessionRow();
    const selected = {
      ...sessionRow(),
      key: "agent:main:selected",
      sessionId: "session-selected",
    };
    state.sessionsResult = {
      ...sharingSessionsResult(previous),
      count: 2,
      sessions: [previous, selected],
    };
    const pending = mutation.invoke(pane, previous);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    state.sessionKey = selected.key;

    response.reject(new Error(`${mutation.name} failed after session switch`));
    await pending;

    expect(sharingState(pane, previous)).toMatchObject({
      loading: false,
      error: `${mutation.name} failed after session switch`,
    });
    expect(state).toMatchObject({ lastError: null, chatError: null });
    expect(sessions.reconcileMutation).not.toHaveBeenCalled();
  });

  it("drops a failure after leaving and returning to the retained pane", async () => {
    const mutation = mutations[0];
    const { pane, state, request, sessions, response } = pendingMutation(mutation);
    const row = sessionRow();
    const pending = mutation.invoke(pane, row);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    pane.presented = false;
    pane.presented = true;

    response.reject(new Error(`stale ${mutation.name} failed`));
    await pending;

    expect(sharingState(pane, row)).toBeUndefined();
    expect(state).toMatchObject({ lastError: null, chatError: null });
    expect(sessions.reconcileMutation).not.toHaveBeenCalled();
  });
});

it("preserves a member sharing refresh failure in the current connection", async () => {
  const row = sessionRow();
  const failure = "member refresh failed";
  const request = vi.fn(async (method: string) => {
    if (method === "session.members.add") {
      return {};
    }
    if (method === "session.members.listEvidence") {
      return sharingResult(row);
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const sessions = createSessionCapabilityFixture({
    reconcileMutation: vi.fn(async () => ({ status: "failed" as const, error: failure })),
  });
  const { pane, state } = sharingPane(request, sessions);

  await pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true });

  expect(sharingState(pane, row)).toMatchObject({
    loading: false,
    error: failure,
  });
  expect(state.lastError).toBe(failure);
  expect(state.chatError).toBe(state.lastError);
  expect(sessions.reconcileMutation).toHaveBeenCalledOnce();
});

describe("chat pane sharing mutation phase ownership", () => {
  it.each([
    { mutation: mutations[0], phase: "session refresh", rejectRead: false },
    { mutation: mutations[0], phase: "sharing reload", rejectRead: false },
    { mutation: mutations[1], phase: "sharing reload", rejectRead: true },
  ])(
    "fences stale $mutation.name results during $phase",
    async ({ mutation, phase, rejectRead }) => {
      const row = sessionRow();
      const started = createDeferred();
      const refreshed = createDeferred<SessionRefreshOutcome>();
      const listed = createDeferred<SessionMembersListEvidenceResult>();
      const request = vi.fn((method: string) => {
        if (method === mutation.method) {
          return Promise.resolve({});
        }
        if (phase === "sharing reload" && method === "session.members.listEvidence") {
          started.resolve();
          return listed.promise;
        }
        throw new Error(`unexpected old-connection request: ${method}`);
      });
      const oldSessions = createSessionCapabilityFixture({
        reconcileMutation: vi.fn(() => {
          if (phase === "session refresh") {
            started.resolve();
            return refreshed.promise;
          }
          return Promise.resolve({ status: "refreshed" as const });
        }),
      });
      const { pane, state } = sharingPane(request, oldSessions);
      const pending = mutation.invoke(pane, row);
      await started.promise;
      const replacement = installReplacementConnection(pane, state, row);
      if (phase === "session refresh") {
        refreshed.resolve({ status: "failed", error: "old session refresh failed" });
      } else if (rejectRead) {
        listed.reject(new Error("old sharing reload failed"));
      } else {
        listed.resolve(sharingResult(row));
      }
      await pending;
      expectReplacementUntouched(pane, replacement);
    },
  );
});

it.each(mutations)(
  "publishes refreshed sharing after a $name change",
  async ({ invoke, method }) => {
    const row = sessionRow();
    const request = vi.fn(async (called: string) => {
      if (called === method) {
        return {};
      }
      if (called === "session.members.listEvidence") {
        return sharingResult(row);
      }
      throw new Error(`unexpected request: ${called}`);
    });
    const { pane } = sharingPane(request, refreshingSessions());
    expect(await invoke(pane, row)).toEqual({ status: "success" });
    expect(sharingState(pane, row)?.result).toEqual(sharingResult(row));
  },
);
