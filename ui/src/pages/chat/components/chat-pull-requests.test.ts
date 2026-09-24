/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestCheckDetails,
} from "../../../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-controller.ts";
import type { ChatCiDetailsElement } from "./chat-ci-details.ts";
import {
  chatPullRequestId,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
  renderChatPullRequests,
} from "./chat-pull-requests.ts";

function publication(overrides: Partial<GitHubPublicationView> = {}): GitHubPublicationView {
  return {
    activity: null,
    canWrite: true,
    locked: false,
    options: null,
    selection: {
      source: "shared",
      expected: { source: "system-configured", accountId: 1, login: "system-bot" },
    },
    result: null,
    confirmation: null,
    error: null,
    personalReady: true,
    onPublish: () => {},
    onRefresh: () => {},
    ...overrides,
  };
}

function pullRequest(
  overrides: Partial<ControlUiSessionPullRequest> = {},
): ControlUiSessionPullRequest {
  return {
    number: 103469,
    owner: "openclaw",
    repo: "openclaw",
    branch: "claude/browser-tabs-tighter-header",
    title: "fix(macos): tighten the link-browser tab header",
    url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    additions: 4,
    deletions: 3,
    checks: { state: "passing", passed: 5, failed: 0, skipped: 1, running: 0 },
    checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
    ...overrides,
  };
}

function sessionBranch(overrides: Partial<ControlUiSessionBranch> = {}): ControlUiSessionBranch {
  return {
    owner: "openclaw",
    repo: "openclaw",
    branch: "claude/cloud-workers-live-events",
    additions: 2819,
    deletions: 205,
    createUrl: "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
    ...overrides,
  };
}

describe("renderChatPullRequests", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("does not call account discovery Publishing before any publication is admitted", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        status: "ready",
        onDismiss: () => {},
        publication: publication({ activity: "read", selection: null }),
      }),
      container,
    );
    expect(container.textContent).not.toContain("Publishing");
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(true);
  });

  it.each(["open", "draft", "closed", "merged"] as const)(
    "marks retained %s PR status unavailable without pretending it is rate limited",
    (state) => {
      render(
        renderChatPullRequests({
          pullRequests: [pullRequest({ state })],
          status: "unavailable",
          onDismiss: () => {},
        }),
        container,
      );
      const warning = container.querySelector(".chat-pr__warning");
      expect(warning?.getAttribute("aria-label")).toContain("could not be refreshed");
      expect(warning?.getAttribute("aria-label")).not.toContain("rate limit");
      expect(container.querySelector(".chat-pr__number")?.textContent).toBe("#103469");
    },
  );

  it("renders nothing without pull requests", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        status: "ready",
        onDismiss: () => {},
      }),
      container,
    );
    expect(container.querySelector(".chat-prs")).toBeNull();
  });

  it("renders an open PR chip with diff counts and CI state", () => {
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        status: "ready",
        onDismiss: () => {},
      }),
      container,
    );
    const chip = container.querySelector(".chat-pr");
    expect(chip?.getAttribute("data-state")).toBe("open");
    expect(chip?.querySelector(".chat-pr__number")?.textContent).toBe("#103469");
    expect(chip?.querySelector(".chat-pr__repo")?.textContent).toBe("openclaw");
    expect(chip?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/browser-tabs-tighter-header",
    );
    expect(chip?.querySelector(".chat-pr__additions")?.textContent).toBe("+4");
    expect(chip?.querySelector(".chat-pr__deletions")?.textContent).toBe("−3");
    const checks = chip?.querySelector<HTMLDetailsElement>(".chat-pr__checks");
    expect(checks?.getAttribute("data-checks")).toBe("passing");
    expect(chip?.querySelector(".chat-pr__link")?.getAttribute("href")).toBe(
      "https://github.com/openclaw/openclaw/pull/103469",
    );
    expect(chip?.querySelector(".chat-pr__warning")).toBeNull();
    expect(chip?.querySelector(".chat-pr__state")).toBeNull();
  });

  it("shows per-state check counts and a checks link in the CI popover", () => {
    render(
      renderChatPullRequests({
        pullRequests: [
          pullRequest({
            checks: { state: "failing", passed: 65, failed: 2, skipped: 31, running: 0 },
          }),
        ],
        status: "ready",
        onDismiss: () => {},
      }),
      container,
    );
    const menu = container.querySelector(".chat-pr__checks-menu");
    const rowText = (modifier: string) =>
      menu?.querySelector(`.chat-pr__checks-row--${modifier}`)?.textContent?.replace(/\s+/g, " ");
    expect(rowText("passed")).toContain("Passed");
    expect(rowText("passed")).toContain("65");
    expect(rowText("failed")).toContain("2");
    expect(rowText("skipped")).toContain("31");
    // Zero-count states stay out of the popover.
    expect(menu?.querySelector(".chat-pr__checks-row--running")).toBeNull();
    expect(menu?.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://github.com/openclaw/openclaw/pull/103469/checks",
    );
    expect(container.querySelector(".chat-pr__checks")?.getAttribute("data-checks")).toBe(
      "failing",
    );
  });

  it("keeps live PRs ahead of settled history", () => {
    render(
      renderChatPullRequests({
        pullRequests: [
          pullRequest({ number: 1, state: "merged", checks: undefined }),
          pullRequest({ number: 2, state: "closed", checks: undefined }),
          pullRequest({ number: 3, state: "open" }),
        ],
        status: "ready",
        onDismiss: () => {},
      }),
      container,
    );
    expect(
      [...container.querySelectorAll(".chat-pr__number")].map((node) => node.textContent),
    ).toEqual(["#3", "#1", "#2"]);
  });

  it.each([null, "read"] as const)(
    "renders merged PRs without a redundant card while publication activity is %s",
    (activity) => {
      const onDismiss = vi.fn();
      const onNewAction = vi.fn();
      render(
        renderChatPullRequests({
          pullRequests: [
            pullRequest({
              state: "merged",
              additions: undefined,
              deletions: undefined,
              checks: undefined,
              checksUrl: undefined,
            }),
          ],
          status: "rate-limited",
          onDismiss,
          publication: publication({
            activity,
            result: {
              requestId: "publication-merged",
              status: "published",
              url: pullRequest().url,
              repository: "openclaw/openclaw",
              branch: pullRequest().branch,
              headCommit: "a".repeat(40),
              publisher: { source: "agent-override", accountId: 3, login: "agent-bot" },
            },
            onNewAction,
          }),
        }),
        container,
      );
      const chip = container.querySelector(".chat-pr");
      expect(chip?.getAttribute("data-state")).toBe("merged");
      expect(chip?.querySelector(".chat-pr__state")?.textContent?.trim()).toBe("Merged");
      expect(chip?.querySelector(".chat-pr__diff")).toBeNull();
      expect(chip?.querySelector(".chat-pr__checks")).toBeNull();
      // Merged is terminal, so the stale-data warning stays off merged chips.
      expect(chip?.querySelector(".chat-pr__warning")).toBeNull();
      expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
      expect(container.textContent).not.toContain("Choose a new publication");
      expect(container.textContent).not.toContain("Publish as");
      const dismiss = chip?.querySelector<HTMLButtonElement>(".chat-pr__dismiss");
      expect(dismiss?.disabled).toBe(activity !== null);
      dismiss?.click();
      expect(onNewAction).toHaveBeenCalledTimes(activity === null ? 1 : 0);
      expect(onDismiss).toHaveBeenCalledTimes(activity === null ? 1 : 0);
    },
  );

  it.each([sessionBranch().branch, pullRequest().branch])(
    "shows unpublished changes on %s instead of merged PR history",
    (branch) => {
      render(
        renderChatPullRequests({
          pullRequests: [pullRequest({ state: "merged" })],
          branch: sessionBranch({ branch }),
          status: "ready",
          onDismiss: () => {},
          publication: publication(),
        }),
        container,
      );
      expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
      expect(container.querySelector(".chat-pr__number")).toBeNull();
      expect(container.querySelector(".chat-pr__branch")?.textContent).toBe(branch);
      expect(container.querySelector(".chat-pr__create")?.textContent).toContain("Publish PR");
    },
  );

  it("keeps the current PR and CI visible when an older receipt falls out of the PR snapshot", () => {
    const onNewAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        status: "ready",
        onDismiss,
        publication: publication({
          result: {
            requestId: "old-publication",
            status: "published",
            url: "https://github.com/openclaw/openclaw/pull/1",
            repository: "openclaw/openclaw",
            branch: pullRequest().branch,
            headCommit: "a".repeat(40),
          },
          onNewAction,
        }),
      }),
      container,
    );
    expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
    expect(container.querySelector(".chat-pr__number")?.textContent).toBe("#103469");
    expect(container.querySelector(".chat-pr__checks")).not.toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.click();
    expect(onNewAction).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps publication recovery inside the PR row after publication completed: %s",
    (completed) => {
      const onPublish = vi.fn();
      const onRefresh = vi.fn();
      render(
        renderChatPullRequests({
          pullRequests: [pullRequest()],
          status: "ready",
          onDismiss: () => {},
          publication: publication({
            locked: !completed,
            error: "Response lost.",
            onPublish,
            onRefresh,
            result: completed
              ? {
                  requestId: "published-with-refresh-error",
                  status: "published",
                  url: pullRequest().url,
                  repository: "openclaw/openclaw",
                  branch: pullRequest().branch,
                  headCommit: "a".repeat(40),
                }
              : null,
          }),
        }),
        container,
      );
      expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
      expect(container.textContent).toContain("#103469");
      expect(container.textContent).toContain("Response lost.");
      const action = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.textContent?.trim() === (completed ? "Refresh publication" : "Retry publication"),
      );
      expect(action).toBeDefined();
      action?.click();
      expect(completed ? onRefresh : onPublish).toHaveBeenCalledOnce();
      expect(container.querySelectorAll(".chat-pr__dismiss")).toHaveLength(1);
    },
  );

  it("marks open chips stale when GitHub is rate limited", () => {
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        status: "rate-limited",
        onDismiss: () => {},
      }),
      container,
    );
    expect(container.querySelector(".chat-pr__warning")).not.toBeNull();
  });

  it("renders a Publish PR branch row with locale-formatted diff stats", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        status: "ready",
        onDismiss: () => {},
        publication: publication(),
      }),
      container,
    );
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__repo")?.textContent).toBe("openclaw");
    expect(row?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/cloud-workers-live-events",
    );
    // Thousands separators match GitHub's diff-stat rendering.
    expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe(
      `+${(2819).toLocaleString()}`,
    );
    expect(row?.querySelector(".chat-pr__deletions")?.textContent).toBe(
      `−${(205).toLocaleString()}`,
    );
    const create = row?.querySelector<HTMLButtonElement>(".chat-pr__create");
    expect(create?.textContent?.trim()).toBe("Publish PR");
    expect(row?.querySelector(".chat-pr__warning")).toBeNull();
    // The branch row is not dismissible; it reflects the checkout itself.
    expect(row?.querySelector(".chat-pr__dismiss")).toBeNull();
    expect(row?.querySelector("button.chat-pr__diff")).toBeNull();
  });

  it("opens the session diff from interactive branch stats", () => {
    const onOpenSessionDiff = vi.fn();
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        status: "ready",
        onDismiss: () => {},
        onOpenSessionDiff,
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>("button.chat-pr__diff");
    expect(button?.getAttribute("aria-label")).toBe("Show session changes");
    button?.click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
  });

  it("hides the Create PR link while the branch has no createUrl", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        // Unpushed branch with local changed files: the gateway omits
        // createUrl because GitHub's pull/new page would 404.
        branch: sessionBranch({ createUrl: undefined, additions: 12, deletions: 3 }),
        status: "ready",
        onDismiss: () => {},
      }),
      container,
    );
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/cloud-workers-live-events",
    );
    expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe("+12");
    expect(row?.querySelector(".chat-pr__create")).toBeNull();
  });

  it("shows Gateway publication request and terminal URL states", () => {
    const onPublish = vi.fn();
    const props: Parameters<typeof renderChatPullRequests>[0] = {
      pullRequests: [],
      branch: sessionBranch(),
      status: "ready",
      onDismiss: () => {},
      publication: publication({ onPublish }),
    };
    render(renderChatPullRequests(props), container);
    const publish = container.querySelector<HTMLButtonElement>(".chat-pr__create");
    publish?.click();
    expect(onPublish).toHaveBeenCalledOnce();
    expect(publish?.textContent).toContain("Publish PR");

    render(
      renderChatPullRequests({
        ...props,
        publication: publication({
          result: {
            requestId: "publication-1",
            status: "published",
            url: "https://github.com/openclaw/openclaw/pull/125200",
            repository: "openclaw/openclaw",
            branch: "openclaw/ui-fix",
            headCommit: "a".repeat(40),
            publisher: { source: "personal", accountId: 2, login: "alice-tools" },
          },
        }),
      }),
      container,
    );
    expect(container.querySelector<HTMLAnchorElement>(".chat-pr__create")?.href).toBe(
      "https://github.com/openclaw/openclaw/pull/125200",
    );
    expect(container.querySelector(".chat-pr__branch")?.textContent).toBe(props.branch?.branch);
    expect(container.querySelector(".chat-pr__diff")).not.toBeNull();
    expect(container.querySelector(".chat-pr__publication-outcome")).toBeNull();

    render(
      renderChatPullRequests({
        ...props,
        publication: publication({
          result: {
            requestId: "publication-2",
            status: "failed",
            code: "push_rejected",
            message: "GitHub publication failed.",
            nextAction: "Check repository write access and retry.",
            publisher: { source: "agent-override", accountId: 3, login: "agent-bot" },
          },
          onNewAction: () => {},
        }),
      }),
      container,
    );
    const failure = container.querySelector('.chat-pr__publication-outcome[data-state="failed"]');
    expect(failure?.textContent).toContain("GitHub publication failed.");
    expect(failure?.textContent).toContain("Check repository write access and retry.");
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.textContent).toContain(
      "Choose a new publication",
    );
    expect(container.textContent).toContain("Publish as @agent-bot");
    expect(container.textContent).toContain("Agent override");
    expect(container.querySelector("a.chat-pr__create")).toBeNull();

    render(
      renderChatPullRequests({
        ...props,
        publication: publication({
          error: "Repository write permission is missing.",
          locked: true,
        }),
      }),
      container,
    );
    const retry = container.querySelector<HTMLButtonElement>(".chat-pr__create");
    expect(retry?.textContent).toContain("Retry publication");
    expect(container.textContent).toContain("Repository write permission is missing.");
    expect(container.textContent).toContain("The outcome is unknown");
    expect(container.querySelector("a.chat-pr__create")).toBeNull();
  });

  it.each(["system-configured", "agent-override"] as const)(
    "shows a sole %s publisher as information behind the publication arrow",
    (source) => {
      const shared = { source, accountId: 1, login: "system-bot" };
      const onSelect = vi.fn();
      render(
        renderChatPullRequests({
          pullRequests: [],
          branch: sessionBranch(),
          status: "ready",
          onDismiss: () => {},
          publication: publication({
            options: { shared, personal: null, pendingPersonal: null, latestShared: null },
            selection: { source: "shared", expected: shared },
            onSelect,
          }),
        }),
        container,
      );
      expect(container.querySelector("select")).toBeNull();
      expect(container.querySelector('button[aria-label="Publication account"]')).not.toBeNull();
      const popover = container.querySelector("wa-popover");
      expect(popover?.textContent).toContain("Publish as @system-bot");
      expect(container.querySelector(".chat-pr__publication-outcome")).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("keeps the shared cloud flow available and explains the personal workspace boundary", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        status: "ready",
        onDismiss: () => {},
        publication: publication({ personalReady: false }),
      }),
      container,
    );
    expect(container.querySelector<HTMLButtonElement>("button.chat-pr__create")?.disabled).toBe(
      false,
    );
    expect(container.textContent).toContain(
      "My GitHub requires an idle, reconciled local workspace",
    );
  });

  it("marks the branch row stale when GitHub is rate limited", () => {
    render(
      renderChatPullRequests({
        pullRequests: [],
        branch: sessionBranch(),
        status: "rate-limited",
        onDismiss: () => {},
        publication: publication(),
      }),
      container,
    );
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    // While rate limited, "no PR found" is unreliable; the warning says so.
    expect(row?.querySelector(".chat-pr__warning")).not.toBeNull();
    expect(row?.querySelector(".chat-pr__create")).not.toBeNull();
  });

  it("dismisses a chip through the X button", () => {
    const onDismiss = vi.fn();
    render(
      renderChatPullRequests({
        pullRequests: [pullRequest()],
        status: "ready",
        onDismiss,
      }),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledWith(pullRequest());
  });
});

describe("dismissed pull request storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists dismissals per session", () => {
    const chip = pullRequest();
    expect(listDismissedChatPullRequests("agent:main:main").has(chatPullRequestId(chip))).toBe(
      false,
    );

    const ids = dismissChatPullRequest("agent:main:main", chip);

    expect(ids.has(chatPullRequestId(chip))).toBe(true);
    expect(listDismissedChatPullRequests("agent:main:main").has(chatPullRequestId(chip))).toBe(
      true,
    );
    expect(listDismissedChatPullRequests("agent:main:other").size).toBe(0);
  });

  it("drops the oldest sessions once the store limit is reached", () => {
    const chip = pullRequest();
    for (let index = 0; index < 21; index += 1) {
      dismissChatPullRequest(`agent:main:${index}`, chip);
    }
    expect(listDismissedChatPullRequests("agent:main:0").size).toBe(0);
    expect(listDismissedChatPullRequests("agent:main:20").size).toBe(1);
  });

  it("ignores malformed stored payloads", () => {
    localStorage.setItem("openclaw.chat.dismissedPullRequests", "not json");
    expect(listDismissedChatPullRequests("agent:main:main").size).toBe(0);
  });
});

describe("CI job details", () => {
  let container: HTMLDivElement;
  const headSha = "a".repeat(40);
  const details = (
    overrides: Partial<ControlUiSessionPullRequestCheckDetails> = {},
  ): ControlUiSessionPullRequestCheckDetails => ({
    owner: "openclaw",
    repo: "openclaw",
    number: 103469,
    headSha,
    status: "ready",
    rateLimited: false,
    checks: [
      {
        id: 1,
        name: "Build",
        state: "passed",
        status: "completed",
        conclusion: "success",
        source: "actions",
      },
      { id: 2, name: "Tests", state: "running", status: "in_progress", source: "actions" },
      {
        id: 3,
        name: "Lint",
        state: "failed",
        status: "completed",
        conclusion: "failure",
        source: "actions",
        startedAt: "2026-09-14T00:00:00Z",
        completedAt: "2026-09-14T00:01:12Z",
        detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/10/job/30",
        steps: [
          { number: 3, name: "Lint sources", status: "completed", conclusion: "failure" },
          { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
          { number: 4, name: "Upload report", status: "completed", conclusion: "skipped" },
          { number: 2, name: "Install", status: "completed", conclusion: "success" },
        ],
      },
      {
        id: 4,
        name: "Deploy",
        state: "skipped",
        status: "completed",
        conclusion: "skipped",
        source: "actions",
      },
    ],
    ...overrides,
  });

  function harness() {
    const client = new GatewayBrowserClient({ url: "ws://localhost:12345" });
    const request = vi.spyOn(client, "request").mockResolvedValue(details());
    let snapshot: ApplicationGatewaySnapshot = {
      client,
      phase: "connected",
      offlineStable: false,
      hello: null,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    };
    const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
    const gateway: ApplicationGateway = {
      get snapshot() {
        return snapshot;
      },
      connection: {
        gatewayUrl: "ws://localhost:12345",
        token: "",
        bootstrapToken: "",
        password: "",
      },
      connectionRevision: 0,
      eventLog: [],
      eventLogRevision: 0,
      connect() {},
      setSessionKey() {},
      start() {},
      stop() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribeEvents: () => () => {},
      subscribeEventLog: () => () => {},
    };
    const props = {
      pullRequests: [pullRequest({ headSha })],
      gateway,
      sessionKey: "agent:main:main",
      status: "ready" as const,
      onDismiss() {},
    };
    render(renderChatPullRequests(props), container);
    const element = container.querySelector<ChatCiDetailsElement>("openclaw-chat-ci-details")!;
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    return {
      request,
      props,
      element,
      disclosure,
      disconnect() {
        snapshot = { ...snapshot, phase: "offline" };
        for (const listener of listeners) {
          listener(snapshot);
        }
      },
    };
  }

  async function settle(element: ChatCiDetailsElement) {
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:02:00Z"));
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches only while open, prioritizes live failures, and keeps manual job expansion across refresh", async () => {
    const h = harness();
    await settle(h.element);
    expect(h.request).not.toHaveBeenCalled();
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledWith(
      "controlUi.sessionPullRequests.checks",
      {
        sessionKey: "agent:main:main",
        owner: "openclaw",
        repo: "openclaw",
        number: 103469,
        headSha,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(
      [...container.querySelectorAll(".chat-ci__jobs > .chat-ci__job")].map((job) =>
        job.getAttribute("data-check-id"),
      ),
    ).toEqual(["3", "2", "1"]);
    const failed = container.querySelector<HTMLDetailsElement>('.chat-ci__job[data-check-id="3"]')!;
    expect(failed.open).toBe(true);
    expect(failed.querySelector(".chat-ci__duration")?.textContent).toBe("1m 12s");
    expect(
      [...failed.querySelectorAll(".chat-ci__step .chat-ci__name")].map((step) => step.textContent),
    ).toEqual(["Set up job", "Install", "Lint sources", "Upload report"]);
    expect(
      container.querySelector<HTMLDetailsElement>('.chat-ci__job[data-check-id="1"]')?.open,
    ).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>(".chat-ci__skipped")?.open).toBe(false);
    failed.open = false;
    await settle(h.element);
    const requestsBeforeRefresh = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(h.request).toHaveBeenCalledTimes(requestsBeforeRefresh + 1);
    expect(failed.open).toBe(false);
    h.disclosure.open = false;
    await settle(h.element);
    const closedCount = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(closedCount);
  });

  it("refreshes completed CI so same-head reruns replace cached terminal results", async () => {
    const h = harness();
    const completed = details({
      checks: [
        {
          id: 1,
          name: "Build",
          state: "passed",
          status: "completed",
          conclusion: "success",
          source: "actions",
        },
      ],
    });
    const rerun = details({
      checks: [
        { id: 5, name: "Build rerun", state: "running", status: "in_progress", source: "actions" },
      ],
    });
    h.request
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed)
      .mockResolvedValue(rerun);
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(1);
    render(
      renderChatPullRequests({
        ...h.props,
        pullRequests: [
          pullRequest({
            headSha,
            checks: { state: "pending", passed: 0, failed: 0, skipped: 0, running: 1 },
          }),
        ],
      }),
      container,
    );
    await settle(h.element);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(h.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(container.querySelector('.chat-ci__job[data-check-id="5"]')?.textContent).toContain(
      "Build rerun",
    );
    expect(container.querySelector('.chat-ci__job[data-check-id="1"]')).toBeNull();
  });

  it("aborts a closed monitor and ignores its late response", async () => {
    const h = harness();
    const pending = createDeferred<ControlUiSessionPullRequestCheckDetails>();
    h.request.mockReturnValue(pending.promise);
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(container.textContent).toContain("Loading jobs and steps");
    const signal = h.request.mock.calls[0]?.[2]?.signal;
    h.disclosure.open = false;
    await settle(h.element);
    expect(signal?.aborted).toBe(true);
    pending.resolve(details());
    await settle(h.element);
    expect(container.querySelector(".chat-ci__job")).toBeNull();
  });

  it("retires pending requests without leaking jobs into a changed session", async () => {
    const h = harness();
    const pending = createDeferred<ControlUiSessionPullRequestCheckDetails>();
    h.request.mockReturnValueOnce(pending.promise);
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    render(renderChatPullRequests({ ...h.props, sessionKey: "agent:other:main" }), container);
    await settle(h.element);
    pending.resolve(details());
    await settle(h.element);
    expect(h.disclosure.open).toBe(false);
    expect(container.querySelector(".chat-ci__job")).toBeNull();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["GitHub identity changed", "GitHub identity changed"],
    [
      "GitHub API rate limit exceeded (HTTP 403). Wait 2382 seconds and retry.",
      "GitHub API rate limit exceeded (HTTP 403). Wait 2382 seconds and retry.",
    ],
    ["GitHub request failed: token=synthetic-secret", "GitHub request failed: token=[redacted]"],
  ])("clears prior details and preserves the safe RPC error: %s", async (message, expected) => {
    const h = harness();
    h.request.mockResolvedValueOnce(
      details({
        checks: [
          { id: 9, name: "Private build", state: "passed", status: "completed", source: "actions" },
        ],
      }),
    );
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(container.textContent).toContain("Private build");
    h.request.mockRejectedValue(new Error(message));
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(container.querySelector(".chat-ci__job")).toBeNull();
    expect(container.textContent).not.toContain("Private build");
    expect(container.querySelector('.chat-ci__notice[data-state="unavailable"]')).not.toBeNull();
    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain("synthetic-secret");
    h.request.mockResolvedValue(details());
    container.querySelector<HTMLButtonElement>(".chat-ci__retry")?.click();
    await settle(h.element);
    expect(container.querySelector(".chat-ci__notice")).toBeNull();
    expect(container.querySelector(".chat-ci__job")).not.toBeNull();
  });

  it("clears details when the connection retires", async () => {
    const h = harness();
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(container.querySelector(".chat-ci__job")).not.toBeNull();
    h.disconnect();
    await settle(h.element);
    expect(container.querySelector(".chat-ci__job")).toBeNull();
    expect(container.textContent).toContain("Couldn’t load all CI details");
  });

  it("shows inline rate-limit recovery without retrying before the server delay", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(
      details({ checks: [], status: "unavailable", rateLimited: true, retryAfterMs: 30_000 }),
    );
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    const retry = container.querySelector<HTMLButtonElement>(".chat-ci__retry")!;
    expect(container.textContent).toContain("rate limit");
    expect(retry.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(retry.disabled).toBe(false);
    retry.click();
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-ci__job")).not.toBeNull();
  });

  it("represents non-Actions checks without invented steps or unsafe links", async () => {
    const h = harness();
    h.request.mockResolvedValue(
      details({
        checks: [
          {
            id: 5,
            name: "External audit",
            state: "passed",
            status: "completed",
            source: "check",
            detailsUrl: "javascript:alert(1)",
          },
        ],
      }),
    );
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
    expect(container.textContent).toContain("External audit");
    expect(container.textContent).toContain("does not provide GitHub Actions steps");
    expect(container.querySelector(".chat-ci__step")).toBeNull();
    expect(container.querySelector(".chat-ci__job-link")).toBeNull();
    h.request.mockResolvedValue(
      details({
        checks: [
          {
            id: 5,
            name: "External audit",
            state: "passed",
            status: "completed",
            source: "check",
            detailsUrl: "https://ci.example.test/build/5",
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
    const link = container.querySelector<HTMLAnchorElement>(".chat-ci__job-link");
    expect(link?.href).toBe("https://ci.example.test/build/5");
    expect(link?.textContent).toContain("Open check details");
  });
});
