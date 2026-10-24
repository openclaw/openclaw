/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-sharing.test/"} */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
  SessionsListResult,
} from "../../api/types.ts";
import type {
  SessionCapability,
  SessionRefreshOutcome,
} from "../../lib/sessions/session-capability.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  renderPaneHeaderInto,
  openNativeMenu,
} from "./components/chat-pane-header.test-support.ts";
import type {
  PreparedChatSessionSharing,
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
  prepareSessionSharing: (row: GatewaySessionRow) => PreparedChatSessionSharing | undefined;
  loadSessionSharing: (row: GatewaySessionRow, force?: boolean) => Promise<void>;
  syncSelectedSessionSharing: (row: GatewaySessionRow | undefined) => void;
  sessionSharingCacheKey: (sessionKey: string) => string;
  sessionSharingStates: Map<string, ChatSessionSharingState>;
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
  "session.members.remove",
  "session.publicShare.set",
];

function setSharingAuthorization(
  pane: SharingPane,
  params: {
    methods?: string[];
    phase?: "connected" | "reconnecting";
    scopes?: string[];
  } = {},
): void {
  const snapshot = pane.context.gateway.snapshot;
  snapshot.phase = params.phase ?? "connected";
  snapshot.hello = {
    ...snapshot.hello,
    auth: {
      role: "operator",
      scopes: params.scopes ?? ["operator.admin"],
    },
    features: {
      ...snapshot.hello?.features,
      methods: params.methods ?? SHARING_METHODS,
    },
  } as typeof snapshot.hello;
}

function createSharingTestChatPane(params: Parameters<typeof createTestChatPane>[0]) {
  const result = createTestChatPane(params);
  const pane = result.pane as SharingPane;
  setSharingAuthorization(pane);
  result.state.sessionsResult = sharingSessionsResult(sessionRow());
  result.state.sessionsResultAgentId = "main";
  return { ...result, pane };
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

function sharingSessionsResult(row: GatewaySessionRow): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: [row],
  };
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

function replaceConnection(
  pane: SharingPane,
  state: ChatPageHost,
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): void {
  pane.connectionGeneration += 1;
  pane.context = createSessionContext(client, sessions);
  setSharingAuthorization(pane);
  pane.state = state;
  state.client = client;
  state.connected = true;
  state.connectionEpoch = pane.connectionGeneration;
  pane.connectedClient = client;
}

function installReplacementConnection(
  pane: SharingPane,
  state: ChatPageHost,
  row: GatewaySessionRow,
) {
  const request = vi.fn();
  const sessions = createSessionCapabilityFixture({
    reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
  });
  replaceConnection(pane, state, createGatewayBrowserClientFixture({ request }), sessions);
  const cacheKey = pane.sessionSharingCacheKey(row.key);
  const sharingState: ChatSessionSharingState = {
    loading: false,
    result: sharingResult(row),
  };
  pane.collaboration.sharingStates = new Map([[cacheKey, sharingState]]);
  return { cacheKey, request, sessions, sharingState };
}

const mutations = [
  {
    name: "visibility",
    method: "session.visibility.set",
    expectedOrder: [
      "session.visibility.set",
      "sessions.reconcileMutation",
      "session.members.listEvidence",
    ],
    invoke: (pane: SharingPane, row: GatewaySessionRow) =>
      pane.mutateSessionSharing(row, { visibility: "shared" }),
  },
  {
    name: "member",
    method: "session.members.add",
    expectedOrder: [
      "session.members.add",
      "session.members.listEvidence",
      "sessions.reconcileMutation",
    ],
    invoke: (pane: SharingPane, row: GatewaySessionRow) =>
      pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true }),
  },
] as const;

describe("public session sharing", () => {
  it.each(["operator.sessions.read", "operator.sessions.write"])(
    "does not publish sharing hydration while rendering a header with %s",
    (scope) => {
      const request = vi.fn();
      const { pane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture(),
      });
      const row = sessionRow();
      setSharingAuthorization(pane, { scopes: [scope] });
      const states = pane.collaboration.sharingStates;
      const workspace = createPaneHeaderWorkspaceFixture(state);

      pane.renderPaneHeader(workspace, row, false, undefined, false, null);
      pane.renderPaneHeader(workspace, row, false, undefined, false, null);

      expect(pane.collaboration.sharingStates).toBe(states);
      expect(request).not.toHaveBeenCalled();
    },
  );

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
      const { pane } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request, gatewayUrl: "wss://example.test" }),
        sessions: createSessionCapabilityFixture(),
      });
      const hello = pane.context.gateway.snapshot.hello!;
      pane.context = { ...pane.context, basePath: "/control" };
      hello.controlUiUrl = advertised
        ? "https://example.test/control/?token=never-copy"
        : undefined;
      confirmPublicShare.mockResolvedValue(true);
      copyPublicShare.mockResolvedValue(true);
      expect(await pane.setSessionPublicShare(row, true)).toEqual({ status: "success" });
      expect(confirmPublicShare).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("existing and future conversation text"),
        }),
      );
      expect(request).toHaveBeenCalledWith("session.publicShare.set", {
        sessionKey: row.key,
        agentId: "main",
        expectedSessionId: "session-current",
        enabled: true,
      });
      expect(
        pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.publicUrl,
      ).toBe("https://example.test/control/chat/main/current");
      const header = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => header.remove());
      const workspace = createPaneHeaderWorkspaceFixture(pane.state);
      const draw = () =>
        renderPaneHeaderInto(
          pane.renderPaneHeader(workspace, row, false, undefined, false, null),
          header,
        );
      draw();
      await pane.loadSessionSharing(row, true);
      draw();
      const sharingMenu = header.querySelector(".chat-pane__sharing-menu")!;
      await openNativeMenu(sharingMenu, "public:copy");
      const copyButton = sharingMenu.querySelector<HTMLButtonElement>(
        '[data-value="public:copy"]',
      )!;
      expect(copyButton.disabled).toBe(false);
      copyButton.click();
      await waitForSolid(() => expect(copyButton.getAttribute("aria-label")).toBe("Copied!"));
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
      expect(
        pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.result
          ?.publicShare,
      ).toBeUndefined();
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
    const { pane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    state.sessionKey = row.key;
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(1);
      expect(
        pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.loading,
      ).toBe(false);
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
      expect(
        pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.result
          ?.publicShare,
      ).toEqual(publicShare);
    });
  });

  it.each(["cancel", "session", "connection", "scope"] as const)(
    "does not publish after %s invalidates confirmation",
    async (change) => {
      const confirmation = createDeferred<boolean>();
      confirmPublicShare.mockReturnValue(confirmation.promise);
      const request = vi.fn();
      const { pane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture(),
      });
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
    const { pane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
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
    expect(pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))).toEqual({
      loading: false,
      result: sharingResult(row),
    });
  });

  it("loads selected-global Work suggestions after visibility changes to shared", async () => {
    const visibility = "shared";
    const pending: SessionSuggestion = {
      id: `pending-${visibility}`,
      sessionKey: "agent:work:main",
      agentId: "work",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "still needs review",
      createdAt: 1,
      state: "pending",
    };
    const request = vi.fn(async () => ({ suggestions: [pending], role: "owner" as const }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: {} as SessionCapability,
    });
    state.sessionKey = "agent:work:main";
    state.assistantAgentId = "work";
    state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    state.sessionsResultAgentId = "work";
    state.sessionsResult = sharingSessionsResult({
      ...sessionRow(),
      key: "global",
      kind: "global",
      visibility,
    });
    pane.presence.update({
      presence: [
        { ts: 1, user: { id: "owner" } },
        { ts: 1, user: { id: "alice" } },
      ],
    });

    await pane.refreshSessionSuggestions();

    expect(request).toHaveBeenCalledWith("session.suggestions.list", {
      sessionKey: "agent:work:main",
      agentId: "work",
    });
    expect(pane.collaboration.suggestions).toEqual([pending]);
    expect(pane.collaboration.role).toBe("owner");
  });

  it.each([
    {
      name: "allows read-scoped owners to load sharing data but not mutate it",
      authorization: { scopes: ["operator.read"] },
    },
    {
      name: "refuses explicitly unadvertised sharing methods",
      authorization: { methods: ["session.members.listEvidence"], scopes: ["operator.admin"] },
    },
  ])("$name", async ({ authorization }) => {
    const row = sessionRow();
    const request = vi.fn(async (method: string) => {
      if (method === "session.members.listEvidence") {
        return sharingResult(row);
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const sessions = createSessionCapabilityFixture({
      reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
    });
    const { pane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    setSharingAuthorization(pane, authorization);

    await pane.loadSessionSharing(row);
    await pane.mutateSessionSharing(row, { visibility: "shared" });
    await pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "session.members.listEvidence",
      expect.objectContaining({ sessionKey: row.key }),
    );
    expect(sessions.reconcileMutation).not.toHaveBeenCalled();
  });

  it("refuses sharing requests for non-managers and disconnected snapshots", async () => {
    for (const authorization of [
      { row: { ...sessionRow(), sharingRole: "member" as const } },
      { row: sessionRow(), phase: "reconnecting" as const },
    ]) {
      const request = vi.fn();
      const sessions = createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      });
      const { pane } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions,
      });
      setSharingAuthorization(pane, {
        phase: authorization.phase,
        scopes: ["operator.admin"],
      });

      await pane.loadSessionSharing(authorization.row);
      await pane.mutateSessionSharing(authorization.row, { visibility: "shared" });
      await pane.mutateSessionSharing(authorization.row, {
        identityId: "identity-alice",
        member: true,
      });

      expect(request).not.toHaveBeenCalled();
      expect(sessions.reconcileMutation).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: "a replacement session",
      current: { ...sessionRow(), sessionId: "session-replacement" },
    },
    {
      name: "a current non-manager role",
      current: { ...sessionRow(), sharingRole: "member" as const },
    },
  ])("refuses callbacks retained from $name", async ({ current }) => {
    const request = vi.fn();
    const sessions = createSessionCapabilityFixture({
      reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
    });
    const { pane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const stale = sessionRow();
    state.sessionsResult = sharingSessionsResult(current);

    await pane.loadSessionSharing(stale);
    await pane.mutateSessionSharing(stale, { visibility: "shared" });
    await pane.mutateSessionSharing(stale, { identityId: "identity-alice", member: true });

    expect(request).not.toHaveBeenCalled();
    expect(sessions.reconcileMutation).not.toHaveBeenCalled();
  });

  it("settles a failed forced read without retaining an older pending receipt", async () => {
    const row = sessionRow();
    const first = createDeferred<SessionMembersListEvidenceResult>();
    const second = createDeferred<SessionMembersListEvidenceResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { pane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    const oldLoad = pane.loadSessionSharing(row);
    const newLoad = pane.loadSessionSharing(row, true);
    const read = pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.read;
    second.reject(new Error("Membership read failed"));
    await newLoad;
    await expect(read).resolves.toBeUndefined();
    const failed = pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key));
    expect(failed).toEqual({ loading: false, error: "Membership read failed" });
    first.resolve(sharingResult(row));
    await oldLoad;
    expect(pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))).toBe(failed);
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
    const sessions = createSessionCapabilityFixture({
      reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
    });
    const { pane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pending = pane.loadSessionSharing(stale);
    state.sessionsResult = sharingSessionsResult(replacement);
    listed.resolve(sharingResult(stale));
    await pending;

    expect(pane.collaboration.sharingStates.has(pane.sessionSharingCacheKey(stale.key))).toBe(
      false,
    );

    await pane.loadSessionSharing(replacement);

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(replacement.key)),
    ).toEqual({
      loading: false,
      result: sharingResult(replacement),
    });
  });

  it("drops a sharing load failure after leaving and returning", async () => {
    const row = sessionRow();
    const listed = createDeferred<SessionMembersListEvidenceResult>();
    const request = vi.fn(() => listed.promise);
    const { pane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    const pending = pane.loadSessionSharing(row);
    pane.presented = false;
    pane.presented = true;

    listed.reject(new Error("stale sharing load failed"));
    await pending;

    expect(
      pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key)),
    ).toBeUndefined();
  });
});

describe.each(mutations)("chat pane $name mutation connection ownership", (mutation) => {
  it.each(["resolve", "reject"] as const)(
    "drops a stale mutation when the previous connection later %s",
    async (completion) => {
      const response = createDeferred<unknown>();
      const oldRequest = vi.fn((method: string) => {
        if (method !== mutation.method) {
          throw new Error(`unexpected old-connection request: ${method}`);
        }
        return response.promise;
      });
      const oldSessions = createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      });
      const { pane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request: oldRequest }),
        sessions: oldSessions,
      });
      const row = sessionRow();
      const pending = mutation.invoke(pane, row);
      expect(oldRequest).toHaveBeenCalledWith(
        mutation.method,
        expect.objectContaining({ sessionKey: row.key }),
      );

      const replacement = installReplacementConnection(pane, state, row);

      if (completion === "resolve") {
        response.resolve({});
      } else {
        response.reject(new Error("old connection failed"));
      }
      await pending;

      expect(replacement.request).not.toHaveBeenCalled();
      expect(replacement.sessions.reconcileMutation).not.toHaveBeenCalled();
      expect(pane.collaboration.sharingStates.get(replacement.cacheKey)).toBe(
        replacement.sharingState,
      );
      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "drops a stale same-key mutation when the replaced session later %s",
    async (completion) => {
      const response = createDeferred<unknown>();
      const request = vi.fn((method: string) => {
        if (method !== mutation.method) {
          throw new Error(`unexpected request: ${method}`);
        }
        return response.promise;
      });
      const sessions = createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      });
      const { pane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions,
      });
      const stale = sessionRow();
      const pending = mutation.invoke(pane, stale);
      expect(request).toHaveBeenCalledWith(
        mutation.method,
        expect.objectContaining({ sessionKey: stale.key }),
      );

      const replacement = { ...stale, sessionId: "session-replacement" };
      state.sessionsResult = sharingSessionsResult(replacement);
      const cacheKey = pane.sessionSharingCacheKey(replacement.key);
      const replacementState: ChatSessionSharingState = {
        loading: false,
        result: sharingResult(replacement),
      };
      pane.collaboration.sharingStates = new Map([[cacheKey, replacementState]]);

      if (completion === "resolve") {
        response.resolve({});
      } else {
        response.reject(new Error("stale mutation failed"));
      }
      await pending;

      expect(request).toHaveBeenCalledTimes(1);
      expect(sessions.reconcileMutation).not.toHaveBeenCalled();
      expect(pane.collaboration.sharingStates.get(cacheKey)).toBe(replacementState);
      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    },
  );

  it("keeps a previous-session failure out of the newly selected session", async () => {
    const response = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method !== mutation.method) {
        throw new Error(`unexpected request: ${method}`);
      }
      return response.promise;
    });
    const sessions = createSessionCapabilityFixture({
      reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
    });
    const { pane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
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
    state.sessionKey = selected.key;

    response.reject(new Error(`${mutation.name} failed after session switch`));
    await pending;

    expect(
      pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(previous.key)),
    ).toMatchObject({
      loading: false,
      error: `${mutation.name} failed after session switch`,
    });
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(sessions.reconcileMutation).not.toHaveBeenCalled();
  });

  it("drops a failure after leaving and returning to the retained pane", async () => {
    const response = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method !== mutation.method) {
        throw new Error(`unexpected request: ${method}`);
      }
      return response.promise;
    });
    const sessions = createSessionCapabilityFixture({
      reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
    });
    const { pane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const row = sessionRow();
    const pending = mutation.invoke(pane, row);
    pane.presented = false;
    pane.presented = true;

    response.reject(new Error(`stale ${mutation.name} failed`));
    await pending;

    expect(
      pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key)),
    ).toBeUndefined();
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
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
  const { pane, state } = createSharingTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions,
  });

  await pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true });

  expect(pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))).toMatchObject({
    loading: false,
    error: failure,
  });
  expect(state.lastError).toBe(failure);
  expect(state.chatError).toBe(state.lastError);
  expect(sessions.reconcileMutation).toHaveBeenCalledOnce();
});

describe("chat pane sharing mutation phase ownership", () => {
  it.each(["succeeds", "fails"] as const)(
    "drops a stale visibility session refresh when it later %s",
    async (completion) => {
      const refreshed = createDeferred<SessionRefreshOutcome>();
      const request = vi.fn(async (method: string) => {
        if (method === "session.visibility.set") {
          return {};
        }
        throw new Error(`unexpected old-connection request: ${method}`);
      });
      const oldSessions = createSessionCapabilityFixture({
        reconcileMutation: vi.fn(() => refreshed.promise),
      });
      const { pane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: oldSessions,
      });
      const row = sessionRow();
      const pending = pane.mutateSessionSharing(row, { visibility: "shared" });
      await vi.waitFor(() => {
        expect(oldSessions.reconcileMutation).toHaveBeenCalledWith("main");
      });

      const replacement = installReplacementConnection(pane, state, row);
      if (completion === "succeeds") {
        refreshed.resolve({ status: "stale" });
      } else {
        refreshed.resolve({ status: "failed", error: "old session refresh failed" });
      }
      await pending;

      expect(replacement.request).not.toHaveBeenCalled();
      expect(replacement.sessions.reconcileMutation).not.toHaveBeenCalled();
      expect(pane.collaboration.sharingStates.get(replacement.cacheKey)).toBe(
        replacement.sharingState,
      );
    },
  );

  describe.each(mutations)("$name sharing reload", ({ invoke, method, name }) => {
    it.each(["resolve", "reject"] as const)(
      "drops a stale sharing reload when it later %s",
      async (completion) => {
        const listed = createDeferred<SessionMembersListEvidenceResult>();
        const request = vi.fn((requestMethod: string) => {
          if (requestMethod === method) {
            return Promise.resolve({});
          }
          if (requestMethod === "session.members.listEvidence") {
            return listed.promise;
          }
          throw new Error(`unexpected old-connection request: ${requestMethod}`);
        });
        const oldSessions = createSessionCapabilityFixture({
          reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
        });
        const { pane, state } = createSharingTestChatPane({
          client: createGatewayBrowserClientFixture({ request }),
          sessions: oldSessions,
        });
        const row = sessionRow();
        const pending = invoke(pane, row);
        await vi.waitFor(() => {
          expect(request).toHaveBeenCalledWith(
            "session.members.listEvidence",
            expect.objectContaining({ sessionKey: row.key }),
          );
        });

        const replacement = installReplacementConnection(pane, state, row);
        if (completion === "resolve") {
          listed.resolve(sharingResult(row));
        } else {
          listed.reject(new Error(`old ${name} sharing reload failed`));
        }
        await pending;

        expect(oldSessions.reconcileMutation).toHaveBeenCalledTimes(name === "visibility" ? 1 : 0);
        expect(replacement.request).not.toHaveBeenCalled();
        expect(replacement.sessions.reconcileMutation).not.toHaveBeenCalled();
        expect(pane.collaboration.sharingStates.get(replacement.cacheKey)).toBe(
          replacement.sharingState,
        );
      },
    );
  });

  it("drops a stale member session refresh failure", async () => {
    const refreshed = createDeferred<SessionRefreshOutcome>();
    const row = sessionRow();
    const request = vi.fn(async (method: string) => {
      if (method === "session.members.listEvidence") {
        return sharingResult(row);
      }
      if (method === "session.members.add") {
        return {};
      }
      throw new Error(`unexpected old-connection request: ${method}`);
    });
    const oldSessions = createSessionCapabilityFixture({
      reconcileMutation: vi.fn(() => refreshed.promise),
    });
    const { pane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: oldSessions,
    });
    const pending = pane.mutateSessionSharing(row, { identityId: "identity-alice", member: true });
    await vi.waitFor(() => {
      expect(oldSessions.reconcileMutation).toHaveBeenCalledWith("main");
    });

    const replacement = installReplacementConnection(pane, state, row);
    refreshed.resolve({ status: "failed", error: "old member session refresh failed" });
    await pending;

    expect(replacement.request).not.toHaveBeenCalled();
    expect(replacement.sessions.reconcileMutation).not.toHaveBeenCalled();
    expect(pane.collaboration.sharingStates.get(replacement.cacheKey)).toBe(
      replacement.sharingState,
    );
  });
});

describe("chat pane current sharing mutation refresh order", () => {
  it.each(mutations)(
    "refreshes in the required order after a $name change",
    async ({ invoke, expectedOrder }) => {
      const row = sessionRow();
      const calls: string[] = [];
      const request = vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "session.members.listEvidence") {
          return sharingResult(row);
        }
        return {};
      });
      const sessions = createSessionCapabilityFixture({
        reconcileMutation: vi.fn(async () => {
          calls.push("sessions.reconcileMutation");
          return { status: "refreshed" as const };
        }),
      });
      const { pane } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions,
      });

      expect(await invoke(pane, row)).toEqual({ status: "success" });

      expect(calls).toEqual(expectedOrder);
      expect(
        pane.collaboration.sharingStates.get(pane.sessionSharingCacheKey(row.key))?.result,
      ).toEqual(sharingResult(row));
    },
  );
});
