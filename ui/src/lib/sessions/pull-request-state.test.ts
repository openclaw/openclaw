import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  GitHubPublicationOwner,
  type GitHubPublicationOptions,
} from "./github-publication-owner.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";
import type { GitHubPublicationBinding, SessionGateway } from "./session-capability.ts";
import { sessionRetryDelayMs } from "./session-retry.ts";

function observers<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T) {
      listeners.forEach((listener) => listener(value));
    },
  };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: SessionGateway["snapshot"] = {
    client,
    phase: "connected",
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  const snapshots = observers<typeof snapshot>();
  const events = observers<GatewayEventFrame>();
  const update = (next: Partial<SessionGateway["snapshot"]>) => {
    snapshot = { ...snapshot, ...next };
    snapshots.emit(snapshot);
  };
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: snapshots.subscribe,
      subscribeEvents: events.subscribe,
    },
    emitEvent: events.emit,
    sessionEvent(session: GatewaySessionRow, reason = "patch", agentId = "main") {
      events.emit({
        type: "event",
        event: "sessions.changed",
        payload: { agentId, reason, session },
      });
    },
    update,
    publish(
      this: void,
      connected: boolean,
      nextClient: GatewayBrowserClient | null = snapshot.client,
    ) {
      update({ client: nextClient, phase: connected ? "connected" : "reconnecting" });
    },
  };
}

describe("session pull-request state", () => {
  it("publishes state removal for client replacement and disconnect", () => {
    const harness = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createTestSessionCapability(harness.gateway);
    const listener = vi.fn();
    const summary = { numbers: [111532], state: "open" as const };
    sessions.subscribe(listener);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toEqual(summary);
    expect(listener).toHaveBeenCalledTimes(1);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    expect(listener).toHaveBeenCalledTimes(1);

    const publicationsBeforeReplacement = listener.mock.calls.length;
    harness.publish(true, {} as GatewayBrowserClient);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
    expect(listener.mock.calls.length).toBeGreaterThan(publicationsBeforeReplacement);

    sessions.setPullRequestSummary("agent:main:pr-session", summary);
    const publicationsBeforeDisconnect = listener.mock.calls.length;
    harness.publish(false);
    expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
    expect(listener.mock.calls.length).toBeGreaterThan(publicationsBeforeDisconnect);
  });

  it("rejects an older pane's pull-request result", () => {
    const sessions = createTestSessionCapability(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
    );
    const key = "agent:main:shared-session";
    const olderEpoch = sessions.capturePullRequestEpoch(key);
    const newerEpoch = sessions.capturePullRequestEpoch(key);

    sessions.setPullRequestSummary(key, { numbers: [111532], state: "draft" }, newerEpoch);
    sessions.setPullRequestSummary(key, undefined, olderEpoch);

    expect(sessions.pullRequestSummary(key)).toEqual({ numbers: [111532], state: "draft" });
  });

  it("retires pull-request state when a session is deleted", async () => {
    const key = "agent:main:deleted-pr";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true, deleted: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(
      createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway,
    );
    const epoch = sessions.capturePullRequestEpoch(key);
    sessions.setPullRequestSummary(key, { numbers: [111532], state: "open" }, epoch);

    await expect(sessions.delete(key)).resolves.toEqual({ deleted: true });
    expect(sessions.pullRequestSummary(key)).toBeUndefined();

    sessions.setPullRequestSummary(key, { numbers: [111532], state: "open" }, epoch);
    expect(sessions.pullRequestSummary(key)).toBeUndefined();
  });
});

const sharedPublisher = { source: "system-configured" as const, accountId: 1, login: "system-bot" };
const sharedOptions = {
  shared: sharedPublisher,
  personal: null,
  pendingPersonal: null,
  latestShared: null,
};
function publicationCalls(
  request: { mock: { calls: [string, ...unknown[]][] } },
  method = "publish",
) {
  return request.mock.calls.filter(([name]) => name === `sessions.github.${method}`);
}
function globalRow(agentId: string, sessionId: string): GatewaySessionRow {
  return { key: "global", agentId, kind: "global", sessionId, updatedAt: 1 };
}
const publicationChanges = new WeakMap<GitHubPublicationBinding, () => Promise<void>>();
function publicationHarness(responses?: {
  options?: () => unknown;
  status?: () => unknown;
  subscribe?: () => unknown;
}) {
  const replies: Record<string, (() => unknown) | undefined> = {
    "sessions.github.options": responses ? responses.options : () => sharedOptions,
    "sessions.github.publish": responses
      ? undefined
      : () => {
          throw new Error("Response lost");
        },
    "sessions.list": () => sessionsResult([], 2),
    "sessions.subscribe": responses ? responses.subscribe : () => ({ subscribed: true }),
    "sessions.github.status": responses?.status,
  };
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    const reply = replies[method];
    if (!reply) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return reply();
  });
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(harness.gateway);
  const row = (id: string): GatewaySessionRow => ({
    key: `agent:main:${id}`,
    kind: "direct",
    sessionId: id,
    updatedAt: 1,
  });
  const attach = (session = row("publication")) => {
    let changed = createDeferred();
    const binding = sessions.githubPublication.attach(
      session,
      () => {
        const previous = changed;
        changed = createDeferred();
        previous.resolve();
      },
      GitHubPublicationOwner,
    )!;
    publicationChanges.set(binding, () => changed.promise);
    binding.sync({
      canPublishShared: true,
      canPublishPersonal: true,
      personalReady: true,
      isPresented: () => true,
      isCurrent: () => binding.matches(session),
    });
    onTestFinished(() => binding.detach());
    return binding;
  };
  const ready = async (session?: GatewaySessionRow) => {
    const binding = attach(session);
    await publicationSettled(binding);
    return binding;
  };
  const pending = async (session?: GatewaySessionRow) => {
    const binding = await ready(session);
    const view = binding.view()!;
    const response = createDeferred<unknown>();
    request.mockImplementationOnce(() => response.promise);
    view.onPublish?.();
    return { binding, view, response, original: request.mock.calls.at(-1) };
  };
  const globalHello = () => {
    const hello = gatewayHelloForMethods(["sessions.github.publish"]);
    hello.snapshot = {
      sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: "global" },
    };
    harness.update({ hello });
  };
  return { ...harness, request, sessions, row, attach, ready, pending, globalHello };
}
async function publicationSettled(binding: GitHubPublicationBinding) {
  const nextChange = publicationChanges.get(binding)!;
  await vi.waitFor(async () => {
    // Completion can start a queued refresh before this notification resumes us.
    while (binding.view()?.activity !== null) {
      await nextChange();
    }
    expect(binding.view()?.activity).toBeNull();
  });
  return binding.view()!;
}
const publishedResult = {
  requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc77",
  publisher: sharedPublisher,
  status: "published",
  url: "https://github.com/team/demo/pull/1",
  repository: "team/demo",
  branch: "feature/one",
  headCommit: "a".repeat(40),
};
const acceptedResult = {
  requestId: publishedResult.requestId,
  publisher: sharedPublisher,
  status: "requested",
  message: "Accepted.",
};
async function publishAndSettle(binding: GitHubPublicationBinding) {
  (await publicationSettled(binding)).onPublish?.();
  return publicationSettled(binding);
}

describe("application-owned publication custody", () => {
  it.each(["research", "main"])("keeps the ordinary %s global session literal", async (agentId) => {
    const { attach, request, globalHello } = publicationHarness();
    globalHello();
    const key = `agent:${agentId}:global`;
    const binding = attach({ key, agentId, kind: "global", sessionId: key, updatedAt: 1 });
    await publicationSettled(binding);
    expect(request.mock.calls.filter(([method]) => method.startsWith("sessions.github."))).toEqual([
      ["sessions.github.options", { sessionKey: key, agentId }],
    ]);
  });

  it("keeps every publication stage on its explicit global owner when another owner attaches", async () => {
    const { attach, request, globalHello } = publicationHarness();
    globalHello();
    const account = { accountId: 2, login: "synthetic-tools" };
    const generation = "bdca439a-e787-4f9f-b5f3-a878c662cc76";
    const requestId = "bdca439a-e787-4f9f-b5f3-a878c662cc77";
    const options: GitHubPublicationOptions = {
      shared: null,
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
    const result = {
      requestId,
      publisher: { source: "personal" as const, ...account },
      status: "needs_confirmation" as const,
      message: "Review the synthetic publication.",
    };
    const confirmation = {
      account,
      generation,
      requestDigest: "a".repeat(64),
      pushRepository: "synthetic/demo",
      repository: "synthetic/demo",
      branch: "feature/one",
      baseBranch: "main",
      sourceHeadCommit: "1".repeat(40),
      sourceIndexTree: "2".repeat(40),
      workspaceTree: "3".repeat(40),
    };
    request.mockResolvedValueOnce(options);
    const research = attach(globalRow("research", "research-parent"));
    (await publicationSettled(research)).onSelect!("personal");
    request.mockResolvedValueOnce(result).mockResolvedValueOnce({ result, confirmation });
    research.view()!.onPublish!();
    const review = await publicationSettled(research);
    request.mockResolvedValueOnce({ ...publishedResult, requestId, publisher: result.publisher });
    review.onConfirm!();
    await publicationSettled(research);
    expect(request.mock.calls.filter(([method]) => method.startsWith("sessions.github."))).toEqual(
      ["options", "publish", "status", "confirm"].map((method) => [
        `sessions.github.${method}`,
        expect.objectContaining({ sessionKey: "global", agentId: "research" }),
      ]),
    );

    const old = createDeferred<GitHubPublicationOptions>();
    request.mockImplementationOnce(() => old.promise);
    research.view()!.onRefresh();
    research.detach();
    const mainOptions = {
      ...sharedOptions,
      shared: { source: "system-configured" as const, accountId: 3, login: "main-tools" },
    };
    request.mockResolvedValueOnce(mainOptions);
    const main = attach(globalRow("main", "main-parent"));
    expect((await publicationSettled(main)).options).toEqual(mainOptions);
    expect(request).toHaveBeenLastCalledWith("sessions.github.options", {
      sessionKey: "global",
      agentId: "main",
    });
    old.resolve({ ...options, pendingPersonal: { result, confirmation } });
    await nextTurn();
    expect(main.view()).toMatchObject({ options: mainOptions, result: null });
  });

  it.each(["not-deleted", "rejected", "confirmed"] as const)(
    "keeps publication custody until a pending deletion is %s",
    async (outcome) => {
      const { attach, request, row, sessions, pending } = publicationHarness();
      const session = row("publication");
      request.mockResolvedValueOnce(sessionsResult([session], 2));
      await sessions.refresh({ force: true });
      const {
        binding: first,
        view: ready,
        response: publication,
        original,
      } = await pending(session);
      const deletion = createDeferred<{ deleted: boolean }>();
      request.mockImplementationOnce(() => deletion.promise);
      const removal = sessions.delete(session.key, { expectedSessionId: session.sessionId }).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      expect(sessions.deletionState(session.key)).toBe("pending");
      publication.reject(new Error("Publication response lost"));
      // Let the publication response settle while the independent deletion is still pending.
      await nextTurn();
      expect(first.view()).toBeUndefined();
      ready.onPublish?.();
      ready.onRefresh();
      expect(publicationCalls(request)).toEqual([original]);
      first.detach();

      if (outcome === "rejected") {
        deletion.reject(new Error("Deletion failed"));
      } else {
        deletion.resolve({ deleted: outcome === "confirmed" });
      }
      const settled = await removal;
      if (outcome === "rejected") {
        expect(settled.error).toEqual(new Error("Deletion failed"));
      } else {
        expect(settled.value).toEqual({ deleted: outcome === "confirmed" });
      }
      const returned = attach(session);
      if (outcome === "confirmed") {
        expect(returned.view()).toBeUndefined();
      } else {
        const retry = await publicationSettled(returned);
        expect(retry.locked).toBe(true);
        await publishAndSettle(returned);
        expect(publicationCalls(request)).toEqual([original, original]);
      }
    },
  );

  it("shares idle bindings until the last detach and reloads options on return", async () => {
    const { attach, request, ready } = publicationHarness();
    const first = await ready();
    const second = await ready();
    expect(request).toHaveBeenCalledTimes(1);

    first.detach();
    first.detach();
    second.view()?.onRefresh();
    await publicationSettled(second);
    expect(request).toHaveBeenCalledTimes(2);

    second.detach();
    const replacementPublisher = { ...sharedPublisher, accountId: 3, login: "replacement-bot" };
    request.mockResolvedValueOnce({ ...sharedOptions, shared: replacementPublisher });
    const returned = attach();
    expect((await publicationSettled(returned)).selection).toEqual({
      source: "shared",
      expected: replacementPublisher,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["unknown", "published"] as const)(
    "keeps a late %s outcome after every presentation detaches",
    async (outcome) => {
      const { attach, request, sessions, pending } = publicationHarness();
      const { binding: first, view: ready, response, original } = await pending();
      first.detach();
      ready.onPublish?.();
      ready.onRefresh();
      ready.onSelect?.("personal");
      expect(request).toHaveBeenCalledTimes(2);
      // An empty filtered roster cannot retire an admitted operation.
      await sessions.list();
      if (outcome === "unknown") {
        response.reject(new Error("Response lost"));
      } else {
        response.resolve(publishedResult);
      }
      const returned = attach();
      const view = await publicationSettled(returned);
      if (outcome === "unknown") {
        expect(view).toMatchObject({
          locked: true,
          selection: { source: "shared", expected: sharedPublisher },
        });
        await publishAndSettle(returned);
        expect(publicationCalls(request)).toEqual([original, original]);
      } else {
        expect(view.result).toEqual(publishedResult);
        expect(view.onNewAction).toBeTypeOf("function");
      }
    },
  );

  it("refuses excess initial invocations while preserving all original retries until explicit acknowledgement", async () => {
    const { attach, request, row } = publicationHarness();
    for (let index = 0; index < 32; index += 1) {
      const binding = attach(row(`capacity-${index}`));
      await publishAndSettle(binding);
      binding.detach();
    }
    const full = attach(row("capacity-32"));
    expect((await publishAndSettle(full)).error).toContain("publications are awaiting review");
    expect(publicationCalls(request)).toHaveLength(32);
    const original = publicationCalls(request)[0];
    const retained = attach(row("capacity-0"));
    request.mockResolvedValueOnce(publishedResult);
    const terminal = await publishAndSettle(retained);
    expect(request.mock.calls.at(-1)).toEqual(original);
    full.view()?.onPublish?.();
    expect((await publicationSettled(full)).error).toContain("publications are awaiting review");
    terminal.onNewAction?.();
    await publicationSettled(retained);
    full.view()?.onPublish?.();
    await publicationSettled(full);
    expect(publicationCalls(request)).toHaveLength(34);
  });

  it.each([
    "disconnect",
    "profile",
    "access",
    "archive",
    "participation",
    "incarnation",
    "delete",
  ] as const)(
    "retires a detached operation after %s and rejects its late outcome",
    async (change) => {
      const { attach, request, row, publish, update, sessionEvent, pending } = publicationHarness();
      const { binding: first, view: ready, response } = await pending();
      first.detach();
      const session = row("publication");
      if (change === "disconnect") {
        publish(false);
        publish(true);
      } else if (change === "profile") {
        update({ selfUser: { id: "other", identity: { type: "profile", id: "other" } } });
      } else if (change === "access") {
        update({ hello: gatewayHelloForMethods(["sessions.github.publish"], ["operator.read"]) });
      } else {
        if (change === "archive") {
          session.archived = true;
        }
        if (change === "participation") {
          session.visibility = "draft";
          session.sharingRole = "viewer";
        }
        if (change === "incarnation") {
          session.sessionId = "replacement";
        }
        sessionEvent({ ...session, updatedAt: 2 }, change === "delete" ? "delete" : "patch");
      }
      response.resolve(publishedResult);
      ready.onPublish?.();
      ready.onRefresh();
      const returned = attach(session);
      if (change === "delete") {
        expect(returned.view()).toBeUndefined();
      } else {
        expect((await publicationSettled(returned)).result).toBeNull();
      }
      expect(publicationCalls(request)).toHaveLength(1);
    },
  );

  it("lets a replacement presentation observe the same operation without reviving detached callbacks", async () => {
    const { attach, request } = publicationHarness();
    const first = attach();
    const unknown = await publishAndSettle(first);
    const other = attach();
    first.detach();
    unknown.onPublish?.();
    expect(publicationCalls(request)).toHaveLength(1);
    await publishAndSettle(other);
    const calls = publicationCalls(request);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });
});

it("does not apply another agent's global-session permission event to a retained publication", async () => {
  const { attach, request, sessionEvent } = publicationHarness();
  const own: GatewaySessionRow = globalRow("main", "own-global");
  const binding = attach(own);
  const unknown = await publishAndSettle(binding);
  const original = request.mock.calls.at(-1);
  binding.detach();
  sessionEvent(
    {
      key: "global",
      kind: "global",
      sessionId: "other-global",
      updatedAt: 2,
      visibility: "draft",
      sharingRole: "viewer",
    },
    "patch",
    "writer",
  );
  const returned = attach(own);
  const retained = await publicationSettled(returned);
  expect(retained).toMatchObject({ locked: true, selection: unknown.selection });
  await publishAndSettle(returned);
  expect(publicationCalls(request)).toEqual([original, original]);
});

it("recovers pending publication observation when the session event subscription is restored", async () => {
  vi.useFakeTimers();
  const failure = new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "Observer unavailable",
    retryable: true,
  });
  const delay = sessionRetryDelayMs(failure);
  expect(delay).not.toBeNull();
  let subscriptions = 0;
  const fixture = publicationHarness({
    options: () => ({
      ...sharedOptions,
      latestShared: { result: acceptedResult, confirmation: null },
    }),
    status: () => ({ result: publishedResult, confirmation: null }),
    subscribe: () => {
      subscriptions += 1;
      if (subscriptions === 1) {
        throw failure;
      }
      return { subscribed: true };
    },
  });
  try {
    const binding = fixture.attach();
    await publicationSettled(binding);
    fixture.update({});
    await vi.waitFor(() => expect(subscriptions).toBe(1));
    await vi.advanceTimersByTimeAsync(delay!);
    await vi.waitFor(() => expect(subscriptions).toBe(2));
    await vi.waitFor(() => expect(binding.result?.status).toBe("published"));
    expect(publicationCalls(fixture.request, "status")).toHaveLength(1);
    expect(publicationCalls(fixture.request)).toHaveLength(0);
  } finally {
    fixture.publish(false);
    vi.useRealTimers();
  }
});

describe("shared publication event ownership", () => {
  it("coalesces publication hints into receipt reads without replaying writes", async () => {
    let stored: unknown = { result: acceptedResult, confirmation: null };
    const status = createDeferred<unknown>();
    const fixture = publicationHarness({
      options: () => ({ ...sharedOptions, latestShared: stored }),
      status: () => status.promise,
    });
    const binding = fixture.attach();
    expect((await publicationSettled(binding)).result?.status).toBe("requested");
    const key = fixture.row("publication").key;
    for (let i = 0; i < 10; i += 1) {
      fixture.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey: key, agentId: "main", reason: "github-publication" },
      });
    }
    expect(publicationCalls(fixture.request, "status")).toHaveLength(1);
    stored = { result: publishedResult, confirmation: null };
    status.resolve(stored);
    await vi.waitFor(() => expect(publicationCalls(fixture.request, "options")).toHaveLength(2));
    expect((await publicationSettled(binding)).result).toEqual(publishedResult);
    expect(publicationCalls(fixture.request)).toHaveLength(0);
  });

  it.each(["worktree", "branch", "repository"] as const)(
    "retires an admitted presentation on a known %s replacement",
    async (change) => {
      const fixture = publicationHarness();
      const original: GatewaySessionRow = {
        ...fixture.row("publication"),
        ...(change === "repository"
          ? { repositoryWorkspaceId: "repository-one" }
          : {
              worktree: { id: "worktree-one", branch: "feature/one", repoRoot: "/workspace/demo" },
            }),
      };
      const binding = await fixture.ready(original);
      fixture.request.mockResolvedValueOnce(acceptedResult);
      const pending = await publishAndSettle(binding);
      const replacement: GatewaySessionRow = {
        ...original,
        ...(original.worktree ? { worktree: { ...original.worktree } } : {}),
        updatedAt: 2,
      };
      if (change === "worktree") {
        replacement.worktree!.id = "worktree-two";
      } else if (change === "branch") {
        replacement.worktree!.branch = "feature/two";
      } else {
        replacement.repositoryWorkspaceId = "repository-two";
      }
      fixture.sessionEvent(replacement);
      expect(binding.matches(original)).toBe(false);
      const count = fixture.request.mock.calls.length;
      pending.onRefresh();
      expect(fixture.request).toHaveBeenCalledTimes(count);
      expect((await publicationSettled(fixture.attach(replacement))).result).toBeNull();
    },
  );
});

it("keeps a repository publication when non-owning worktree metadata changes", async () => {
  const fixture = publicationHarness();
  const original = {
    ...fixture.row("publication"),
    repositoryWorkspaceId: "repository-owner",
    worktree: { id: "incidental-worktree", branch: "feature/one", repoRoot: "/workspace/demo" },
  };
  const binding = fixture.attach(original);
  expect((await publishAndSettle(binding)).locked).toBe(true);
  const replacement = {
    ...original,
    worktree: { ...original.worktree, branch: "feature/two" },
    updatedAt: 2,
  };
  fixture.sessionEvent(replacement);
  expect(binding.matches(original)).toBe(true);
  expect(binding.view()?.locked).toBe(true);
});
