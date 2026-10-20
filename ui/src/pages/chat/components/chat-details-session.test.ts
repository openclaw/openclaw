/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

type ChatSubagentActivityLive = SolidBridgeElement<SubagentActivityProps>;
const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent;
const detail = <T extends HTMLElement = HTMLElement>(root: ParentNode, name: string) =>
  root.querySelector<T>(`.chat-details__${name}`);
const child = (slug: string, state: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: `agent:main:subagent:${slug}`,
  kind: "direct",
  label: slug,
  spawnedBy: "agent:main:details",
  ...state,
});
const pullRequest = {
  number: 7,
  owner: "example",
  repo: "project",
  branch: "feature",
  title: "A compact PR title",
  url: "https://github.com/example/project/pull/7",
  state: "open" as const,
};
type Diff = {
  files: { path: string }[];
  additions: number;
  deletions: number;
  truncated?: boolean;
};
function summaryGateway(result: Diff) {
  const timing = { requestedAt: 0 };
  const diff = vi.fn<(params: unknown) => Promise<Diff>>().mockImplementation(async () => {
    timing.requestedAt = Date.now();
    return result;
  });
  const request = createGatewayRequestMock((method, params) =>
    method === "sessions.diff"
      ? diff(params)
      : { jobs: [], total: 0, hasMore: false, nextOffset: null, snapshotRevision: "1" },
  );
  const { gateway, publish } = createApplicationGateway();
  publish({ ...gateway.snapshot, phase: "connected", client: createTestGatewayClient(request) });
  return { gateway, diff, timing };
}

async function liveActivity(root: ParentNode) {
  await waitForSolid(() =>
    expect(root.querySelector("openclaw-chat-subagent-activity")).not.toBeNull(),
  );
  const live = root.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  return live;
}

async function mount(overrides: Partial<ChatDetailsProps> = {}) {
  const value: ChatDetailsProps = {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", kind: "direct" },
    ...overrides,
  };
  const view = mountSolid(() =>
    createComponent(ChatDetailsSession, { props: value, presented: true }),
  );
  const element = view.container.querySelector("openclaw-chat-details-session")!;
  await element.updateComplete;
  return element;
}
async function update(element: ChatDetailsSession, changes: Partial<ChatDetailsProps> = {}) {
  element.props = { ...element.props!, ...changes };
  await element.updateComplete;
}
it("omits empty linked-work disclosures and opens arriving pull requests", async () => {
  const element = await mount();
  expect(element.querySelector("[data-details-group]")).toBeNull();
  await update(element, {
    pullRequests: [{ ...pullRequest, title: "A pull request arriving after the panel opens" }],
  });
  const group = element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')!;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new Event("toggle"));
  flush();
  await update(element);
  expect(group.open).toBe(false);
  const pullRequests = element.props!.pullRequests;
  await update(element, { pullRequests: [] });
  expect(element.querySelector("[data-details-group]")).toBeNull();
  expect(element.querySelector(".chat-details-session > summary")).toBeNull();
  const openChanges = vi.fn();
  await update(element, { onOpenSessionDiff: openChanges });
  const changes = element.querySelector('[data-details-group="pull-requests"]')!;
  expect(text(changes, "summary")).toContain("Changes");
  const allChanges = changes.parentElement!.querySelector<HTMLButtonElement>(
    ".chat-details__all-changes",
  )!;
  expect(allChanges.closest("summary")).toBeNull();
  expect(allChanges.textContent).toContain("All changes");
  expect(allChanges.textContent).toContain("—");
  expect(allChanges.textContent).not.toContain("0 files");
  allChanges.click();
  expect(openChanges).toHaveBeenCalledOnce();
  await update(element, { onOpenSessionDiff: undefined });
  expect(element.querySelector("[data-details-group]")).toBeNull();
  await update(element, { pullRequests });
  expect(
    element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')?.open,
  ).toBe(true);
});
it("keeps immutable creator, mutable owner and participants distinct without claiming live presence", async () => {
  const element = await mount({
    selectedSession: {
      key: "agent:main:details",
      kind: "direct",
      createdActor: { type: "human", id: "creator", label: "Original creator" },
      owner: { actor: { type: "human", id: "owner", label: "Current owner" } },
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
      participantCount: 3,
    },
  });
  expect(text(element, ".chat-details__creator")).toContain("Original creator");
  expect(text(element, ".chat-details__creator")).not.toContain("Current owner");
  expect(text(element, ".chat-details__participants")).toContain("Current owner");
  expect(element.textContent).toContain("3 participants");
  expect(element.textContent).toContain("2 more participants");
  expect(element.textContent).not.toMatch(/online|viewers/i);
  expect(detail<HTMLDetailsElement>(element, "participants")?.open).toBe(false);
});
it("shows participant controls only while the session has participants", async () => {
  const element = await mount();
  expect(detail(element, "meta-actions")).toBeNull();
  await update(element, {
    selectedSession: {
      ...element.props!.selectedSession!,
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
    },
  });
  expect(text(element, ".chat-details__participants")).toContain("1 participants");
  await update(element, {
    selectedSession: { ...element.props!.selectedSession!, participantCount: 0 },
  });
  expect(detail(element, "meta-actions")).toBeNull();
});
it("uses the current PR renderer and preserves CI session identity and branch dismissal", async () => {
  const element = await mount({
    pullRequestsSessionId: "incarnation-7",
    pullRequests: [{ ...pullRequest, additions: 84, deletions: 41 }],
  });
  expect(text(element, ".chat-pr__title")).toBe("A compact PR title");
  const link = element.querySelector(".chat-pr__link")!;
  for (const fact of ["example/project", "feature", "Open", "+84", "−41"]) {
    expect(link.getAttribute("title")).toContain(fact);
    expect(link.getAttribute("aria-description")).toContain(fact);
  }
  const automation = element.querySelector("openclaw-chat-ci-automation");
  expect(automation).toMatchObject({ sessionId: "incarnation-7", presented: true });
  const branch = {
    owner: "example",
    repo: "project",
    branch: "feature",
    createUrl: "https://github.com/example/project/compare/feature",
  };
  await update(element, {
    pullRequests: [],
    pullRequestsBranch: branch,
    pullRequestsBranchDismissed: true,
  });
  expect(element.querySelector(".chat-pr")).toBeNull();
});
it("admits only the latest visible native summary inputs and retires detached work", async () => {
  vi.useFakeTimers();
  const result = { files: [{ path: "accepted.ts" }], additions: 3, deletions: 1 };
  const first = createDeferred<typeof result>();
  const retired = createDeferred<typeof result>();
  const { gateway, diff, timing } = summaryGateway(result);
  diff.mockReturnValueOnce(first.promise);
  const element = document.createElement("openclaw-chat-details-session");
  onTestFinished(async () => {
    element.remove();
    await Promise.resolve();
    vi.useRealTimers();
  });
  const select = (id: string) => {
    element.props = {
      sessionKey: `agent:main:${id}`,
      currentAgentId: "main",
      selectedSession: { key: `agent:main:${id}`, kind: "direct", sessionId: id },
      messages: [],
      pullRequestsGateway: gateway,
      onOpenSessionDiff: () => {},
    };
  };
  select("hidden");
  document.body.append(element);
  await element.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(diff).not.toHaveBeenCalled();

  element.presented = true;
  select("intermediate");
  select("first");
  await element.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(diff).toHaveBeenCalledExactlyOnceWith({
    sessionKey: "agent:main:first",
    agentId: "main",
    scope: "all",
    summaryOnly: true,
  });
  select("accepted");
  first.resolve({ ...result, additions: 999 });
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(text(element, ".chat-details__change-lines--add")).toBe("+3"));
  expect(diff).toHaveBeenCalledTimes(2);
  expect(diff).toHaveBeenLastCalledWith({
    sessionKey: "agent:main:accepted",
    agentId: "main",
    scope: "all",
    summaryOnly: true,
  });

  const button = detail(element, "all-changes");
  element.remove();
  document.body.append(element);
  await element.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  expect(detail(element, "all-changes")).toBe(button);
  expect(diff).toHaveBeenCalledTimes(2);

  element.props = { ...element.props!, runActive: true };
  await vi.advanceTimersByTimeAsync(timing.requestedAt + 4_999 - Date.now());
  expect(diff).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(diff).toHaveBeenCalledTimes(3);
  element.presented = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(diff).toHaveBeenCalledTimes(3);

  diff.mockReturnValueOnce(retired.promise);
  element.presented = true;
  await vi.advanceTimersByTimeAsync(0);
  expect(diff).toHaveBeenCalledTimes(4);
  element.remove();
  await Promise.resolve();
  retired.resolve({ ...result, additions: 999 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(diff).toHaveBeenCalledTimes(4);
});

it("shows abbreviated colored deltas with exact accessible totals, partial and stale states", async () => {
  vi.useFakeTimers();
  const { gateway, diff } = summaryGateway({
    files: [{ path: "app.ts" }],
    additions: 12_480,
    deletions: 61,
    truncated: true,
  });
  try {
    const element = await mount({ onOpenSessionDiff: vi.fn(), pullRequestsGateway: gateway });
    await vi.advanceTimersByTimeAsync(0);
    await waitForSolid(() =>
      expect(text(element, ".chat-details__change-files")).toContain("1 file"),
    );
    const button = detail<HTMLButtonElement>(element, "all-changes")!;
    expect(text(element, ".chat-details__change-lines--add")).toBe("+12.5K");
    expect(text(element, ".chat-details__change-lines--del")).toBe("−61");
    expect(button.getAttribute("aria-description")).toContain("+12480 lines, −61 lines");
    expect(button.textContent).toContain("partial");
    diff.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForSolid(() => expect(button.textContent).toContain("stale"));
    expect(button.textContent).toContain("+12.5K");
    expect(button.getAttribute("aria-description")).toContain("Last-known changes");
    diff.mockResolvedValue({ files: [], additions: 0, deletions: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForSolid(() => expect(button.textContent).toContain("0 files"));
    expect(button.textContent).toContain("+0");
    expect(button.textContent).toContain("−0");
    expect(detail(element, "change-lines--add, .chat-details__change-lines--del")).toBeNull();
    element.remove();
  } finally {
    vi.useRealTimers();
  }
});

it("groups every direct subagent with counts, live activity first, and a bounded preview", async () => {
  const parent = "agent:main:details";
  const openSubagents = vi.fn();
  const activeChild = child("review", {
    label: "Verify layout",
    sessionId: "child-1",
    hasActiveRun: true,
    activeRunIds: ["run-1"],
    startedAt: Date.now() - 65_000,
    observerDigest: {
      runId: "run-1",
      revision: 1,
      updatedAt: 1,
      headline: "Comparing themes",
      health: "on-track",
    },
  });
  const element = await mount({
    selectedSession: { key: parent, kind: "direct", hasActiveSubagentRun: true },
    subagentSessions: [
      activeChild,
      child("queued", { status: "queued" }),
      child("docs", { status: "done" }),
      child("bench", { status: "timeout" }),
      child("lint", { status: "killed" }),
      child("archived", { status: "done", archived: true }),
      child("other-parent", { status: "done", spawnedBy: "agent:main:elsewhere" }),
    ],
    subagentSessionsHydrated: true,
    onOpenSubagents: openSubagents,
  });
  expect(element.querySelector('[data-details-group="processes"]')).toBeNull();
  const lane = element.querySelector<HTMLDetailsElement>('[data-details-group="subagents"]')!;
  expect(lane.open).toBe(true);
  const summary = lane.querySelector("summary")!;
  expect(text(summary, ".chat-details__tally-summary")).toBe(
    "1 running · 1 queued · 1 done · 1 failed · 1 stopped",
  );
  // The bar sits in the heading so a collapsed group still shows it.
  expect(
    [...summary.querySelectorAll<HTMLElement>(".chat-details__tally-segment")].map(
      (segment) => segment.dataset.state,
    ),
  ).toEqual(["done", "failed", "stopped", "running", "queued"]);
  const live = await liveActivity(lane);
  expect(live.rows[0]?.session).toBe(activeChild);
  expect(live.compact).toBe(true);
  expect(detail(live, "agent-avatar")?.getAttribute("style")).toContain(
    String(fnv1aUtf16(activeChild.key) % 360),
  );
  expect(text(live, ".chat-subagent-activity__name")).toBe("Verify layout");
  const shownKeys = () =>
    [...live.querySelectorAll<HTMLElement>("[data-subagent-session-key]")].map((row) =>
      row.dataset.subagentSessionKey?.replace("agent:main:subagent:", ""),
    );
  expect(shownKeys()).toEqual(["review", "queued", "bench"]);
  const more = detail<HTMLButtonElement>(lane, "more")!;
  expect(more.textContent).toBe("Show 2 more");
  more.click();
  await live.updateComplete;
  expect(shownKeys()).toEqual(["review", "queued", "bench", "lint", "docs"]);
  expect(more.textContent).toBe("Show less");
  expect(
    text(
      live,
      '[data-subagent-session-key="agent:main:subagent:bench"] .chat-subagent-activity__status',
    ),
  ).toBe("Failed");
  const review = live.querySelector('[data-subagent-session-key="agent:main:subagent:review"]')!;
  expect(text(review, ".chat-subagent-activity__status")).toBe("Comparing themes");
  expect(text(review, ".chat-subagent-activity__elapsed-compact")).not.toBe("");
  detail<HTMLButtonElement>(lane, "navigation")!.click();
  expect(openSubagents).toHaveBeenCalledOnce();
  element.presented = false;
  await element.updateComplete;
  expect(element.querySelector("openclaw-chat-subagent-activity")).toBeNull();
  detail<HTMLButtonElement>(lane, "navigation")?.click();
  expect(openSubagents).toHaveBeenCalledOnce();
});

it("shows finished subagents after the parent stops waiting and omits the group without any", async () => {
  const element = await mount({
    subagentSessions: [child("done", { label: undefined, status: "done" })],
    subagentSessionsHydrated: true,
  });
  const group = element.querySelector('[data-details-group="subagents"]')!;
  expect(text(group, ".chat-details__tally-summary")).toBe("1 done");
  expect(detail(group, "more")).toBeNull();
  const live = await liveActivity(group);
  expect(text(live, ".chat-subagent-activity__status")).toBe("Completed");
  await update(element, { subagentSessionsHydrated: false });
  expect(element.querySelector('[data-details-group="subagents"]')).toBeNull();
});

it("shows live environment and context facts while preserving disclosure intent", async () => {
  const openFiles = vi.fn();
  const element = await mount({
    detailsWorkspace: { label: "project", root: "/workspace/project", branch: "feature/details" },
    onOpenWorkspace: openFiles,
    selectedSession: {
      key: "agent:main:details",
      kind: "direct",
      execNode: "Design workstation",
      model: "demo-model",
      totalTokens: 64000,
      totalTokensFresh: true,
      contextTokens: 128000,
      inputTokens: 1200,
      outputTokens: 450,
    },
  });
  expect(element.textContent).toContain("Design workstation");
  expect(element.textContent).toContain("project");
  expect(element.textContent).toContain("demo-model");
  expect(element.textContent).not.toContain("/workspace/project");
  expect(element.querySelector('[aria-label="Copy path"]')).not.toBeNull();
  expect(element.querySelector('[aria-label="Copy branch name"]')).not.toBeNull();
  const context = detail<HTMLDetailsElement>(element, "context")!;
  expect(text(context, "summary")).toContain("50%");
  context.open = true;
  await update(element, {
    selectedSession: {
      ...element.props!.selectedSession!,
      totalTokens: 32000,
      totalTokensFresh: false,
    },
  });
  expect(context.open).toBe(true);
  expect(text(context, "summary")).toContain("~25%");
  const openWorkspace = () =>
    element
      .querySelector<HTMLButtonElement>(".chat-details__environment .chat-details__navigation")!
      .click();
  openWorkspace();
  expect(openFiles).toHaveBeenCalledOnce();
  element.presented = false;
  await element.updateComplete;
  openWorkspace();
  expect(openFiles).toHaveBeenCalledOnce();
});

it.each([
  "/home/private-user/.openclaw/workspace/",
  "C:\\Users\\private-user\\.openclaw\\workspace\\",
])("keeps an unlabelled workspace's private parent path out of Details: %s", async (root) => {
  const element = await mount({ detailsWorkspace: { root, label: null } });
  const environment = detail(element, "environment")!;
  expect(environment.textContent).toContain("workspace");
  expect(environment.textContent).not.toContain(root);
  expect(environment.textContent).not.toContain("private-user");
  expect(detail(environment, "row")?.getAttribute("title")).toBe("workspace");
  expect(environment.querySelector('[aria-label="Copy path"]')).not.toBeNull();
});
