/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
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
it("retains disclosure state across revisions and resets it for another session", async () => {
  const element = await mount();
  const disclosure = element.querySelector<HTMLDetailsElement>(".chat-details-session")!;
  expect(disclosure.open).toBe(true);
  disclosure.open = false;
  disclosure.dispatchEvent(new Event("toggle"));
  flush();

  element.props = { ...element.props!, detailsWorkspace: { root: "/workspace", label: "Updated" } };
  await element.updateComplete;
  expect(element.querySelector<HTMLDetailsElement>(".chat-details-session")!.open).toBe(false);

  element.props = {
    ...element.props!,
    sessionKey: "agent:main:other",
    selectedSession: { key: "agent:main:other", kind: "direct", sessionId: "other" },
  };
  await element.updateComplete;
  expect(element.querySelector<HTMLDetailsElement>(".chat-details-session")!.open).toBe(true);
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
  expect(automation).toHaveProperty("presented", false);
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
