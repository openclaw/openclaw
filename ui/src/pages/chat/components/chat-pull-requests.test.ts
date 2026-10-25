/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequestCheckDetails } from "../../../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { confirmation } from "../chat-github-publication.test-support.ts";
import type { ChatCiDetailsElement } from "./chat-ci-details.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import {
  paintChatPullRequests,
  clearChatPullRequests,
  publication,
  pullRequest,
  sessionBranch,
} from "./chat-pull-requests.test-support.ts";
import {
  chatBranchId,
  chatPullRequestId,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
} from "./chat-pull-requests.ts";

let container: HTMLDivElement;

const query = (selector: string): HTMLElement | null => container.querySelector(selector);
const text = (selector: string) => query(selector)?.textContent;
const click = (selector: string) => container.querySelector<HTMLButtonElement>(selector)?.click();

function paint(props: Partial<ChatPullRequestsProps>) {
  paintChatPullRequests(
    {
      pullRequests: [],
      status: "ready",
      onDismiss: () => {},
      ...props,
    },
    container,
  );
}

function published(requestId: string, url = pullRequest().url) {
  return {
    requestId,
    status: "published" as const,
    url,
    repository: "openclaw/openclaw",
    branch: pullRequest().branch,
    headCommit: "a".repeat(40),
  };
}

function failedResult(nextAction: string) {
  return {
    requestId: "failed-session-attempt",
    status: "failed" as const,
    code: "unavailable" as const,
    message: "GitHub publication failed.",
    nextAction,
    publisher: { source: "agent-override" as const, accountId: 3, login: "agent-bot" },
  };
}

function setupContainer() {
  container = document.createElement("div");
  document.body.append(container);
}

function disposeContainer() {
  clearChatPullRequests(container);
  container.remove();
}

describe("ChatPullRequests", () => {
  beforeEach(setupContainer);
  afterEach(disposeContainer);
  it("keeps unknown diff counts absent rather than inventing zeroes", () => {
    paint({ pullRequests: [pullRequest({ additions: undefined, deletions: 0 })] });
    expect(query(".chat-pr__additions")).toBeNull();
    expect(text(".chat-pr__deletions")).toBe("−0");
  });

  it("marks retained merged PR status unavailable without pretending it is rate limited", () => {
    paint({
      pullRequests: [pullRequest({ state: "merged" })],
      status: "unavailable",
      onDismiss: () => {},
    });
    const warning = query(".chat-pr__warning");
    expect(warning?.getAttribute("aria-label")).toContain("could not be refreshed");
    expect(warning?.getAttribute("aria-label")).not.toContain("rate limit");
    expect(text(".chat-pr__number")).toBe("openclaw/openclaw#103469");
  });

  it.each(["merged", "older receipt", "recovery"] as const)(
    "keeps the current PR distinct from its %s publication receipt",
    (kind) => {
      const onDismiss = vi.fn();
      const onNewAction = vi.fn();
      const onRefresh = vi.fn();
      paint({
        pullRequests: [
          pullRequest(
            kind === "merged"
              ? {
                  state: "merged",
                  additions: undefined,
                  deletions: undefined,
                  checks: undefined,
                  checksUrl: undefined,
                }
              : {},
          ),
        ],
        status: kind === "merged" ? "rate-limited" : "ready",
        onDismiss,
        publication: publication({
          result: published(
            "receipt",
            kind === "older receipt" ? "https://github.com/openclaw/openclaw/pull/1" : undefined,
          ),
          error: kind === "recovery" ? "Response lost." : null,
          onNewAction,
          onRefresh,
        }),
      });
      expect(container.querySelectorAll(".chat-pr")).toHaveLength(1);
      expect(text(".chat-pr__number")).toBe("openclaw/openclaw#103469");
      if (kind === "merged") {
        expect(query(".chat-pr")?.getAttribute("data-state")).toBe("merged");
        expect(query("openclaw-chat-ci-automation")).not.toBeNull();
        expect(query(".chat-pr__diff, openclaw-chat-ci-details, .chat-pr__warning")).toBeNull();
        expect(query(".chat-pr__publication-outcome, .chat-pr__create")).toBeNull();
        expect(container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")?.disabled).toBe(
          false,
        );
      } else if (kind === "older receipt") {
        expect(query(".chat-pr__checks")).not.toBeNull();
      } else {
        expect(container.textContent).toContain("Response lost.");
        const recovery = query(".chat-pr__publication-outcome");
        expect(recovery?.closest("article, details:not([open])")).toBeNull();
        expect(query(".chat-pr__create")).toBeNull();
        expect(query('button[aria-label="Refresh publication"]')).not.toBeNull();
        click('button[aria-label="Refresh publication"]');
        expect(onRefresh).toHaveBeenCalledOnce();
        expect(container.querySelectorAll(".chat-pr__dismiss")).toHaveLength(1);
        return;
      }
      click(".chat-pr__dismiss");
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(onNewAction).toHaveBeenCalledTimes(kind === "merged" ? 1 : 0);
    },
  );

  it("does not attach a failed session publication to any PR when live and settled rows reorder", () => {
    const failedPublication = publication({
      result: failedResult("Check repository read access before retrying publication."),
      onNewAction: vi.fn(),
    });
    const merged = pullRequest({ state: "merged" });
    const unrelated = pullRequest({
      number: 42,
      owner: "synthetic",
      repo: "another-project",
      branch: "feature/unrelated",
      url: "https://github.com/synthetic/another-project/pull/42",
    });
    for (const state of ["open", "merged"] as const) {
      paint({ pullRequests: [merged, { ...unrelated, state }], publication: failedPublication });
      const rows = [...container.querySelectorAll("article.chat-pr")];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.textContent).not.toContain("Check repository read access");
        expect(row.querySelector("[data-publication-account], .chat-pr__create")).toBeNull();
      }
      const history = container.querySelector<HTMLDetailsElement>(
        "details.chat-pr__publication-history",
      );
      expect(history?.closest("article")).toBeNull();
      expect(history?.querySelector("summary")?.textContent?.trim()).toBe(
        "Publication attempt failed",
      );
      expect(history?.open).toBe(false);
      expect(history?.textContent).toContain("Check repository read access before retrying");
    }
  });

  it.each(["requested", "publishing", "needs_confirmation"] as const)(
    "keeps %s publication recovery exposed beside merged history",
    (status) => {
      const onRefresh = vi.fn();
      const onConfirm = vi.fn();
      paint({
        pullRequests: [pullRequest({ state: "merged" })],
        publication: publication({
          locked: true,
          result: {
            requestId: "active-publication",
            status,
            message: "The original publication still needs attention.",
            publisher: { source: "personal", accountId: 2, login: "alice-tools" },
          },
          confirmation: status === "needs_confirmation" ? confirmation : null,
          onRefresh,
          onConfirm: status === "needs_confirmation" ? onConfirm : undefined,
        }),
      });
      const outcome = query(".chat-pr__publication-outcome");
      expect(outcome?.textContent).toContain("The original publication still needs attention.");
      expect(outcome?.closest("details:not([open])")).toBeNull();
      expect(query(".chat-pr__publication-history")).toBeNull();
      const action = container.querySelector<HTMLButtonElement>(".chat-pr__create");
      expect(action?.disabled).toBe(false);
      action?.click();
      expect(status === "needs_confirmation" ? onConfirm : onRefresh).toHaveBeenCalledOnce();
    },
  );

  it("marks open chips stale when GitHub is rate limited", () => {
    paint({
      pullRequests: [pullRequest()],
      status: "rate-limited",
    });
    expect(query(".chat-pr__warning")).not.toBeNull();
  });

  it.each([
    { locale: "en", label: "Create PR" },
    { locale: "fr", label: "Créer une demande de fusion" },
  ] as const)(
    "names the Create PR link with its visible text and branch in $locale",
    async ({ locale, label }) => {
      const restoreI18n = captureI18nStateForTesting();
      const branch = sessionBranch();
      try {
        await i18n.setLocale(locale);
        paint({ pullRequests: [], branch });
        const link = container.querySelector<HTMLAnchorElement>("a.chat-pr__create");
        expect(link?.textContent).toBe(label);
        expect(link?.getAttribute("aria-label")).toContain(label);
        expect(link?.getAttribute("aria-label")).toContain(branch.branch);
      } finally {
        await restoreI18n();
      }
    },
  );

  it("hides the Create PR link while the branch has no createUrl", () => {
    paint({
      pullRequests: [],
      // Unpushed branch with local changed files: the gateway omits
      // createUrl because GitHub's pull/new page would 404.
      branch: sessionBranch({ createUrl: undefined, additions: 12, deletions: 3 }),
    });
    const row = query('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__branch")?.textContent).toBe(
      "claude/cloud-workers-live-events",
    );
    expect(row?.querySelector(".chat-pr__additions")?.textContent).toBe("+12");
    expect(row?.querySelector(".chat-pr__create")).toBeNull();
  });

  it("keeps publication success, failure, and uncertain recovery on the branch row", () => {
    const branch = sessionBranch();
    const draw = (patch: Parameters<typeof publication>[0]) =>
      paint({ branch, publication: publication(patch) });
    draw({
      result: {
        ...published("publication-1", "https://github.com/openclaw/openclaw/pull/125200"),
        branch: "openclaw/ui-fix",
        publisher: { source: "personal", accountId: 2, login: "alice-tools" },
      },
    });
    expect(container.querySelector<HTMLAnchorElement>(".chat-pr__create")?.href).toBe(
      "https://github.com/openclaw/openclaw/pull/125200",
    );
    expect(text(".chat-pr__branch")).toBe(branch.branch);
    expect(query(".chat-pr__diff")).not.toBeNull();
    expect(query(".chat-pr__publication-outcome")).toBeNull();

    draw({
      result: {
        ...failedResult("Check repository write access and retry."),
        code: "push_rejected",
      },
      onNewAction: () => {},
    });
    const failure = query('.chat-pr__publication-outcome[data-state="failed"]');
    expect(failure?.textContent).toContain("Check repository write access and retry.");
    expect(failure?.closest("details:not([open])")).toBeNull();
    const status = failure?.querySelector<HTMLDetailsElement>(
      "details.chat-pr__publication-status",
    );
    expect(status?.open).toBe(false);
    expect(status?.querySelector("summary")?.textContent?.trim()).toBe("Publication failed");
    expect(failure?.closest("article")?.getAttribute("data-state")).toBe("branch");
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.textContent).toContain(
      "Choose a new publication",
    );
    expect(query("a.chat-pr__create")).toBeNull();

    draw({
      error: "Repository write permission is missing.",
      locked: true,
    });
    const retry = container.querySelector<HTMLButtonElement>(".chat-pr__create");
    expect(retry?.textContent).toContain("Retry publication");
    expect(container.textContent).toContain("Repository write permission is missing.");
    expect(container.textContent).toContain("The outcome is unknown");
    expect(query("a.chat-pr__create")).toBeNull();
  });
});

describe("branch row dismissal", () => {
  beforeEach(setupContainer);
  afterEach(disposeContainer);
  it("hides the branch row and its idle publish offer once dismissed", () => {
    const onDismissBranch = vi.fn();
    const props = {
      branch: sessionBranch(),
      onDismissBranch,
      publication: publication({
        canPublishPersonal: false,
        options: {
          shared: { source: "system-configured", accountId: 1, login: "system-bot" },
          personal: null,
          pendingPersonal: null,
          latestShared: null,
        },
      }),
    };
    paint(props);
    click(".chat-pr__dismiss");
    expect(onDismissBranch).toHaveBeenCalledWith(sessionBranch());

    paint({ ...props, branchDismissed: true });
    expect(query(".chat-pr")).toBeNull();
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

  it("drops the oldest sessions once the store limit is reached", () => {
    const chip = pullRequest();
    for (let index = 0; index < 21; index += 1) {
      dismissChatPullRequest(`agent:main:${index}`, chatPullRequestId(chip));
    }
    expect(listDismissedChatPullRequests("agent:main:0").size).toBe(0);
    expect(listDismissedChatPullRequests("agent:main:20").size).toBe(1);
  });

  it("keeps branches that differ only in case distinct", () => {
    const ids = dismissChatPullRequest(
      "agent:main:main",
      chatBranchId(sessionBranch({ owner: "OpenClaw", branch: "Feature" })),
    );

    expect(ids.has(chatBranchId(sessionBranch({ owner: "openclaw", branch: "Feature" })))).toBe(
      true,
    );
    expect(ids.has(chatBranchId(sessionBranch({ branch: "feature" })))).toBe(false);
  });

  it("ignores malformed stored payloads", () => {
    localStorage.setItem("openclaw.chat.dismissedPullRequests", "not json");
    expect(listDismissedChatPullRequests("agent:main:main").size).toBe(0);
  });
});

describe("CI job details", () => {
  const headSha = "a".repeat(40);
  type Check = ControlUiSessionPullRequestCheckDetails["checks"][number];
  function check(
    id: number,
    name: string,
    state: Check["state"],
    extra: Partial<Check> = {},
  ): Check {
    return {
      id,
      name,
      state,
      status: state === "running" ? "in_progress" : "completed",
      source: "actions",
      ...extra,
    };
  }
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
      check(1, "Build", "passed", { conclusion: "success" }),
      check(2, "Tests", "running"),
      check(3, "Lint", "failed", {
        conclusion: "failure",
        startedAt: "2026-09-14T00:00:00Z",
        completedAt: "2026-09-14T00:01:12Z",
        detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/10/job/30",
        steps: [
          { number: 3, name: "Lint sources", status: "completed", conclusion: "failure" },
          { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
          { number: 4, name: "Upload report", status: "completed", conclusion: "skipped" },
          { number: 2, name: "Install", status: "completed", conclusion: "success" },
        ],
      }),
      check(4, "Deploy", "skipped", { conclusion: "skipped" }),
    ],
    ...overrides,
  });

  function harness() {
    const client = new GatewayBrowserClient({ url: "ws://localhost:12345" });
    const request = vi.spyOn(client, "request").mockResolvedValue(details());
    const { gateway, publish } = createApplicationGateway();
    publish({
      ...gateway.snapshot,
      client,
      phase: "connected",
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    });
    const props = {
      pullRequests: [pullRequest({ headSha })],
      gateway,
      sessionKey: "agent:main:main",
      status: "ready" as const,
      onDismiss() {},
    };
    paintChatPullRequests(props, container);
    const element = container.querySelector<ChatCiDetailsElement>("openclaw-chat-ci-details")!;
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    return {
      request,
      props,
      element,
      disclosure,
      disconnect() {
        publish({ ...gateway.snapshot, phase: "offline" });
      },
    };
  }

  async function settle(element: ChatCiDetailsElement) {
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
  }

  async function openDetails(h: ReturnType<typeof harness>) {
    await settle(h.element);
    h.disclosure.open = true;
    await settle(h.element);
  }

  async function refresh(h: ReturnType<typeof harness>) {
    await vi.advanceTimersByTimeAsync(30_000);
    await h.element.updateComplete;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:02:00Z"));
    setupContainer();
  });

  afterEach(() => {
    disposeContainer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches only while open, prioritizes live failures, and keeps manual job expansion across refresh", async () => {
    const h = harness();
    await settle(h.element);
    expect(h.request).not.toHaveBeenCalled();
    h.disclosure.open = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledOnce();
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
    await refresh(h);
    expect(h.request).toHaveBeenCalledTimes(requestsBeforeRefresh + 1);
    expect(failed.open).toBe(false);
    h.element.presented = false;
    await settle(h.element);
    const hiddenCount = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(hiddenCount);
    h.element.presented = true;
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(hiddenCount + 1);
    expect(h.disclosure.open).toBe(true);
    expect(query('.chat-ci__job[data-check-id="3"]')).toBe(failed);
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
      checks: [check(1, "Build", "passed", { conclusion: "success" })],
    });
    const rerun = details({
      checks: [check(5, "Build rerun", "running")],
    });
    h.request
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed)
      .mockResolvedValue(rerun);
    await openDetails(h);
    expect(h.request).toHaveBeenCalledTimes(1);
    paint({
      ...h.props,
      pullRequests: [
        pullRequest({
          headSha,
          checks: { state: "pending", passed: 0, failed: 0, skipped: 0, running: 1 },
        }),
      ],
    });
    await settle(h.element);
    await refresh(h);
    expect(h.request).toHaveBeenCalledTimes(2);
    await refresh(h);
    expect(text('.chat-ci__job[data-check-id="5"]')).toContain("Build rerun");
    expect(query('.chat-ci__job[data-check-id="1"]')).toBeNull();
  });

  it.each(["closed", "session", "gateway"] as const)(
    "retires a pending monitor on %s before accepting its late response",
    async (change) => {
      const h = harness();
      const pending = createDeferred<ControlUiSessionPullRequestCheckDetails>();
      h.request.mockReturnValueOnce(pending.promise).mockResolvedValue(details({ checks: [] }));
      await openDetails(h);
      expect(container.textContent).toContain("Loading jobs and steps");
      const signal = h.request.mock.calls[0]?.[2]?.signal;
      if (change === "closed") {
        h.disclosure.open = false;
        await settle(h.element);
      } else if (change === "session") {
        h.element.sessionKey = "agent:other:main";
      } else {
        h.element.gateway = { ...h.props.gateway };
      }
      expect(signal?.aborted).toBe(true);
      pending.resolve(details());
      await settle(h.element);
      expect(query(".chat-ci__job")).toBeNull();
      expect(h.disclosure.open).toBe(change === "gateway");
    },
  );

  it("clears prior CI details and redacts the RPC error", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(
      details({
        checks: [check(9, "Private build", "passed")],
      }),
    );
    await openDetails(h);
    expect(container.textContent).toContain("Private build");
    h.request.mockRejectedValue(new Error("GitHub request failed: token=synthetic-secret"));
    await refresh(h);
    expect(query(".chat-ci__job")).toBeNull();
    expect(container.textContent).not.toContain("Private build");
    expect(query('.chat-ci__notice[data-state="unavailable"]')).not.toBeNull();
    expect(container.textContent).toContain("GitHub request failed: token=[redacted]");
    expect(container.textContent).not.toContain("synthetic-secret");
    h.request.mockResolvedValue(details());
    click(".chat-ci__retry");
    await settle(h.element);
    expect(query(".chat-ci__notice")).toBeNull();
    expect(query(".chat-ci__job")).not.toBeNull();
  });

  it("clears details when the connection retires", async () => {
    const h = harness();
    await openDetails(h);
    expect(query(".chat-ci__job")).not.toBeNull();
    h.disconnect();
    await settle(h.element);
    expect(query(".chat-ci__job")).toBeNull();
    expect(container.textContent).toContain("Couldn’t load all CI details");
  });

  it("shows inline rate-limit recovery without retrying before the server delay", async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(
      details({ checks: [], status: "unavailable", rateLimited: true, retryAfterMs: 30_000 }),
    );
    await openDetails(h);
    const retry = container.querySelector<HTMLButtonElement>(".chat-ci__retry")!;
    expect(container.textContent).toContain("rate limit");
    expect(retry.disabled).toBe(true);
    await refresh(h);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(retry.disabled).toBe(false);
    retry.click();
    await settle(h.element);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(query(".chat-ci__job")).not.toBeNull();
  });

  it("represents non-Actions checks without invented steps or unsafe links", async () => {
    const h = harness();
    const external = check(5, "External audit", "passed", { source: "check" });
    const reply = (detailsUrl: string) => details({ checks: [{ ...external, detailsUrl }] });
    h.request.mockResolvedValue(reply("javascript:alert(1)"));
    await openDetails(h);
    expect(container.textContent).toContain("External audit");
    expect(container.textContent).toContain("does not provide GitHub Actions steps");
    expect(query(".chat-ci__step")).toBeNull();
    expect(query(".chat-ci__job-link")).toBeNull();
    h.request.mockResolvedValue(reply("https://ci.example.test/build/5"));
    await refresh(h);
    const link = container.querySelector<HTMLAnchorElement>(".chat-ci__job-link");
    expect(link?.href).toBe("https://ci.example.test/build/5");
    expect(link?.textContent).toContain("Open check details");
  });
});
