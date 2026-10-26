import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { interrupted as personalReview } from "../../pages/chat/chat-github-publication.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  GitHubPublicationOwner,
  type GitHubPublicationOptions,
} from "./github-publication-owner.ts";
import { sessionRequest } from "./hydration-family.test-support.ts";
import {
  createGatewayHarness as baseGateway,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { GitHubPublicationBinding, SessionGateway } from "./session-capability.ts";
import { sessionRetryDelayMs } from "./session-retry.ts";

function createGatewayHarness(client: GatewayBrowserClient) {
  const harness = baseGateway(client);
  return {
    ...harness,
    update(this: void, next: Partial<SessionGateway["snapshot"]>) {
      Object.assign(harness.gateway.snapshot, next);
      harness.publish(harness.gateway.snapshot.phase === "connected");
    },
    sessionEvent(this: void, session: GatewaySessionRow, reason = "patch", agentId = "main") {
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { agentId, reason, session },
      });
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

    const replacement = {} as GatewayBrowserClient;
    for (const connected of [true, false]) {
      const before = listener.mock.calls.length;
      harness.publish(connected, replacement);
      expect(sessions.pullRequestSummary("agent:main:pr-session")).toBeUndefined();
      expect(listener.mock.calls.length).toBeGreaterThan(before);
      if (connected) {
        sessions.setPullRequestSummary("agent:main:pr-session", summary);
      }
    }
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
    const request = sessionRequest({
      "sessions.delete": () => ({ ok: true, deleted: true }),
      "sessions.list": () => sessionsResult([], 2),
    });
    const sessions = createTestSessionCapability(
      createGatewayHarness(createTestGatewayClient(request)).gateway,
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
  const request = sessionRequest(replies);
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
    const binding = sessions.githubPublication.attach(session, GitHubPublicationOwner)!;
    binding.subscribe(() => {
      const previous = changed;
      changed = createDeferred();
      previous.resolve();
    });
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
    void view.onPublish?.();
    return { binding, view, response, original: request.mock.calls.at(-1) };
  };
  const globalHello = () => {
    const hello = gatewayHelloForMethods(["sessions.github.publish"]);
    hello.snapshot = {
      sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: "global" },
    };
    harness.update({ hello });
  };
  return {
    ...harness,
    publish: (...args: Parameters<typeof harness.publish>) => harness.publish(...args),
    request,
    sessions,
    row,
    attach,
    ready,
    pending,
    globalHello,
  };
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
  void (await publicationSettled(binding)).onPublish?.();
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

  it("keeps late personal options on their global owner when another owner attaches", async () => {
    const { attach, request, ready, globalHello } = publicationHarness();
    globalHello();
    const research = await ready(globalRow("research", "research-parent"));
    const old = createDeferred<GitHubPublicationOptions>();
    request.mockImplementationOnce(() => old.promise);
    void research.view()!.onRefresh();
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
    old.resolve({ ...sharedOptions, pendingPersonal: personalReview });
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
      const { binding, view, response, original } = await pending(session);
      const deletion = createDeferred<{ deleted: boolean }>();
      request.mockImplementationOnce(() => deletion.promise);
      const removal = sessions.delete(session.key, { expectedSessionId: session.sessionId });
      const settled =
        outcome === "rejected"
          ? expect(removal).rejects.toEqual(new Error("Deletion failed"))
          : expect(removal).resolves.toEqual({ deleted: outcome === "confirmed" });
      expect(sessions.deletionState(session.key)).toBe("pending");
      response.reject(new Error("Publication response lost"));
      // Let the publication response settle while the independent deletion is still pending.
      await nextTurn();
      expect(binding.view()).toBeUndefined();
      void view.onPublish?.();
      void view.onRefresh();
      expect(publicationCalls(request)).toEqual([original]);
      binding.detach();

      if (outcome === "rejected") {
        deletion.reject(new Error("Deletion failed"));
      } else {
        deletion.resolve({ deleted: outcome === "confirmed" });
      }
      await settled;
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
    void second.view()?.onRefresh();
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

  it.each(["unknown", "published", "replacement"] as const)(
    "retains an operation through presentation replacement: %s",
    async (outcome) => {
      const { attach, request, sessions, pending } = publicationHarness();
      const { binding: first, view: ready, response, original } = await pending();
      let returned: GitHubPublicationBinding | undefined;
      if (outcome === "replacement") {
        response.reject(new Error("Response lost"));
        await publicationSettled(first);
        returned = attach();
      }
      first.detach();
      void ready.onPublish?.();
      void ready.onRefresh();
      ready.onSelect?.("personal");
      expect(request).toHaveBeenCalledTimes(2);
      // An empty filtered roster cannot retire an admitted operation.
      await sessions.list();
      if (outcome === "unknown") {
        response.reject(new Error("Response lost"));
      } else if (outcome === "published") {
        response.resolve(publishedResult);
      }
      returned ??= attach();
      const view = await publicationSettled(returned);
      if (outcome !== "published") {
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
    void full.view()?.onPublish?.();
    expect((await publicationSettled(full)).error).toContain("publications are awaiting review");
    void terminal.onNewAction?.();
    await publicationSettled(retained);
    void full.view()?.onPublish?.();
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
      void ready.onPublish?.();
      void ready.onRefresh();
      const returned = attach(session);
      if (change === "delete") {
        expect(returned.view()).toBeUndefined();
      } else {
        expect((await publicationSettled(returned)).result).toBeNull();
      }
      expect(publicationCalls(request)).toHaveLength(1);
    },
  );
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

  it.each(["worktree", "branch", "repository", "incidental branch"] as const)(
    "preserves publication custody only when the changed %s is not its owner",
    async (change) => {
      const fixture = publicationHarness();
      const incidental = change === "incidental branch";
      const original = fixture.row("publication");
      if (change === "repository" || incidental) {
        original.repositoryWorkspaceId = "repository-one";
      }
      if (change !== "repository") {
        original.worktree = {
          id: "worktree-one",
          branch: "feature/one",
          repoRoot: "/workspace/demo",
        };
      }
      const binding = await fixture.ready(original);
      if (!incidental) {
        fixture.request.mockResolvedValueOnce(acceptedResult);
      }
      const pending = await publishAndSettle(binding);
      if (incidental) {
        expect(pending.locked).toBe(true);
      }
      const replacement = structuredClone(original);
      replacement.updatedAt = 2;
      if (change === "worktree") {
        replacement.worktree!.id = "worktree-two";
      } else if (change === "repository") {
        replacement.repositoryWorkspaceId = "repository-two";
      } else {
        replacement.worktree!.branch = "feature/two";
      }
      fixture.sessionEvent(replacement);
      expect(binding.matches(original)).toBe(incidental);
      if (incidental) {
        expect(binding.view()?.locked).toBe(true);
      } else {
        const count = fixture.request.mock.calls.length;
        void pending.onRefresh();
        expect(fixture.request).toHaveBeenCalledTimes(count);
        expect((await publicationSettled(fixture.attach(replacement))).result).toBeNull();
      }
    },
  );
});
