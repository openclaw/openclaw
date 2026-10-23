/* @vitest-environment jsdom */

import { setImmediate as nextFrame } from "node:timers/promises";
import { createEffect, createMemo, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
  type ControlUiSessionPullRequests,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import {
  account,
  confirmation,
  generation,
  options as publicationOptions,
  requestId,
  shared,
} from "./chat-github-publication.test-support.ts";
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

const repository = { owner: "openclaw", repo: "openclaw" };
const branch = { ...repository, branch: "feature/demo" };

function pullRequest(
  number: number,
  state: ControlUiSessionPullRequest["state"],
): ControlUiSessionPullRequest {
  return {
    number,
    ...branch,
    title: `Pull request ${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    state,
  };
}

function createPullRequestPane(sessions?: SessionCapability) {
  const epoch = {};
  const setPullRequestSummary = vi.fn();
  const request = vi.fn().mockResolvedValue({ subscribed: true });
  const harness = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
    sessions:
      sessions ??
      ({
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
        pullRequestSummary: vi.fn(() => undefined),
      } as unknown as SessionCapability),
  });
  harness.pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
    ["operator.read", "operator.write"],
  );
  const push = (snapshot: Parameters<typeof emitSnapshot>[2], key = harness.state.sessionKey) => {
    emitSnapshot(harness.emitGatewayEvent, key, snapshot);
    harness.pane.refreshSessionPullRequests();
  };
  return { ...harness, request, epoch, setPullRequestSummary, push };
}

function emitSnapshot(
  emitGatewayEvent: (event: string, payload: unknown) => void,
  sessionKey: string,
  snapshot: Omit<ControlUiSessionPullRequests, "rateLimited"> & { rateLimited?: boolean },
) {
  emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: { [sessionKey]: { rateLimited: false, status: "ready", ...snapshot } },
  });
}

function createPublicationPane(
  scope?: "global" | "per-sender",
  operatorScopes = ["operator.read", "operator.write"],
) {
  const agentId = scope ? "research" : "main";
  const sessionKey = scope ? "global" : "agent:main:publication";
  const options = { ...publicationOptions };
  const responses = new Map<string, unknown>([
    ["projects.list", { projects: [] }],
    ["sessions.github.options", options],
    [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, { subscribed: true }],
    ["sessions.github.publish", new Error("Response lost")],
  ]);
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (!responses.has(method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    const response = responses.get(method);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const client = createGatewayBrowserClientFixture({ request });
  const initial = createInitializationContext();
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
  const events = createApplicationGateway({
    ...initial.gateway.snapshot,
    client,
    phase: "connected",
    hello,
    assistantAgentId: agentId,
    sessionKey,
    selfUser: { id: "publication-person", identity: { type: "profile", id: "publication-person" } },
  });
  const gateway = { ...initial.gateway, ...events.gateway, connection: initial.gateway.connection };
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
    // Scoped lists may carry the owner only at the result/route level.
    ...sessionsResult([
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
    ]),
    path: "",
  };
  const settled = async () => {
    await vi.waitFor(() => {
      pane.render();
      expect(pane.chatProps?.githubPublication?.activity).toBeNull();
    });
    return pane.chatProps!.githubPublication!;
  };
  const emitGatewayEvent = (event: string, payload: unknown) => {
    events.publishEvent({ type: "event", event, payload });
  };
  const publications = () =>
    request.mock.calls.filter(([method]) => method === "sessions.github.publish");
  return {
    pane,
    state,
    context,
    request,
    options,
    responses,
    publications,
    settled,
    emitGatewayEvent,
  };
}

it("keeps the pane quiet for unrelated PR snapshots while publishing its own changes", () => {
  const { pane, state, emitGatewayEvent } = createPullRequestPane();
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
  const redraw = vi.fn();
  mountSolid(() => {
    projectChatFields(pane.repository);
    const source = createMemo(() => {
      const target = pane.repository.target;
      return target && projectOwner(target.store, (owner) => owner.get(target.key), Object.is);
    });
    createEffect(() => source()?.read(), redraw);
    return null;
  });
  flush();
  redraw.mockClear();
  notified.mockClear();

  emitSnapshot(emitGatewayEvent, "agent:main:unwatched", snapshot);
  flush();
  expect.soft(notified).not.toHaveBeenCalled();
  expect.soft(redraw).not.toHaveBeenCalled();
  notified.mockClear();
  redraw.mockClear();

  emitSnapshot(emitGatewayEvent, otherKey, {
    ...snapshot,
    pullRequests: [pullRequest(2, "merged")],
  });
  flush();
  expect(notified).toHaveBeenCalledOnce();
  expect.soft(redraw).not.toHaveBeenCalled();
  expect(pane.sessionPullRequests).toEqual(snapshot.pullRequests);
  redraw.mockClear();

  emitSnapshot(emitGatewayEvent, state.sessionKey, {
    pullRequests: [],
    rateLimited: false,
    status: "unavailable",
  });
  flush();
  expect(redraw).toHaveBeenCalledOnce();
  expect(pane.sessionPullRequests).toEqual(snapshot.pullRequests);
  redraw.mockClear();

  state.sessionKey = otherKey;
  pane.refreshSessionPullRequests();
  flush();
  expect(redraw).toHaveBeenCalledOnce();
  expect(pane.sessionPullRequests).toEqual([pullRequest(2, "merged")]);
});

it.each(["unavailable", "rate-limited"] as const)(
  "applies retained and replaced repository snapshots during %s",
  async (status) => {
    const { pane, push, epoch, setPullRequestSummary } = createPullRequestPane();
    const key = "agent:main:current";
    pane.refreshSessionPullRequests();
    await Promise.resolve();
    push({
      repository,
      branch,
      pullRequests: [pullRequest(111532, "open")],
    });
    const failure = { pullRequests: [], rateLimited: status === "rate-limited", status };
    push({ ...failure, repository });
    expect(pane.sessionPullRequests).toHaveLength(1);
    expect(pane.sessionPullRequestsBranch?.branch).toBe("feature/demo");

    const replacement = { owner: "other", repo: "checkout" };
    push({ ...failure, repository: replacement });
    expect(pane.sessionPullRequests).toEqual([]);
    expect(pane.sessionPullRequestsBranch).toBeUndefined();
    expect(setPullRequestSummary).toHaveBeenLastCalledWith(key, undefined, epoch);
  },
);

it.each(["global", "per-sender"] as const)(
  "preserves the selected raw-global owner through publication RPCs in %s scope",
  async (scope) => {
    const { pane, request, responses, settled } = createPublicationPane(scope);
    responses.delete("projects.list");
    const result = {
      requestId,
      publisher: { source: "personal", ...account },
      status: "needs_confirmation",
    };
    responses.set("sessions.github.publish", result);
    responses.set("sessions.github.status", { result, confirmation });
    responses.set("sessions.github.confirm", { ...result, status: "published" });
    (await settled()).onSelect?.("personal");
    pane.render();
    void pane.chatProps!.githubPublication!.onPublish?.();
    void (await settled()).onConfirm?.();
    await settled();
    expect(request.mock.calls.filter(([method]) => method.startsWith("sessions.github."))).toEqual(
      ["options", "publish", "status", "confirm"].map((method) => [
        `sessions.github.${method}`,
        expect.objectContaining({ sessionKey: "global", agentId: "research" }),
      ]),
    );
  },
);

it("retires hidden publication feedback while retaining the admitted write and its result", async () => {
  const { pane, request, responses, publications, settled } = createPublicationPane();
  const response = Promise.withResolvers<unknown>();
  responses.set("sessions.github.publish", response.promise);
  const ready = await settled();
  let retired = false;
  void ready.readiness.retired.then(() => {
    retired = true;
  });
  const completion = ready.onPublish?.();
  let completed = false;
  void Promise.resolve(completion).then(() => {
    completed = true;
  });
  expect(publications()).toHaveLength(1);

  pane.presented = false;
  // Hiding must retire the receipt before any render of the parked frame or RPC settlement.
  await Promise.resolve();
  expect(retired).toBe(true);
  expect(completed).toBe(false);

  const result = {
    requestId,
    publisher: shared,
    status: "published",
    url: "https://github.com/openclaw/openclaw/pull/111532",
    repository: "openclaw/openclaw",
    branch: "feature/publication",
    headCommit: "a".repeat(40),
  };
  response.resolve(result);
  await completion;
  pane.presented = true;
  expect((await settled()).result).toEqual(result);
  expect(publications()).toHaveLength(1);
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.github.options"),
  ).toHaveLength(1);
});

it.each(["shared", "personal"] as const)(
  "retains an unknown %s publication across a retained-pane navigation",
  async (source) => {
    const { pane, state, request, options, settled, publications } = createPublicationPane();
    (await settled()).onSelect?.(source);
    pane.render();
    void pane.chatProps!.githubPublication!.onPublish?.();
    let unknown = await settled();
    expect(unknown.locked).toBe(true);
    const first = publications()[0];
    expect(first?.[1]).toEqual({
      sessionKey: state.sessionKey,
      agentId: "main",
      idempotencyKey: expect.any(String),
      selection:
        source === "shared" ? { source, expected: shared } : { source, generation, account },
    });
    if (source === "shared") {
      options.shared = null;
      void unknown.onRefresh();
      unknown = await settled();
      expect(unknown.onPublish).toBeTypeOf("function");
    }

    pane.presented = false;
    pane.render();
    expect(pane.chatProps?.githubPublication).toBeUndefined();
    const hiddenRequests = request.mock.calls.length;
    void unknown.onPublish?.();
    void unknown.onRefresh();
    expect(request).toHaveBeenCalledTimes(hiddenRequests);
    pane.presented = true;
    const returned = await settled();

    expect([returned.locked, returned.selection]).toEqual([true, unknown.selection]);
    const knownRoster = state.sessionsResult!;
    state.sessionsResult = { ...knownRoster, count: 0, sessions: [] };
    const beforeMissingRow = request.mock.calls.length;
    void returned.onPublish?.();
    void returned.onRefresh();
    expect(request).toHaveBeenCalledTimes(beforeMissingRow);
    pane.render();
    expect(pane.chatProps?.githubPublication).toBeUndefined();
    state.sessionsResult = knownRoster;
    const restored = await settled();
    expect([restored.locked, restored.selection]).toEqual([true, unknown.selection]);
    void restored.onPublish?.();
    await settled();
    expect(publications()).toEqual([first, first]);
  },
);

it.each(["truncated history", "merged", "empty rate-limited", "withdrawn rate-limited"])(
  "publishes pushed PR summaries: %s",
  async (mode) => {
    const refresh = mode === "truncated history";
    const discardPrevious = mode === "withdrawn rate-limited";
    const rateLimited = mode === "empty rate-limited" || discardPrevious;
    const pullRequests = refresh
      ? [
          pullRequest(999, "draft"),
          ...Array.from({ length: 20 }, (_, i) => pullRequest(i + 1, "closed")),
        ]
      : rateLimited
        ? []
        : [pullRequest(111532, "merged")];
    const summary = discardPrevious
      ? undefined
      : refresh
        ? { numbers: [...Array.from({ length: 19 }, (_, i) => i + 1), 999], state: "draft" }
        : { numbers: [111532], state: "merged" };
    const { pane, request, push, epoch, setPullRequestSummary } = createPullRequestPane();
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
    push({
      pullRequests,
      rateLimited,
      status: rateLimited ? "rate-limited" : "ready",
      discardPrevious: discardPrevious ? true : undefined,
    });
    await Promise.resolve();
    if (rateLimited && !discardPrevious) {
      expect(setPullRequestSummary).not.toHaveBeenCalled();
    } else {
      expect(setPullRequestSummary).toHaveBeenCalledWith("agent:main:current", summary, epoch);
    }
  },
);

it.each(["session switch", "disconnect", "branch switch"] as const)(
  "retires pane PR state on %s",
  async (change) => {
    const { pane, state, push, emitGatewayEvent, epoch, setPullRequestSummary } =
      createPullRequestPane();
    pane.refreshSessionPullRequests();
    await Promise.resolve();
    push({
      branch: {
        ...branch,
        createUrl: "https://github.com/openclaw/openclaw/pull/new/feature/demo",
      },
      pullRequests: [pullRequest(111532, "open")],
    });
    await Promise.resolve();
    expect(pane.sessionPullRequests).toHaveLength(1);
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
    if (change === "branch switch") {
      expect(setPullRequestSummary).toHaveBeenLastCalledWith(
        "agent:main:current",
        undefined,
        epoch,
      );
    }
    if (change === "session switch") {
      push({ pullRequests: [pullRequest(1, "open")] }, "agent:main:current");
      await Promise.resolve();
      push({ pullRequests: [pullRequest(2, "open")] });
      await Promise.resolve();
      expect(pane.sessionPullRequests).toEqual([expect.objectContaining({ number: 2 })]);
    }
  },
);

it.each([
  "no read scope",
  "worktree",
  "repository",
  "no shared publisher",
  "viewer",
  "member",
  "unknown",
  "archived",
] as const)("derives publication controls from current access: %s", async (access) => {
  const { pane, state, context, request, options, settled, publications } = createPublicationPane(
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
  expect(guest).toMatchObject({ onSelect: undefined, onConfirm: undefined });
  if (access !== "worktree" && access !== "repository") {
    expect(guest.onPublish).toBeUndefined();
    expect(publications()).toHaveLength(0);
    return;
  }
  expect(guest.onPublish).toBeTypeOf("function");
  void guest.onPublish?.();
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
  void previous.onPublish?.();
  expect(publications()).toHaveLength(1);
  expect((await settled()).onPublish).toBeUndefined();
});

it.each(["incarnation", "sharing", "archive-projection"] as const)(
  "rejects a stale idle publication before render: %s",
  async (change) => {
    const { pane, state, context, publications, settled } = createPublicationPane();
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
    // Invoke the captured action before rendering its replacement.
    void idle.onPublish?.();
    expect(publications()).toHaveLength(0);
    pane.render();
  },
);

it.each([
  ["identical finals on separate frames", "duplicate"],
  ["distinct finals in the same burst", "burst"],
  ["distinct finals after the debounce interval", "spaced"],
  ["the first live final after history", "history"],
  ["the first presented final after hidden delivery", "hiddenFirst"],
  ["a stream announcement followed by its final", "stream"],
  ["a final whose queued refresh lost its last watch before sync", "loseWatchBeforeSync"],
  ["a same-session background final", "background"],
  ["reconnect between final deliveries", "reconnect"],
  ["explicit history reset between finals", "reset"],
  ["ordinary history between final replays", "historyBetween"],
  ["a genuine branch switch before the next final", "branchSwitch"],
] as const)("keeps subscription force scoped for %s", async (_name, mode) => {
  const texts = ["history", "stream", "background"].includes(mode)
    ? ["Opened"]
    : ["Opened", mode === "burst" || mode === "spaced" ? "Merged" : "Opened"];
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
    { chatMessagesBySession: new Map(), pendingSessionMessageReloadSessionKey: null },
  );
  state.refreshSessionPullRequests = (options) => pane.refreshSessionPullRequests(options);
  state.chatRunId = mode === "background" ? "foreground-run" : "wire-pr-run";
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
    content: [{ type: "text", text: `${text} https://github.com/openclaw/openclaw/pull/111532` }],
  });
  const deliver = (payload: Record<string, unknown>) =>
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: { runId: "wire-pr-run", sessionKey: key, ...payload },
    });
  const loadHistory = () =>
    reduceChatSessionProjection(state, { type: "snapshotLoaded", messages: [message("Opened")] });
  if (mode === "history") {
    loadHistory();
    reduceChatSessionProjection(state, {
      type: "runTerminal",
      runId: "wire-pr-run",
      status: "completed",
    });
    state.chatRunId = null;
  }
  if (mode === "stream") {
    deliver({
      state: "delta",
      deltaText: "Opened https://github.com/openclaw/openclaw/pull/111532 ",
    });
    await nextFrame();
  }
  for (const [index, text] of texts.entries()) {
    if (index > 0 && mode === "reconnect") {
      pane.connectionGeneration += 1;
      state.connectionEpoch = pane.connectionGeneration;
    }
    if (index > 0 && mode === "reset") {
      resetChatHistoryProjection(state);
    }
    if (index > 0 && mode === "historyBetween") {
      loadHistory();
    }
    if (index > 0 && mode === "branchSwitch") {
      const payload = { sessionKey: key, agentId: "main", reason: "branch-switch" };
      handlePageGatewayEvent(
        state,
        { type: "event", event: "sessions.changed", payload },
        () => false,
      );
      emitGatewayEvent("sessions.changed", payload);
      await nextFrame();
    }
    pane.presented = !(mode === "hiddenFirst" && index === 0);
    deliver({ state: "final", message: message(text) });
    if (index === 0 && mode === "loseWatchBeforeSync") {
      pane.presented = false;
    }
    // Preserve separate WebSocket deliveries within the debounce window.
    await nextFrame();
    if (mode === "spaced") {
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
  expect(forces).toHaveLength(mode === "spaced" ? 2 : 1);
});
