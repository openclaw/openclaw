/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import type { ChatSubagentActivityLive } from "./chat-subagent-activity-live.ts";

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
it("omits empty linked-work disclosures and opens arriving pull requests", async () => {
  const element = await mount();
  expect(element.querySelector("[data-details-group]")).toBeNull();
  element.props = {
    ...element.props!,
    pullRequests: [
      {
        number: 7,
        owner: "example",
        repo: "project",
        branch: "feature",
        title: "A pull request arriving after the panel opens",
        url: "https://github.com/example/project/pull/7",
        state: "open",
      },
    ],
  };
  await element.updateComplete;
  const group = element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')!;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new Event("toggle"));
  flush();
  element.props = { ...element.props! };
  await element.updateComplete;
  expect(group.open).toBe(false);
  const pullRequests = element.props!.pullRequests;
  element.props = { ...element.props!, pullRequests: [] };
  await element.updateComplete;
  expect(element.querySelector("[data-details-group]")).toBeNull();
  expect(element.querySelector(".chat-details-session > summary")).toBeNull();
  element.props = { ...element.props!, pullRequests };
  await element.updateComplete;
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
  expect(element.querySelector(".chat-details__creator")?.textContent).toContain(
    "Original creator",
  );
  expect(element.querySelector(".chat-details__creator")?.textContent).not.toContain(
    "Current owner",
  );
  expect(element.querySelector(".chat-details__participants")?.textContent).toContain(
    "Current owner",
  );
  expect(element.textContent).toContain("3 participants");
  expect(element.textContent).toContain("2 more participants");
  expect(element.textContent).not.toMatch(/online|viewers/i);
  expect(element.querySelector<HTMLDetailsElement>(".chat-details__participants")?.open).toBe(
    false,
  );
});
it("uses the current PR renderer and preserves CI session identity and branch dismissal", async () => {
  const dismiss = vi.fn();
  const element = await mount({
    pullRequestsSessionId: "incarnation-7",
    pullRequests: [
      {
        number: 7,
        owner: "example",
        repo: "project",
        branch: "feature",
        title: "A compact PR title",
        url: "https://github.com/example/project/pull/7",
        state: "open",
        additions: 84,
        deletions: 41,
      },
    ],
    onDismissPullRequest: dismiss,
  });
  expect(element.querySelector(".chat-pr__repo")?.textContent).toBe("A compact PR title");
  const link = element.querySelector(".chat-pr__link")!;
  for (const fact of ["example/project", "feature", "Open", "+84", "−41"]) {
    expect(link.getAttribute("title")).toContain(fact);
    expect(link.getAttribute("aria-description")).toContain(fact);
  }
  const automation = element.querySelector("openclaw-chat-ci-automation");
  expect(automation).toHaveProperty("sessionId", "incarnation-7");
  expect(automation).toHaveProperty("presented", true);
  element.querySelector<HTMLButtonElement>(".chat-pr__dismiss")!.click();
  expect(dismiss).toHaveBeenCalledWith(element.props!.pullRequests![0]);
  const branch = {
    owner: "example",
    repo: "project",
    branch: "feature",
    createUrl: "https://github.com/example/project/compare/feature",
  };
  element.props = {
    ...element.props!,
    pullRequests: [],
    pullRequestsBranch: branch,
    pullRequestsBranchDismissed: true,
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-pr")).toBeNull();
});
it("projects direct active children through the live observer with stable rounded-avatar seeds", async () => {
  const child = {
    key: "agent:main:subagent:details",
    kind: "direct" as const,
    label: "Verify layout",
    spawnedBy: "agent:main:details",
    hasActiveRun: true,
    activeRunIds: ["run-1"],
    sessionId: "child-1",
  };
  const element = await mount({
    selectedSession: { key: "agent:main:details", kind: "direct", hasActiveSubagentRun: true },
    subagentSessions: [child],
    subagentSessionsHydrated: true,
  });
  const live = element.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  expect(live.rows[0]?.session).toBe(child);
  expect(live.compact).toBe(true);
  expect(live.querySelector(".chat-details__agent-avatar")?.getAttribute("style")).toContain(
    String(fnv1aUtf16(child.key) % 360),
  );
  expect(live.querySelector(".chat-subagent-activity__name")?.textContent).toBe("Verify layout");
  element.presented = false;
  await element.updateComplete;
  expect(element.querySelector("openclaw-chat-subagent-activity")).toBeNull();
});

it("hides Participants for zero people and shows it only for a positive count", async () => {
  const element = await mount();
  expect(element.querySelector(".chat-details__participants")).toBeNull();
  element.props = {
    ...element.props!,
    selectedSession: { ...element.props!.selectedSession!, participantCount: 2 },
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-details__participants summary")?.textContent).toContain(
    "2 participants",
  );
  element.props = {
    ...element.props!,
    selectedSession: { ...element.props!.selectedSession!, participantCount: 0 },
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-details__participants")).toBeNull();
});

it("renders unknown without invented zero counts and keeps the All changes action usable", async () => {
  const open = vi.fn();
  const element = await mount({ onOpenSessionDiff: open });
  const button = element.querySelector<HTMLButtonElement>(".chat-details__changes")!;
  expect(button.textContent).toContain("—");
  expect(button.textContent).not.toContain("0 files");
  button.click();
  expect(open).toHaveBeenCalledOnce();
});

it("shows abbreviated colored deltas with exact accessible totals, partial and stale states", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<(method: string) => Promise<unknown>>()
    .mockImplementation(async (method: string) =>
      method === "sessions.diff"
        ? { files: [{ path: "app.ts" }], additions: 12_480, deletions: 61, truncated: true }
        : { jobs: [], total: 0, hasMore: false, nextOffset: null, snapshotRevision: "1" },
    );
  const gateway = {
    snapshot: { client: { request }, phase: "connected", hello: null },
    connectionRevision: 1,
    subscribe: () => () => {},
    subscribeEvents: () => () => {},
  } as unknown as ApplicationGateway;
  try {
    const element = await mount({ onOpenSessionDiff: vi.fn(), pullRequestsGateway: gateway });
    await vi.advanceTimersByTimeAsync(0);
    await waitForSolid(() =>
      expect(element.querySelector(".chat-details__change-files")?.textContent).toContain("1 file"),
    );
    const button = element.querySelector<HTMLButtonElement>(".chat-details__changes")!;
    expect(element.querySelector(".chat-details__change-lines--add")?.textContent).toBe("+12.5K");
    expect(element.querySelector(".chat-details__change-lines--del")?.textContent).toBe("−61");
    expect(button.getAttribute("aria-description")).toContain("+12480 lines, −61 lines");
    expect(button.textContent).toContain("partial");
    request.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForSolid(() => expect(button.textContent).toContain("stale"));
    expect(button.textContent).toContain("+12.5K");
    expect(button.getAttribute("aria-description")).toContain("Last-known changes");
    request.mockResolvedValue({ files: [], additions: 0, deletions: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForSolid(() => expect(button.textContent).toContain("0 files"));
    expect(button.textContent).toContain("+0");
    expect(button.textContent).toContain("−0");
    expect(
      element.querySelector(".chat-details__change-lines--add, .chat-details__change-lines--del"),
    ).toBeNull();
    element.remove();
  } finally {
    vi.useRealTimers();
  }
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
  expect(element.textContent).not.toContain("/workspace/project");
  expect(element.textContent).toContain("demo-model");
  expect(element.querySelector('[aria-label="Copy path"]')).not.toBeNull();
  expect(element.querySelector('[aria-label="Copy branch name"]')).not.toBeNull();
  const context = element.querySelector<HTMLDetailsElement>(".chat-details__context")!;
  expect(context.querySelector("summary")?.textContent).toContain("50%");
  context.open = true;
  element.props = {
    ...element.props!,
    selectedSession: {
      ...element.props!.selectedSession!,
      totalTokens: 32000,
      totalTokensFresh: false,
    },
  };
  await element.updateComplete;
  expect(context.open).toBe(true);
  expect(context.querySelector("summary")?.textContent).toContain("~25%");
  element
    .querySelector<HTMLButtonElement>(".chat-details__environment .chat-details__navigation")!
    .click();
  expect(openFiles).toHaveBeenCalledOnce();
  element.presented = false;
  await element.updateComplete;
  element
    .querySelector<HTMLButtonElement>(".chat-details__environment .chat-details__navigation")!
    .click();
  expect(openFiles).toHaveBeenCalledOnce();
});

it.each([
  "/home/private-user/.openclaw/workspace/",
  "C:\\Users\\private-user\\.openclaw\\workspace\\",
])("keeps an unlabelled workspace's private parent path out of Details: %s", async (root) => {
  const element = await mount({ detailsWorkspace: { root, label: null } });
  const environment = element.querySelector(".chat-details__environment")!;
  expect(environment.textContent).toContain("workspace");
  expect(environment.textContent).not.toContain(root);
  expect(environment.textContent).not.toContain("private-user");
  expect(environment.querySelector(".chat-details__row")?.getAttribute("title")).toBe("workspace");
  expect(environment.querySelector('[aria-label="Copy path"]')).not.toBeNull();
});
