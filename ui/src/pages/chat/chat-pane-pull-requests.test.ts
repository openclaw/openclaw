/* @vitest-environment jsdom */

import { setImmediate as nextFrame } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import type { GitHubPublicationOptions } from "../../lib/sessions/github-publication-controller.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

function pullRequest(
  number: number,
  state: ControlUiSessionPullRequest["state"],
): ControlUiSessionPullRequest {
  return {
    number,
    owner: "openclaw",
    repo: "openclaw",
    branch: "feature/demo",
    title: `Pull request ${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    state,
  };
}

function createPullRequestPane(sessions: SessionCapability) {
  const request = vi.fn().mockResolvedValue({ subscribed: true });
  const partialSessions = sessions as Partial<SessionCapability>;
  const sessionCapability = {
    ...sessions,
    pullRequestSummary: partialSessions.pullRequestSummary ?? vi.fn(() => undefined),
  } as SessionCapability;
  const harness = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
    sessions: sessionCapability,
  });
  harness.pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
  } as never;
  return { ...harness, request };
}

function emitSnapshot(
  emitGatewayEvent: (event: string, payload: unknown) => void,
  sessionKey: string,
  snapshot: {
    repository?: { owner: string; repo: string };
    branch?: {
      owner: string;
      repo: string;
      branch: string;
      createUrl?: string;
    };
    pullRequests: ControlUiSessionPullRequest[];
    rateLimited: boolean;
    status: "ready" | "rate-limited" | "unavailable";
  },
) {
  emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: { [sessionKey]: snapshot },
  });
}

function createPublicationPane(
  scope?: "global" | "per-sender",
  operatorScopes = ["operator.read", "operator.write"],
) {
  const agentId = scope ? "research" : "main";
  const sessionKey = scope ? "global" : "agent:main:publication";
  const shared: NonNullable<GitHubPublicationOptions["shared"]> = {
    source: "system-configured",
    accountId: 1,
    login: "system-bot",
  };
  const account = { accountId: 2, login: "alice-tools" };
  const generation = "bdca439a-e787-4f9f-b5f3-a878c662cc76";
  const options: GitHubPublicationOptions = {
    shared,
    personal: {
      state: "connected",
      generation,
      account,
      accessExpiresAtMs: null,
      refreshState: "available",
      pending: null,
    },
    pendingPersonal: null,
    latestShared: null,
  };
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "projects.list") {
      return { projects: [] };
    }
    if (method === "sessions.github.options") {
      return options;
    }
    if (method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) {
      return { subscribed: true };
    }
    if (method === "sessions.github.publish") {
      throw new Error("Response lost");
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createGatewayBrowserClientFixture({ request });
  const initial = createInitializationContext();
  const eventListeners = new Set<GatewayEventListener>();
  const hello = gatewayHelloForMethods(
    [
      "sessions.github.publish",
      "sessions.github.options",
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      "projects.list",
    ],
    operatorScopes,
  );
  if (scope) {
    hello.snapshot = {
      sessionDefaults: {
        defaultAgentId: "ops",
        mainKey: "main",
        mainSessionKey: scope === "global" ? "global" : "agent:ops:main",
      },
    };
  }
  const gateway: ApplicationContext["gateway"] = {
    ...initial.gateway,
    subscribeEvents: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    snapshot: {
      ...initial.gateway.snapshot,
      client,
      phase: "connected",
      hello,
      assistantAgentId: agentId,
      sessionKey,
      selfUser: {
        id: "publication-person",
        identity: { type: "profile", id: "publication-person" },
      },
    },
  };
  const selection = {
    ...initial.agentSelection,
    state: { selectedId: agentId, scopeId: agentId },
    subscribe: () => () => {},
  };
  const context: ApplicationContext = {
    ...initial,
    gateway,
    agentSelection: selection,
    sessions: createSessionCapability(gateway, selection),
  };
  const pane = createRenderTestChatPane();
  Object.defineProperties(pane, {
    isConnected: { configurable: true, value: true },
    connectedClient: { configurable: true, value: client, writable: true },
  });
  const state = pane.initialize(context);
  onTestFinished(() => {
    pane.presented = false;
    context.sessions.dispose();
  });
  state.client = client;
  state.connected = true;
  state.sessionKey = sessionKey;
  state.assistantAgentId = agentId;
  state.sessionsResultAgentId = agentId;
  state.sessionsResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    // Scoped lists may carry the owner only at the result/route level.
    sessions: [
      {
        key: sessionKey,
        sessionId: "publication",
        worktree: {
          id: "worktree-publication",
          branch: "feature/publication",
          repoRoot: "/synthetic/repository",
        },
        kind: scope ? "global" : "direct",
        updatedAt: 1,
      },
    ],
  };
  const settled = async () => {
    await vi.waitFor(() => {
      pane.render();
      expect(pane.chatProps?.githubPublication?.activity).toBeNull();
    });
    return pane.chatProps!.githubPublication!;
  };
  const emitGatewayEvent = (event: string, payload: unknown) => {
    for (const listener of eventListeners) {
      listener({ type: "event", event, payload });
    }
  };
  return {
    pane,
    state,
    context,
    request,
    options,
    shared,
    account,
    generation,
    settled,
    emitGatewayEvent,
  };
}

describe("chat pane pushed pull request state", () => {
  it("keeps the pane quiet for unrelated PR snapshots while publishing its own changes", () => {
    const { pane, state, emitGatewayEvent } = createPullRequestPane({
      capturePullRequestEpoch: vi.fn(() => ({})),
      setPullRequestSummary: vi.fn(),
    } as unknown as SessionCapability);
    const store = sessionPullRequestsForGateway(pane.context.gateway);
    const otherOwner = {};
    const otherKey = "agent:main:other-pull-request";
    store.watch(otherOwner, [otherKey]);
    pane.refreshSessionPullRequests();
    const notified = vi.fn(() => pane.refreshSessionPullRequests());
    const stop = store.subscribe(notified);
    onTestFinished(() => {
      stop();
      store.unwatch(otherOwner);
    });
    const snapshot = {
      pullRequests: [pullRequest(1, "open")],
      rateLimited: false,
      status: "ready" as const,
    };
    emitSnapshot(emitGatewayEvent, state.sessionKey, snapshot);
    const redraw = vi.spyOn(pane, "requestUpdate");
    notified.mockClear();

    emitSnapshot(emitGatewayEvent, "agent:main:unwatched", snapshot);
    expect.soft(notified).not.toHaveBeenCalled();
    expect.soft(redraw).not.toHaveBeenCalled();
    notified.mockClear();
    redraw.mockClear();

    emitSnapshot(emitGatewayEvent, otherKey, {
      ...snapshot,
      pullRequests: [pullRequest(2, "merged")],
    });
    expect(notified).toHaveBeenCalledOnce();
    expect.soft(redraw).not.toHaveBeenCalled();
    expect(pane.sessionPullRequests).toEqual(snapshot.pullRequests);
    redraw.mockClear();

    emitSnapshot(emitGatewayEvent, state.sessionKey, {
      pullRequests: [],
      rateLimited: false,
      status: "unavailable",
    });
    expect(redraw).toHaveBeenCalledOnce();
    expect(pane.sessionPullRequests).toEqual(snapshot.pullRequests);
    redraw.mockClear();

    state.sessionKey = otherKey;
    pane.refreshSessionPullRequests();
    expect(redraw).toHaveBeenCalledOnce();
    expect(pane.sessionPullRequests).toEqual([pullRequest(2, "merged")]);
  });

  it.each(["unavailable", "rate-limited"] as const)(
    "applies retained and replaced repository snapshots during %s",
    async (status) => {
      const epoch = {};
      const setPullRequestSummary = vi.fn();
      const { pane, emitGatewayEvent } = createPullRequestPane({
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
      } as unknown as SessionCapability);
      const key = "agent:main:current";
      const repository = { owner: "openclaw", repo: "openclaw" };
      pane.refreshSessionPullRequests();
      await Promise.resolve();
      emitSnapshot(emitGatewayEvent, key, {
        repository,
        branch: { ...repository, branch: "feature/demo" },
        pullRequests: [pullRequest(111532, "open")],
        rateLimited: false,
        status: "ready",
      });
      pane.refreshSessionPullRequests();
      const failure = { pullRequests: [], rateLimited: status === "rate-limited", status };
      emitSnapshot(emitGatewayEvent, key, { ...failure, repository });
      pane.refreshSessionPullRequests();
      expect(pane.sessionPullRequests).toHaveLength(1);
      expect(pane.sessionPullRequestsBranch?.branch).toBe("feature/demo");

      const replacement = { owner: "other", repo: "checkout" };
      emitSnapshot(emitGatewayEvent, key, { ...failure, repository: replacement });
      pane.refreshSessionPullRequests();
      expect(pane.githubRepo).toEqual(replacement);
      expect(pane.sessionPullRequests).toEqual([]);
      expect(pane.sessionPullRequestsBranch).toBeUndefined();
      expect(setPullRequestSummary).toHaveBeenLastCalledWith(key, undefined, epoch);
    },
  );

  it.each(["ready", "unavailable", "rate-limited"] as const)(
    "renders repository context only from a settled catalog (%s)",
    async (status) => {
      const { pane, request, context, state, emitGatewayEvent } = createPublicationPane();
      pane.refreshSessionPullRequests();
      await Promise.resolve();
      emitSnapshot(emitGatewayEvent, state.sessionKey, {
        repository: { owner: "openclaw", repo: "openclaw" },
        pullRequests: [],
        rateLimited: status === "rate-limited",
        status,
      });
      pane.refreshSessionPullRequests();
      const catalog = projectsForGateway(context.gateway);
      if (status === "ready") {
        const pending = createDeferred<{ projects: [] }>();
        request.mockReturnValueOnce(pending.promise);
        const read = catalog.refresh();
        pane.render();
        expect(pane.chatProps?.githubRepo).toBeNull();
        pending.reject(new Error("Project catalog unavailable"));
        await read;
        pane.render();
        expect(pane.chatProps?.githubRepo).toBeNull();
        request.mockResolvedValueOnce({
          projects: [{ id: "clawsweeper", displayName: "ClawSweeper", source: "cloned" }],
        });
      }
      await catalog.refresh();
      pane.render();
      expect(pane.chatProps?.githubRepo).toEqual({ owner: "openclaw", repo: "openclaw" });
      expect(pane.chatProps?.pullRequestsStatus).toBe(status);
      if (status === "ready") {
        expect(pane.chatProps?.githubRepositories).toEqual([{ aliases: ["ClawSweeper"] }]);
      }
      state.sessionKey = "agent:main:another-checkout";
      pane.refreshSessionPullRequests();
      pane.render();
      expect(pane.chatProps?.githubRepo).toBeNull();
      expect(pane.chatProps?.pullRequestsStatus).toBe("ready");
    },
  );

  it.each(["global", "per-sender"] as const)(
    "preserves the selected raw-global owner through publication RPCs in %s scope",
    async (scope) => {
      const { pane, request, options, account, generation, settled } = createPublicationPane(scope);
      const requestId = "bdca439a-e787-4f9f-b5f3-a878c662cc77";
      const result = {
        requestId,
        publisher: { source: "personal", ...account },
        status: "needs_confirmation",
      };
      const confirmation = {
        account,
        generation,
        requestDigest: "a".repeat(64),
        repository: "team/demo",
        pushRepository: "alice-tools/demo",
        branch: "feature/research",
        baseBranch: "main",
        sourceHeadCommit: "1".repeat(40),
        sourceIndexTree: "2".repeat(40),
        workspaceTree: "3".repeat(40),
      };
      request.mockImplementation(async (method) => {
        switch (method) {
          case "sessions.github.options":
            return options;
          case "sessions.github.publish":
            return result;
          case "sessions.github.status":
            return { result, confirmation };
          case "sessions.github.confirm":
            return { ...result, status: "published" };
          case SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD:
            return { subscribed: true };
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      });
      (await settled()).onSelect?.("personal");
      pane.render();
      pane.chatProps!.githubPublication!.onPublish?.();
      (await settled()).onConfirm?.();
      await settled();
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("sessions.github.")),
      ).toEqual([
        "sessions.github.options",
        "sessions.github.publish",
        "sessions.github.status",
        "sessions.github.confirm",
      ]);
      for (const method of ["options", "publish", "status", "confirm"]) {
        expect
          .soft(request)
          .toHaveBeenCalledWith(
            `sessions.github.${method}`,
            expect.objectContaining({ sessionKey: "global", agentId: "research" }),
          );
      }
    },
  );

  it.each(["shared", "personal"] as const)(
    "retains an unknown %s publication across a retained-pane navigation",
    async (source) => {
      const { pane, state, request, options, shared, account, generation, settled } =
        createPublicationPane();
      (await settled()).onSelect?.(source);
      pane.render();
      pane.chatProps!.githubPublication!.onPublish?.();
      let unknown = await settled();
      expect(unknown.locked).toBe(true);
      const first = request.mock.calls.find(([method]) => method === "sessions.github.publish");
      expect(first?.[1]).toEqual({
        sessionKey: state.sessionKey,
        agentId: "main",
        idempotencyKey: expect.any(String),
        selection:
          source === "shared" ? { source, expected: shared } : { source, generation, account },
      });
      if (source === "shared") {
        options.shared = null;
        unknown.onRefresh();
        unknown = await settled();
        expect(unknown.onPublish).toBeTypeOf("function");
      }

      pane.presented = false;
      pane.render();
      expect(pane.chatProps?.githubPublication).toBeUndefined();
      const hiddenRequests = request.mock.calls.length;
      unknown.onPublish?.();
      unknown.onRefresh();
      expect(request).toHaveBeenCalledTimes(hiddenRequests);
      pane.presented = true;
      const returned = await settled();

      expect(returned.locked).toBe(true);
      expect(returned.selection).toEqual(unknown.selection);
      const knownRoster = state.sessionsResult;
      if (!knownRoster) {
        throw new Error("Expected the publication roster to remain available");
      }
      state.sessionsResult = { ...knownRoster, count: 0, sessions: [] };
      const beforeMissingRow = request.mock.calls.length;
      returned.onPublish?.();
      returned.onRefresh();
      expect(request).toHaveBeenCalledTimes(beforeMissingRow);
      pane.render();
      expect(pane.chatProps?.githubPublication).toBeUndefined();
      state.sessionsResult = knownRoster;
      const restored = await settled();
      expect(restored.locked).toBe(true);
      expect(restored.selection).toEqual(unknown.selection);
      restored.onPublish?.();
      await settled();
      expect(request.mock.calls.filter(([method]) => method === "sessions.github.publish")).toEqual(
        [first, first],
      );
    },
  );

  it.each([
    {
      name: "live draft and closed",
      pullRequests: [pullRequest(111772, "draft"), pullRequest(111751, "closed")],
      summary: { numbers: [111751, 111772], state: "draft" },
      refresh: true,
    },
    {
      name: "truncated history",
      pullRequests: [
        pullRequest(999, "draft"),
        ...Array.from({ length: 20 }, (_, index) => pullRequest(index + 1, "closed")),
      ],
      summary: {
        numbers: [...Array.from({ length: 19 }, (_, index) => index + 1), 999],
        state: "draft",
      },
    },
    {
      name: "merged",
      pullRequests: [pullRequest(111532, "merged")],
      summary: { numbers: [111532], state: "merged" },
    },
    { name: "empty rate-limited", pullRequests: [], rateLimited: true },
  ])(
    "publishes pushed PR summaries: $name",
    async ({ pullRequests, summary, refresh, rateLimited = false }) => {
      const epoch = {};
      const setPullRequestSummary = vi.fn();
      const { pane, request, emitGatewayEvent } = createPullRequestPane({
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
      } as unknown as SessionCapability);
      pane.refreshSessionPullRequests({ refresh });
      await Promise.resolve();
      await Promise.resolve();
      if (refresh) {
        expect(request).toHaveBeenCalledWith(
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          { sessionKeys: ["agent:main:current"], refreshSessionKeys: ["agent:main:current"] },
          { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
        );
      }
      emitSnapshot(emitGatewayEvent, "agent:main:current", {
        pullRequests,
        rateLimited,
        status: rateLimited ? "rate-limited" : "ready",
      });
      pane.refreshSessionPullRequests();
      await Promise.resolve();
      if (rateLimited) {
        expect(setPullRequestSummary).not.toHaveBeenCalled();
      } else {
        expect(setPullRequestSummary).toHaveBeenCalledWith("agent:main:current", summary, epoch);
      }
    },
  );

  it.each(["session switch", "disconnect", "branch switch"] as const)(
    "retires pane PR state on %s",
    async (change) => {
      const epoch = {};
      const setPullRequestSummary = vi.fn();
      const { pane, state, emitGatewayEvent } = createPullRequestPane({
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
      } as unknown as SessionCapability);
      pane.refreshSessionPullRequests();
      await Promise.resolve();
      emitSnapshot(emitGatewayEvent, state.sessionKey, {
        branch: {
          owner: "openclaw",
          repo: "openclaw",
          branch: "feature/demo",
          createUrl: "https://github.com/openclaw/openclaw/pull/new/feature/demo",
        },
        pullRequests: [pullRequest(111532, "open")],
        rateLimited: false,
        status: "ready",
      });
      pane.refreshSessionPullRequests();
      await Promise.resolve();
      expect(pane.sessionPullRequests).toHaveLength(1);
      expect(pane.githubRepo).toEqual({ owner: "openclaw", repo: "openclaw" });
      if (change === "disconnect") {
        pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "reconnecting" });
      } else {
        if (change === "session switch") {
          state.sessionKey = "agent:main:current-2";
        } else {
          emitGatewayEvent("sessions.changed", {
            sessionKey: state.sessionKey,
            agentId: "main",
            reason: "branch-switch",
          });
        }
        pane.refreshSessionPullRequests();
        await Promise.resolve();
      }
      expect(pane.sessionPullRequests).toEqual([]);
      expect(pane.sessionPullRequestsBranch).toBeUndefined();
      expect(pane.githubRepo).toBeNull();
      if (change === "branch switch") {
        expect(setPullRequestSummary).toHaveBeenLastCalledWith(
          "agent:main:current",
          undefined,
          epoch,
        );
      }
      if (change === "session switch") {
        emitSnapshot(emitGatewayEvent, "agent:main:current", {
          pullRequests: [pullRequest(1, "open")],
          rateLimited: false,
          status: "ready",
        });
        pane.refreshSessionPullRequests();
        await Promise.resolve();
        emitSnapshot(emitGatewayEvent, state.sessionKey, {
          pullRequests: [pullRequest(2, "open")],
          rateLimited: false,
          status: "ready",
        });
        pane.refreshSessionPullRequests();
        await Promise.resolve();
        expect(pane.sessionPullRequests).toEqual([expect.objectContaining({ number: 2 })]);
      }
    },
  );
});

it.each([
  { access: "no read scope" },
  { access: "worktree" },
  { access: "repository" },
  { access: "no shared publisher" },
  { access: "viewer" },
  { access: "member" },
  { access: "unknown" },
  { access: "archived" },
] as const)("derives publication controls from current access: $access", async ({ access }) => {
  const { pane, state, context, request, options, shared, settled } = createPublicationPane(
    undefined,
    access === "no read scope" ? [] : ["operator.sessions.write"],
  );
  if (access === "no read scope") {
    pane.render();
    expect(pane.chatProps?.githubPublication).toBeUndefined();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.options")).toBe(false);
    return;
  }
  const row = state.sessionsResult!.sessions[0]!;
  row.sharingRole =
    access === "viewer" || access === "member"
      ? access
      : access === "unknown"
        ? undefined
        : "owner";
  row.archived = access === "archived";
  if (access === "repository") {
    delete row.worktree;
    row.repositoryWorkspaceId = "repository-publication";
    row.repository = {
      url: "https://github.com/synthetic/visitor-demo",
      branch: "feature/publication",
    };
  }
  if (access === "no shared publisher") {
    options.shared = null;
  }
  const guest = await settled();
  expect(guest.onSelect).toBeUndefined();
  expect(guest.onConfirm).toBeUndefined();
  if (access !== "worktree" && access !== "repository") {
    expect(guest.onPublish).toBeUndefined();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
    return;
  }
  expect(guest.onPublish).toBeTypeOf("function");
  guest.onPublish?.();
  await settled();
  expect(request).toHaveBeenLastCalledWith("sessions.github.publish", {
    sessionKey: state.sessionKey,
    agentId: "main",
    idempotencyKey: expect.any(String),
    selection: { source: "shared", expected: shared },
  });
  const previous = pane.chatProps!.githubPublication!;
  context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["sessions.github.publish", "sessions.github.options"],
    ["operator.sessions.read"],
  );
  previous.onPublish?.();
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
  ).toHaveLength(1);
  expect((await settled()).onPublish).toBeUndefined();
});

it.each(["incarnation", "sharing", "archive-projection"] as const)(
  "rejects a stale idle publication before render: %s",
  async (change) => {
    const { pane, state, context, request, settled } = createPublicationPane();
    const idle = await settled();
    const current = state.sessionsResult!.sessions[0]!;
    const row = { ...current, updatedAt: 2 };
    if (change === "incarnation") {
      row.sessionId = "replacement";
    }
    if (change === "sharing") {
      row.visibility = "draft";
      row.sharingRole = "viewer";
    }
    if (change === "archive-projection") {
      state.selectedChatSessionArchived = true;
    }
    state.sessionsResult = { ...state.sessionsResult!, sessions: [row] };
    context.sessions.reconcile(row);
    // Canonical state changed, but Lit has not committed a replacement button yet.
    idle.onPublish?.();
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(0);
    pane.render();
  },
);

describe("PR refresh wire ownership", () => {
  it.each([
    { name: "identical finals on separate frames", texts: ["Opened", "Opened"], expected: 1 },
    { name: "distinct finals in the same burst", texts: ["Opened", "Merged"], expected: 1 },
    {
      name: "distinct finals after the debounce interval",
      texts: ["Opened", "Merged"],
      spaced: true,
      expected: 2,
    },
    { name: "the first live final after history", texts: ["Opened"], history: true, expected: 1 },
    {
      name: "the first presented final after hidden delivery",
      texts: ["Opened", "Opened"],
      hiddenFirst: true,
      expected: 1,
    },
    {
      name: "a stream announcement followed by its final",
      texts: ["Opened"],
      stream: true,
      expected: 1,
    },
    {
      name: "a final whose queued refresh lost its last watch before sync",
      texts: ["Opened", "Opened"],
      loseWatchBeforeSync: true,
      expected: 1,
    },
    { name: "a same-session background final", texts: ["Opened"], background: true, expected: 1 },
    {
      name: "reconnect between final deliveries",
      texts: ["Opened", "Opened"],
      reconnect: true,
      expected: 1,
    },
    {
      name: "explicit history reset between finals",
      texts: ["Opened", "Opened"],
      reset: true,
      expected: 1,
    },
    {
      name: "ordinary history between final replays",
      texts: ["Opened", "Opened"],
      historyBetween: true,
      expected: 1,
    },
    {
      name: "a genuine branch switch before the next final",
      texts: ["Opened", "Opened"],
      branchSwitch: true,
      expected: 1,
    },
  ])(
    "keeps subscription force scoped for $name",
    async ({
      texts,
      expected,
      history,
      hiddenFirst,
      stream,
      background,
      reconnect,
      reset,
      historyBetween,
      branchSwitch,
      loseWatchBeforeSync,
      spaced,
    }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const sessions = makeChatHost().sessions;
      onTestFinished(() => sessions.dispose());
      const { pane, state, request, emitGatewayEvent } = createPullRequestPane(sessions);
      Object.assign(
        state,
        makeChatHost({
          client: state.client,
          connectionEpoch: state.connectionEpoch,
          sessionKey: state.sessionKey,
          sessions: state.sessions,
        }),
        {
          chatMessagesBySession: new Map(),
          pendingSessionMessageReloadSessionKey: null,
          requestUpdate: vi.fn(),
        },
      );
      state.refreshSessionPullRequests = (options) => pane.refreshSessionPullRequests(options);
      state.chatRunId = background ? "foreground-run" : "wire-pr-run";
      const key = state.sessionKey;
      const otherKey = "agent:main:unrelated";
      const store = sessionPullRequestsForGateway(pane.context.gateway);
      const otherOwner = {};
      store.watch(otherOwner, [otherKey]);
      onTestFinished(() => store.unwatch(otherOwner));
      pane.refreshSessionPullRequests();
      await Promise.resolve();
      await nextFrame();
      request.mockClear();
      const message = (text: string) => ({
        role: "assistant",
        content: [
          { type: "text", text: `${text} https://github.com/openclaw/openclaw/pull/111532` },
        ],
      });
      if (history) {
        reduceChatSessionProjection(state, {
          type: "snapshotLoaded",
          messages: [message("Opened")],
        });
        reduceChatSessionProjection(state, {
          type: "runTerminal",
          runId: "wire-pr-run",
          status: "completed",
        });
        state.chatRunId = null;
      }
      if (stream) {
        handlePageGatewayEvent(state, {
          type: "event",
          event: "chat",
          payload: {
            state: "delta",
            runId: "wire-pr-run",
            sessionKey: key,
            deltaText: "Opened https://github.com/openclaw/openclaw/pull/111532 ",
          },
        });
        await nextFrame();
      }
      for (const [index, text] of texts.entries()) {
        if (index > 0 && reconnect) {
          pane.connectionGeneration += 1;
          state.connectionEpoch = pane.connectionGeneration;
        }
        if (index > 0 && reset) {
          resetChatHistoryProjection(state);
        }
        if (index > 0 && historyBetween) {
          reduceChatSessionProjection(state, {
            type: "snapshotLoaded",
            messages: [message("Opened")],
          });
        }
        if (index > 0 && branchSwitch) {
          const payload = { sessionKey: key, agentId: "main", reason: "branch-switch" };
          handlePageGatewayEvent(
            state,
            { type: "event", event: "sessions.changed", payload },
            () => false,
          );
          emitGatewayEvent("sessions.changed", payload);
          await nextFrame();
        }
        pane.presented = !(hiddenFirst && index === 0);
        handlePageGatewayEvent(state, {
          type: "event",
          event: "chat",
          payload: {
            state: "final",
            runId: "wire-pr-run",
            sessionKey: key,
            message: message(text),
          },
        });
        if (index === 0 && loseWatchBeforeSync) {
          pane.presented = false;
        }
        // Preserve separate WebSocket deliveries within the debounce window.
        await nextFrame();
        if (spaced) {
          await vi.advanceTimersByTimeAsync(5_000);
        }
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await nextFrame();
      const forces = request.mock.calls.filter(
        ([method, params]) =>
          method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD &&
          Array.isArray(params?.refreshSessionKeys) &&
          params.refreshSessionKeys.length > 0,
      );
      for (const [, params] of forces) {
        expect(params).toEqual({ sessionKeys: [key, otherKey], refreshSessionKeys: [key] });
      }
      expect(forces).toHaveLength(expected);
    },
  );
});
