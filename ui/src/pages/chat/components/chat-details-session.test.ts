/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

type ChatSubagentActivityLive = SolidBridgeElement<SubagentActivityProps>;

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
  const openChanges = vi.fn();
  element.props = { ...element.props!, onOpenSessionDiff: openChanges };
  await element.updateComplete;
  const changes = element.querySelector('[data-details-group="pull-requests"]')!;
  expect(changes.querySelector("summary")?.textContent).toContain("Changes");
  const allChanges = changes.parentElement!.querySelector<HTMLButtonElement>(
    ".chat-details__all-changes",
  )!;
  expect(allChanges.closest("summary")).toBeNull();
  expect(allChanges.textContent).toContain("All changes");
  allChanges.click();
  expect(openChanges).toHaveBeenCalledOnce();
  element.props = { ...element.props!, onOpenSessionDiff: undefined };
  await element.updateComplete;
  expect(element.querySelector("[data-details-group]")).toBeNull();
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
it("shows participant controls only while the session has participants", async () => {
  const element = await mount();
  expect(element.querySelector(".chat-details__meta-actions")).toBeNull();
  element.props = {
    ...element.props!,
    selectedSession: {
      ...element.props!.selectedSession!,
      participants: [{ identity: { type: "profile", id: "participant" }, label: "Contributor" }],
    },
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-details__participants")?.textContent).toContain(
    "1 participants",
  );
  element.props = {
    ...element.props!,
    selectedSession: { ...element.props!.selectedSession!, participantCount: 0 },
  };
  await element.updateComplete;
  expect(element.querySelector(".chat-details__meta-actions")).toBeNull();
});
it("uses the current PR renderer and preserves CI session identity and branch dismissal", async () => {
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
  });
  expect(element.querySelector(".chat-pr__title")?.textContent).toBe("A compact PR title");
  const link = element.querySelector(".chat-pr__link")!;
  for (const fact of ["example/project", "feature", "Open", "+84", "−41"]) {
    expect(link.getAttribute("title")).toContain(fact);
    expect(link.getAttribute("aria-description")).toContain(fact);
  }
  const automation = element.querySelector("openclaw-chat-ci-automation");
  expect(automation).toHaveProperty("sessionId", "incarnation-7");
  expect(automation).toHaveProperty("presented", true);
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

it("groups every direct subagent with counts, live activity first, and a bounded preview", async () => {
  const parent = "agent:main:details";
  const child = (slug: string, state: Partial<GatewaySessionRow>): GatewaySessionRow => ({
    key: `agent:main:subagent:${slug}`,
    kind: "direct",
    label: slug,
    spawnedBy: parent,
    ...state,
  });
  const openSubagents = vi.fn();
  const element = await mount({
    selectedSession: { key: parent, kind: "direct", hasActiveSubagentRun: true },
    subagentSessions: [
      child("review", {
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
      }),
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
  expect(summary.querySelector(".chat-details__tally-summary")?.textContent).toBe(
    "1 running · 1 queued · 1 done · 1 failed · 1 stopped",
  );
  // The bar sits in the heading so a collapsed group still shows it.
  expect(
    [...summary.querySelectorAll<HTMLElement>(".chat-details__tally-segment")].map(
      (segment) => segment.dataset.state,
    ),
  ).toEqual(["done", "failed", "stopped", "running", "queued"]);
  const live = lane.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  const shownKeys = () =>
    [...live.querySelectorAll<HTMLElement>("[data-subagent-session-key]")].map((row) =>
      row.dataset.subagentSessionKey?.replace("agent:main:subagent:", ""),
    );
  expect(shownKeys()).toEqual(["review", "queued", "bench"]);
  const more = lane.querySelector<HTMLButtonElement>(".chat-details__more")!;
  expect(more.textContent).toBe("Show 2 more");
  more.click();
  await live.updateComplete;
  expect(shownKeys()).toEqual(["review", "queued", "bench", "lint", "docs"]);
  expect(more.textContent).toBe("Show less");
  expect(
    live
      .querySelector('[data-subagent-session-key="agent:main:subagent:bench"]')
      ?.querySelector(".chat-subagent-activity__status")?.textContent,
  ).toBe("Failed");
  const review = live.querySelector('[data-subagent-session-key="agent:main:subagent:review"]')!;
  expect(review.querySelector(".chat-subagent-activity__status")?.textContent).toBe(
    "Comparing themes",
  );
  expect(review.querySelector(".chat-subagent-activity__elapsed-compact")?.textContent).not.toBe(
    "",
  );
  lane.querySelector<HTMLButtonElement>(".chat-details__navigation")!.click();
  expect(openSubagents).toHaveBeenCalledOnce();
  element.presented = false;
  await element.updateComplete;
  lane.querySelector<HTMLButtonElement>(".chat-details__navigation")?.click();
  expect(openSubagents).toHaveBeenCalledOnce();
});

it("shows finished subagents after the parent stops waiting and omits the group without any", async () => {
  const element = await mount({
    subagentSessions: [
      {
        key: "agent:main:subagent:done",
        kind: "direct",
        status: "done",
        spawnedBy: "agent:main:details",
      },
    ],
    subagentSessionsHydrated: true,
  });
  const group = element.querySelector('[data-details-group="subagents"]')!;
  expect(group.querySelector(".chat-details__tally-summary")?.textContent).toBe("1 done");
  expect(group.querySelector(".chat-details__more")).toBeNull();
  const live = group.querySelector<ChatSubagentActivityLive>("openclaw-chat-subagent-activity")!;
  await live.updateComplete;
  expect(live.querySelector(".chat-subagent-activity__status")?.textContent).toBe("Completed");
  element.props = { ...element.props!, subagentSessionsHydrated: false };
  await element.updateComplete;
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
