/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { SessionHovercard, type SessionHovercardInput } from "./session-hovercard-solid.tsx";

function row(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    key: "agent:main:work",
    label: "Ship the release",
    hasActiveRun: true,
    createdAt: Date.now() - 2 * 60 * 60_000,
    startedAt: Date.now() - 2 * 60 * 60_000,
    updatedAt: Date.now() - 5 * 60_000,
    createdActor: {
      type: "human",
      id: "alice",
      identity: { type: "profile", id: "alice" },
      label: "Alice Baker",
    },
    subtitle: "openclaw ⎇ feature/session-hovercard",
    workContext: {
      kind: "project",
      name: "openclaw",
      path: "/repo/openclaw",
      cwd: "/work/openclaw",
      branch: "feature/session-hovercard",
    },
    children: [],
    ...overrides,
  } as SidebarRecentSession;
}

function snapshot(
  overrides: Partial<ControlUiSessionPullRequestSnapshot> = {},
): ControlUiSessionPullRequestSnapshot {
  return { status: "ready", pullRequests: [], rateLimited: false, ...overrides };
}

function pullRequest(
  number: number,
  title: string,
  state: ControlUiSessionPullRequest["state"] = "open",
  overrides: Partial<ControlUiSessionPullRequest> = {},
): ControlUiSessionPullRequest {
  return {
    owner: "openclaw",
    repo: "openclaw",
    branch: "feature",
    number,
    title,
    state,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    ...overrides,
  };
}

function participant(id: string, label: string) {
  return { identity: { type: "profile" as const, id }, label };
}

function progressCard(): ProgressCard {
  return {
    sessionKey: "agent:main:work",
    revision: 1,
    updatedAt: Date.now(),
    markdown: "**Release** is ready.",
    steps: [{ step: "Verify", status: "in_progress" }],
  };
}

const updateCards = new WeakMap<HTMLElement, (input: SessionHovercardInput) => void>();

function renderCard(input: SessionHovercardInput, container = document.createElement("div")) {
  const update = updateCards.get(container);
  if (update) {
    update(input);
  } else {
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(input);
        updateCards.set(container, (next) => setCurrent(next));
        return createComponent(SessionHovercard, {
          get row() {
            return current().row;
          },
          get selfUserId() {
            return current().selfUserId;
          },
          get avatarAuth() {
            return current().avatarAuth;
          },
          get personActivity() {
            return current().personActivity;
          },
          get automationLink() {
            return current().automationLink;
          },
          get pullRequests() {
            return current().pullRequests;
          },
          get progressCard() {
            return current().progressCard;
          },
        });
      },
      { container },
    );
  }
  flush();
  return container;
}

function find<T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  suffix: string,
) {
  return root?.querySelector<T>(`.session-hovercard__${suffix}`);
}
function text(root: ParentNode | null | undefined, suffix: string) {
  return find(root, suffix)?.textContent;
}

function attributionSummary(container: ParentNode): string {
  return [text(container, "attribution-name"), text(container, "attribution-others")]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("session hovercard", () => {
  it.each([undefined, "Validation worker"])(
    "shows the full failure above the notepad (child: %s)",
    (childLabel) => {
      const reason = "Validation failed.\n<worker> was unavailable; retry after reconnecting.";
      const failed = row({
        attention: { kind: "error", reason, childLabel, sourceSessionKey: "agent:main:failed" },
      });
      const container = renderCard({ row: failed, progressCard: progressCard() });
      const error = find(container, "error");
      expect(error?.textContent).toContain(reason);
      expect(error?.textContent).toContain(
        childLabel ? "Child session Validation worker failed:" : "Run failed:",
      );
      expect(error?.querySelector("worker")).toBeNull();
      expect(error?.querySelector("svg")).not.toBeNull();
      expect(error?.nextElementSibling?.classList.contains("session-hovercard__notepad")).toBe(
        true,
      );

      renderCard({ row: failed }, container);
      expect(text(container, "error")).toContain(reason);
      expect(find(container, "notepad")).toBeNull();
      renderCard({ row: row({ attention: { kind: "none" } }) }, container);
      expect(find(container, "error")).toBeNull();
    },
  );

  it.each([
    {
      name: "group conversation with contributors",
      facts: {
        label: "Weekend plans",
        channelPresentation: {
          channel: "whatsapp",
          channelLabel: "WhatsApp",
          kind: "group",
          conversation: "Weekend plans",
          account: "personal",
        },
        createdActor: { type: "human", id: "cli", label: "CLI" },
        participants: [participant("alice", "Alice")],
        participantCount: 1,
      },
    },
    {
      name: "direct contact without contributors",
      facts: {
        label: "Alex",
        createdActor: undefined,
        channelPresentation: {
          channel: "imessage",
          channelLabel: "iMessage",
          kind: "direct",
          address: "alex@example.com",
        },
      },
    },
  ] satisfies { name: string; facts: Partial<SidebarRecentSession> }[])(
    "renders channel identity for $name",
    ({ facts }) => {
      const container = renderCard({ row: row({ workContext: undefined, ...facts }) });
      const contributors = container.querySelector('[aria-label="In this session"]');
      if (facts.channelPresentation.kind === "group") {
        const header = find(container, "header");
        expect(header?.textContent).toContain("Linked to WhatsApp");
        expect(header?.textContent).toContain("Group chat");
        expect(header?.textContent).toContain("Via personal");
        expect(header?.textContent?.match(/Weekend plans/g)).toHaveLength(1);
        expect(header?.textContent).not.toContain("CLI");
        expect(contributors?.textContent).toContain("CLI");
        expect(contributors?.textContent).toContain("1 other");
        expect(container.textContent).not.toContain("members");
      } else {
        expect(text(container, "conversation")).toContain("alex@example.com");
        expect(find(container, "conversation a")).toBeNull();
        expect(contributors).toBeNull();
        expect(container.textContent).not.toContain("Via");
      }
    },
  );

  it.each<[SidebarRecentSession["placementMachine"], string]>([
    [
      { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
      "Linux · medium · 4 vCPU · 16 GB",
    ],
    [{ os: "windows/wsl2", memoryGb: 8 }, "windows/wsl2 · 8 GB"],
    [undefined, ""],
  ])(
    "shows only known machine facts: %j",
    (placementMachine: SidebarRecentSession["placementMachine"], summary) => {
      const container = renderCard({
        row: row({
          placementProviderId: "machine0",
          placementProfileId: "team",
          placementMachine,
        }),
      });
      const machine = find(container, "machine");
      if (summary) {
        expect(machine?.getAttribute("aria-label")).toBe(`Machine: ${summary}`);
        expect(
          [...container.querySelectorAll(".session-hovercard__machine span")]
            .map((item) => item.textContent)
            .join(" · "),
        ).toBe(summary);
        expect(text(machine, "machine-class")).toBe(placementMachine?.class);
      } else {
        expect(machine).toBeNull();
      }
    },
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("renders dashboard and automation facts without other metadata", () => {
    const container = renderCard({
      row: row({
        createdActor: undefined,
        workContext: undefined,
        boardFace: "dashboard",
        hasAutomation: true,
      }),
      automationLink: {
        gateway: null,
        sessionKey: "agent:main:work",
        agentId: "main",
        href: "/automations?session=agent%3Amain%3Awork&agent=main",
        navigate: vi.fn(),
      },
    });
    expect(
      [...container.querySelectorAll(".session-hovercard__context-row")].map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["Opens as dashboard", "Automation attached"]);
    expect(Boolean(find(container, "section--metadata"))).toBe(true);
    expect(container.querySelectorAll("a.session-hovercard__automation-link")).toHaveLength(1);
  });

  it("opens attached automations without hijacking modified clicks", () => {
    const navigate = vi.fn();
    const href = "/control/automations?session=agent%3Aops%3Anight+watch&agent=ops";
    const container = renderCard({
      row: row({ hasAutomation: true }),
      automationLink: {
        href,
        navigate,
        gateway: null,
        sessionKey: "agent:ops:night watch",
        agentId: "ops",
      },
    });
    const link = find<HTMLAnchorElement>(container, "automation-link")!;
    expect(link?.getAttribute("href")).toBe(href);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    const open = find<HTMLAnchorElement>(container, "automation-open")!;
    open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    { authReady: true, authTokens: ["device-token", "saved-token"], suffix: "agent%3Amain%3Awork" },
    { authReady: false, authTokens: [], suffix: "pending" },
  ])(
    "renders channel avatars with auth ready: $authReady",
    async ({ authReady, authTokens, suffix }) => {
      const container = document.createElement("div");
      if (!authReady) {
        document.body.appendChild(container);
      }
      const channelAvatarUrl = `/__openclaw__/channel-avatar/${suffix}`;
      renderCard(
        { row: row({ channelAvatarUrl }), avatarAuth: { authTokens, authReady } },
        container,
      );

      const avatar = container.querySelector<
        HTMLElement & {
          routeUrl: string;
          authTokens: readonly string[];
          authReady: boolean;
          updateComplete: Promise<boolean>;
        }
      >("openclaw-channel-avatar.session-hovercard__creator-avatar");
      expect(avatar).not.toBeNull();
      expect(avatar?.routeUrl).toBe(channelAvatarUrl);
      expect(avatar?.authTokens).toEqual(authTokens);
      expect(avatar?.authReady).toBe(authReady);
      expect(container.querySelector("openclaw-viewer-avatar")).toBeNull();
      if (!authReady) {
        await customElements.whenDefined("openclaw-channel-avatar");
        await avatar?.updateComplete;
        await vi.waitFor(() => {
          expect(text(avatar, "creator-avatar-fallback")).toBe("AB");
        });
        expect(avatar?.querySelector("img.channel-avatar")).toBeNull();
        renderCard(
          {
            row: row({
              channelAvatarUrl,
              createdActor: {
                type: "human",
                id: "charlie",
                identity: { type: "profile", id: "charlie" },
                label: "Charlie Delta",
              },
            }),
            avatarAuth: { authTokens, authReady },
          },
          container,
        );
        await avatar?.updateComplete;
        expect(container.querySelector("openclaw-channel-avatar")).toBe(avatar);
        expect(text(avatar, "creator-avatar-fallback")).toBe("CD");
      }
    },
  );

  it("shows task publications without claiming unknown GitHub state or hiding branch actions", () => {
    const branch = {
      owner: "example",
      repo: "project",
      branch: "coordination",
      createUrl: "https://github.com/example/project/pull/new/coordination",
    };
    const task = {
      owner: "example",
      repo: "project",
      branch: "fix/child",
      url: "https://github.com/example/project/pull/417",
      number: 417,
      title: "Child publication",
      sourceSessionKey: "agent:main:child",
      sourceAgentId: "main",
    };
    const container = renderCard({
      pullRequests: snapshot({ branch, taskPullRequests: [task], taskPullRequestCount: 1 }),
    });
    const link = find<HTMLAnchorElement>(container, "pr-row");
    expect(link?.href).toBe(task.url);
    expect(link?.dataset.state).toBeUndefined();
    expect(link?.textContent).toContain("Status unavailable");
    expect(link?.textContent).toContain("Task branch: fix/child");
    expect(find<HTMLAnchorElement>(container, "branch-action")?.href).toBe(branch.createUrl);
    const bounded = {
      taskPullRequests: [task],
      taskPullRequestCount: 30,
      pullRequests: [
        {
          ...task,
          number: 418,
          url: "https://github.com/example/project/pull/418",
          state: "open" as const,
        },
      ],
    };
    renderCard({ pullRequests: snapshot({ ...bounded, pullRequestCount: 31 }) }, container);
    expect(text(container, "pr-count")).toBe("31");
    expect(text(container, "more")).toContain("29 more");
    // The branch PR can also belong to receipts outside the bounded task preview.
    renderCard({ pullRequests: snapshot({ ...bounded, pullRequestCount: 30 }) }, container);
    expect(text(container, "pr-count")).toBe("30");
    expect(container.querySelectorAll(".session-hovercard__pr-row")).toHaveLength(2);
    expect(text(container, "more")).toContain("28 more");
    const known = { ...task, state: "merged" as const };
    renderCard(
      {
        pullRequests: snapshot({
          pullRequests: [known],
          taskPullRequests: [{ ...task, pullRequest: known }],
        }),
      },
      container,
    );
    expect(container.querySelectorAll(".session-hovercard__pr-row")).toHaveLength(1);
    expect(find(container, "pr-row")?.getAttribute("data-state")).toBe("merged");
  });

  it("shows all supplied PRs with active work first, identities, and checks", () => {
    const container = renderCard({
      pullRequests: snapshot({
        pullRequests: [
          pullRequest(101, "First", "open", {
            changedFiles: 2,
            additions: 7,
            deletions: 3,
            checks: { state: "passing", passed: 2, failed: 0, skipped: 0, running: 0 },
          }),
          pullRequest(102, "Second", "draft"),
          pullRequest(103, "Third", "merged"),
        ].toReversed(),
      }),
    });

    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")];
    expect(links).toHaveLength(3);
    expect(links[0]?.href).toBe("https://github.com/openclaw/openclaw/pull/101");
    expect(links[0]?.target).toBe("_blank");
    expect(links[0]?.rel).toContain("noopener");
    expect(links[0]?.querySelector(".session-hovercard__pr-title")?.textContent).toBe("First");
    expect(
      links[0]?.querySelector(".session-hovercard__pr-title")?.getAttribute("title"),
    ).toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__pr-number")?.textContent).toBe(
      "openclaw/openclaw#101",
    );
    expect(links[0]?.querySelector(".session-hovercard__pr-author")).toBeNull();
    expect(
      links[0]?.querySelector(".session-hovercard__pr-state-icon")?.getAttribute("title"),
    ).toBe("Open · CI checks passing");
    expect(links[0]?.querySelector(".session-hovercard__pr-state-icon svg")).not.toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__files")).toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__additions")?.textContent).toBe("+7");
    expect(links[0]?.querySelector(".session-hovercard__deletions")?.textContent).toBe("−3");
    expect(links[0]?.getAttribute("aria-label")).toContain("First");
    expect(links[0]?.getAttribute("aria-label")).not.toContain("Opened by");
    expect(links[0]?.getAttribute("aria-label")).not.toContain("files");
    expect(links.map((link) => link.dataset.state)).toEqual(["open", "draft", "merged"]);
    expect(links[0]?.querySelector(".session-hovercard__pr-checks")?.textContent).toBe(
      "CI checks passing",
    );
    expect(container.querySelector("details")).toBeNull();
    expect(find(container, "section--header")).toBeNull();
  });

  it.each(["rate-limited", "unavailable"] as const)(
    "explains %s GitHub lookups with or without retained work and clears the warning after recovery",
    (status) => {
      const container = document.createElement("div");
      const branch = { owner: "openclaw", repo: "openclaw", branch: "feature" };
      const retained = pullRequest(101, "Retained pull request");
      for (const work of [{}, { branch }, { pullRequests: [retained] }]) {
        renderCard(
          {
            pullRequests: snapshot({ ...work, status, rateLimited: status === "rate-limited" }),
          },
          container,
        );
        const notice = container.querySelector('[role="status"]');
        expect(notice?.textContent).toContain(
          status === "rate-limited" ? "GitHub API rate limit reached" : "could not be refreshed",
        );
        if (status === "unavailable") {
          expect(notice?.textContent).not.toContain("rate limit");
        }
      }
      expect(find<HTMLAnchorElement>(container, "pr-row")?.href).toBe(retained.url);
      renderCard({ pullRequests: snapshot({ pullRequests: [retained] }) }, container);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).toContain(retained.title);
    },
  );

  it.each([
    {
      workContext: {
        kind: "project",
        name: "project",
        path: "https://github.com/example/project",
        branch: "feature/ui",
      },
      label: "Project: project",
      title: "Project: https://github.com/example/project",
    },
    {
      workContext: { kind: "workspace", name: "release-notes", path: "/workspaces/release-notes" },
      label: "Workspace: release-notes",
      title: "Workspace: /workspaces/release-notes",
    },
    { workContext: undefined, label: "node-only subtitle", title: "" },
  ] satisfies { workContext: SidebarRecentSession["workContext"]; label: string; title: string }[])(
    "renders only authoritative work context: $label",
    ({ workContext, label, title }) => {
      const container = renderCard({ row: row({ subtitle: "macbook", workContext }) });
      if (!workContext) {
        expect(find(container, "section--metadata")).toBeNull();
        expect(find(container, "context-text")).toBeNull();
        return;
      }
      const context = container.querySelector(`[aria-label="${label}"]`);
      expect(context?.getAttribute("title")).toBe(title);
      if (workContext.kind === "project") {
        expect(
          container.querySelector('[aria-label="Branch: feature/ui"]')?.hasAttribute("title"),
        ).toBe(false);
      } else {
        expect(context?.getAttribute("aria-label")).toBe(label);
        expect(context?.textContent).toContain("release-notes");
      }
    },
  );

  it.each([
    {
      branch: "feature",
      changedFiles: 3,
      additions: 12,
      deletions: 4,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    },
    { branch: "local-only", changedFiles: 2, additions: 18, deletions: 1, createUrl: undefined },
  ])("keeps branch identity separate from available actions: $branch", (branch) => {
    const container = renderCard({
      row: branch.createUrl
        ? row({ workSession: true, subtitle: "openclaw/openclaw · feature" })
        : undefined,
      pullRequests: snapshot({ branch: { owner: "openclaw", repo: "openclaw", ...branch } }),
    });
    expect(find(container, "branch-name")).toBeNull();
    expect(text(container, "additions")).toBe(`+${branch.additions}`);
    expect(text(container, "deletions")).toBe(`−${branch.deletions}`);
    const createLink = find<HTMLAnchorElement>(container, "branch-action");
    if (branch.createUrl) {
      expect(find(container, "files")).toBeNull();
      expect(createLink?.textContent).toBe("Create PR");
      expect(createLink?.href).toBe(branch.createUrl);
      expect(createLink?.title).toBe("Create a pull request for feature");
    } else {
      expect(createLink).toBeNull();
      expect(text(container, "branch-label")).toBe("Changes");
    }
  });

  it("renders the latest turn as plain text when progress is absent", () => {
    const container = renderCard({
      row: row({ lastMessagePreview: "  Finished <strong>without markup</strong>.  " }),
    });

    expect(text(container, "excerpt")).toBe("Finished <strong>without markup</strong>.");
    expect(find(container, "excerpt strong")).toBeNull();
    expect(container.querySelector(".session-progress-card")).toBeNull();
  });

  it.each(["active", "markdown-only", "completed"])(
    "keeps Agent Notepad separate from %s plan metadata",
    (mode) => {
      const card = progressCard();
      const container = renderCard({
        row: row({
          ...(mode === "active" ? { lastMessagePreview: "This must not appear." } : {}),
          ...(mode === "completed" ? { status: "done" } : {}),
        }),
        progressCard: { ...card, steps: mode === "markdown-only" ? undefined : card.steps },
      });

      const plan = find(container, "plan-row");
      if (mode === "active") {
        expect(text(plan, "plan-step")).toBe("Verify");
        expect(text(plan, "plan-count")).toBe("0/1");
        expect(plan?.querySelector(".session-run-spinner")).not.toBeNull();
      } else {
        expect(plan).toBeNull();
      }
      const notepad = find(container, "notepad");
      expect(notepad).not.toBeNull();
      expect(text(notepad, "notepad-title")).toBe("Agent Notepad");
      expect(notepad?.querySelector("strong")?.textContent).toBe("Release");
      expect(container.querySelector(".session-progress-card")).toBeNull();
      expect(container.querySelector("time")).toBeNull();
      expect(find(container, "excerpt")).toBeNull();
      expect(container.textContent).not.toContain("This must not appear.");
    },
  );

  it.each([
    { hasActiveRun: true, updateOffset: -1, status: "running" },
    { hasActiveRun: false, updateOffset: 1, status: "running" },
    { hasActiveRun: true, updateOffset: -1, status: "done" },
  ] satisfies {
    hasActiveRun: boolean;
    updateOffset: number;
    status: SidebarRecentSession["status"];
  }[])("pauses unfinished progress with run state %j", ({ hasActiveRun, updateOffset, status }) => {
    const startedAt = Date.now();
    const container = renderCard({
      row: row({ startedAt, status, hasActiveRun }),
      progressCard: { ...progressCard(), updatedAt: startedAt + updateOffset },
    });

    const plan = find(container, "plan-row");
    expect(plan?.getAttribute("aria-label")).toBe("Verify, paused");
    expect(plan?.querySelector(".session-run-spinner")).toBeNull();
    expect(plan?.querySelector("polyline")).not.toBeNull();
  });

  it("pins a labeled markdown progress bar above the Agent Notepad copy", () => {
    const container = renderCard({
      row: row(),
      progressCard: {
        ...progressCard(),
        markdown:
          '**Build is healthy.**\n\n<progress aria-label="CI · 4/6" value="4" max="6"></progress>\n\nWaiting on Windows.',
      },
    });

    const markdown = container.querySelector(".session-progress-card__markdown");
    const promoted = markdown?.firstElementChild;
    expect(promoted?.classList.contains("session-progress-card__progress")).toBe(true);
    expect(promoted?.querySelector(".session-progress-card__progress-label")?.textContent).toBe(
      "CI · 4/6",
    );
    expect(promoted?.querySelector("progress")?.getAttribute("value")).toBe("4");
    expect(markdown?.textContent).toContain("Build is healthy.");
    expect(markdown?.textContent).toContain("Waiting on Windows.");
  });

  it("shows the first active step, otherwise the first pending step, and never completed work", () => {
    const container = document.createElement("div");
    const done = { step: "Done", status: "completed" as const };
    const next = { step: "Next", status: "pending" as const };
    const later = { step: "Later", status: "pending" as const };
    const renderSteps = (steps: ProgressCard["steps"]) =>
      renderCard(
        {
          row: row(),
          progressCard: { ...progressCard(), markdown: undefined, steps },
        },
        container,
      );
    renderSteps([done, next, { step: "Working", status: "in_progress" }, later]);
    expect(text(container, "plan-step")).toBe("Working");
    expect(text(container, "plan-count")).toBe("1/4");
    expect(find(container, "notepad")).toBeNull();

    renderSteps([done, next, later]);
    expect(text(container, "plan-step")).toBe("Next");
    expect(text(container, "plan-count")).toBe("1/3");

    renderSteps([done]);
    expect(find(container, "plan-row")).toBeNull();
    expect(find(container, "notepad")).toBeNull();
  });

  it.each([
    { hasCreator: true, participantCount: 7, summary: "Alice Baker & 5 others" },
    { hasCreator: false, participantCount: 5, summary: "Mira & 3 others" },
  ])(
    "deduplicates attribution identities with creator: $hasCreator",
    ({ hasCreator, participantCount, summary }) => {
      const session = row();
      const participants: NonNullable<SidebarRecentSession["participants"]> = [
        participant("self", "You"),
        participant("mira", "Mira"),
        participant("riley", "Riley"),
      ];
      if (hasCreator) {
        participants.unshift(participant("alice", "Alice Baker"));
        participants.push(participant("mira", "Mira duplicate"));
      }
      const container = renderCard({
        selfUserId: "self",
        row: row({
          createdActor: hasCreator ? session.createdActor : undefined,
          participants,
          participantCount,
        }),
      });
      expect(attributionSummary(container)).toBe(summary);
      if (hasCreator) {
        expect(find(container, "attribution")?.getAttribute("aria-label")).toBe(
          "Alice Baker, 5 more participants",
        );
      }
    },
  );

  it.each([true, false])(
    "renders authoritative participant projections (expanded: %s)",
    async (expanded) => {
      const container = document.body.appendChild(document.createElement("div"));
      const navigate = vi.fn();
      const participants: NonNullable<SidebarRecentSession["participants"]> = [
        participant("mira", "Mira"),
        participant("riley", "Riley"),
        participant("sam", "Sam"),
        participant("lee", "Lee"),
      ];
      const self: (typeof participants)[number] = {
        identity: { type: "profile", id: "self" },
        label: "You",
      };
      renderCard(
        {
          selfUserId: "self",
          row: row({
            participants: expanded ? [self, ...participants.slice(0, 3)] : participants,
            expandedParticipants: expanded ? [self, ...participants] : undefined,
            participantCount: 5,
          }),
          personActivity: expanded ? { basePath: "", navigate } : undefined,
        },
        container,
      );

      const facepile = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-viewer-facepile",
      );
      await facepile?.updateComplete;
      if (!expanded) {
        expect(
          facepile?.querySelectorAll(".viewer-avatar:not(.viewer-avatar--overflow)"),
        ).toHaveLength(4);
        expect(facepile?.querySelector(".viewer-avatar--overflow")?.textContent).toBe("+1");
        return;
      }
      expect(attributionSummary(container)).toBe("Alice Baker & 4 others");
      const participantLinks = [
        ...container.querySelectorAll<HTMLAnchorElement>("openclaw-viewer-facepile a"),
      ];
      expect(participantLinks.map((link) => link.getAttribute("href"))).toEqual([
        "/activity/mira",
        "/activity/riley",
        "/activity/sam",
        "/activity/lee",
      ]);

      const participantsTooltip = container.querySelector<
        HTMLElement & { updateComplete: Promise<boolean> }
      >("openclaw-tooltip.session-hovercard__participants-tooltip");
      await participantsTooltip?.updateComplete;
      expect(participantsTooltip?.hasAttribute("open-on-click")).toBe(true);
      const participantTrigger = participantsTooltip?.querySelector<HTMLButtonElement>(
        ".session-hovercard__attribution-others",
      );
      const touchDown = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(touchDown, "pointerType", { value: "touch" });
      participantTrigger?.dispatchEvent(touchDown);
      participantTrigger?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      participantTrigger?.click();
      await participantsTooltip?.updateComplete;
      expect(participantsTooltip?.hasAttribute("open")).toBe(true);
      expect(participantTrigger?.textContent).toContain("4 others");
      expect(
        [
          ...(participantsTooltip?.querySelectorAll<HTMLAnchorElement>(
            ".session-hovercard__participant-link",
          ) ?? []),
        ].map((link) => link.getAttribute("href")),
      ).toEqual(["/activity/mira", "/activity/riley", "/activity/sam", "/activity/lee"]);

      participantLinks[1]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(navigate).toHaveBeenCalledWith("riley", "Riley");

      participantsTooltip
        ?.querySelector<HTMLAnchorElement>('.session-hovercard__participant-link[href$="lee"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(navigate).toHaveBeenLastCalledWith("lee", "Lee");
    },
  );

  it("retains an open participant menu and focused attribution while progress and PR facts refresh", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const input: SessionHovercardInput = {
      row: row({
        participants: [participant("mira", "Mira")],
        participantCount: 1,
      }),
      personActivity: { basePath: "", navigate: vi.fn() },
      progressCard: progressCard(),
    };
    renderCard(input, container);
    const tooltip = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-tooltip.session-hovercard__participants-tooltip",
    )!;
    await tooltip.updateComplete;
    const trigger = tooltip.querySelector<HTMLButtonElement>(
      ".session-hovercard__attribution-others",
    )!;
    const pointer = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointer, "pointerType", { value: "touch" });
    trigger.dispatchEvent(pointer);
    trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    trigger.click();
    await tooltip.updateComplete;
    expect(tooltip.hasAttribute("open")).toBe(true);
    const name = find<HTMLAnchorElement>(container, "attribution-name")!;
    const markdown = container.querySelector(".session-progress-card__markdown")!;
    trigger.focus();

    renderCard(
      {
        ...input,
        row: { ...input.row!, label: "Refreshed session" },
        progressCard: { ...progressCard(), markdown: "**Updated** release notes." },
        pullRequests: snapshot({ status: "unavailable" }),
      },
      container,
    );
    await tooltip.updateComplete;
    expect(find(container, "participants-tooltip")).toBe(tooltip);
    expect(find(tooltip, "attribution-others")).toBe(trigger);
    expect(tooltip.hasAttribute("open")).toBe(true);
    expect(find(container, "attribution-name")).toBe(name);
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector(".session-progress-card__markdown")).toBe(markdown);
    expect(markdown.textContent).toContain("Updated release notes.");
    expect(text(container, "title")).toBe("Refreshed session");
    renderCard({}, container);
    expect(container.childElementCount).toBe(0);
  });
});
