/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent, createSignal, merge } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { createCronJob, cronJobsListResponse } from "../lib/cron/cron.test-support.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type {
  SidebarRecentSession,
  SidebarSessionHovercardRow,
} from "./app-sidebar-session-types.ts";
import {
  SessionHovercardAutomations,
  type SessionHovercardAutomation,
} from "./session-hovercard-automations.tsx";
import { SessionHovercard, type SessionHovercardInput } from "./session-hovercard-solid.tsx";

function sessionRow(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
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

function progressCard(overrides: Partial<ProgressCard> = {}): ProgressCard {
  return {
    sessionKey: "agent:main:work",
    revision: 1,
    updatedAt: Date.now(),
    markdown: "**Release** is ready.",
    steps: [{ step: "Verify", status: "in_progress" }],
    ...overrides,
  };
}

const updateCards = new WeakMap<HTMLElement, (input: SessionHovercardInput) => void>();
const unmountCards = new WeakMap<HTMLElement, () => void>();

function renderCard(input: SessionHovercardInput, container = document.createElement("div")) {
  const update = updateCards.get(container);
  if (update) {
    update(input);
  } else {
    const view = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(input);
        updateCards.set(container, (next) => setCurrent(next));
        return createComponent(SessionHovercard, merge(current));
      },
      { container },
    );
    unmountCards.set(container, view.unmount);
  }
  flush();
  return container;
}

function cardPart<T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  suffix: string,
) {
  return root?.querySelector<T>(`.session-hovercard__${suffix}`);
}
function cardText(root: ParentNode | null | undefined, suffix: string) {
  return cardPart(root, suffix)?.textContent;
}

function attributionSummary(container: ParentNode): string {
  return [cardText(container, "attribution-name"), cardText(container, "attribution-others")]
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
      const failed = sessionRow({
        attention: { kind: "error", reason, childLabel, sourceSessionKey: "agent:main:failed" },
      });
      const container = renderCard({ row: failed, progressCard: progressCard() });
      const error = cardPart(container, "error");
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
      expect(cardText(container, "error")).toContain(reason);
      expect(cardPart(container, "notepad")).toBeNull();
      renderCard({ row: sessionRow({ attention: { kind: "none" } }) }, container);
      expect(cardPart(container, "error")).toBeNull();
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
      const container = renderCard({ row: sessionRow({ workContext: undefined, ...facts }) });
      const contributors = container.querySelector('[aria-label="In this session"]');
      if (facts.channelPresentation.kind === "group") {
        const header = cardPart(container, "header");
        expect(header?.textContent).toContain("Linked to WhatsApp");
        expect(header?.textContent).toContain("Group chat");
        expect(header?.textContent).toContain("Via personal");
        expect(header?.textContent?.match(/Weekend plans/g)).toHaveLength(1);
        expect(header?.textContent).not.toContain("CLI");
        expect(contributors?.textContent).toContain("CLI");
        expect(contributors?.textContent).toContain("1 other");
        expect(container.textContent).not.toContain("members");
      } else {
        expect(cardText(container, "conversation")).toContain("alex@example.com");
        expect(cardPart(container, "conversation a")).toBeNull();
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
        row: sessionRow({
          placementProviderId: "machine0",
          placementProfileId: "team",
          placementMachine,
        }),
      });
      const machine = cardPart(container, "machine");
      if (summary) {
        expect(machine?.getAttribute("aria-label")).toBe(`Machine: ${summary}`);
        expect(
          [...container.querySelectorAll(".session-hovercard__machine span")]
            .map((item) => item.textContent)
            .join(" · "),
        ).toBe(summary);
        expect(cardText(machine, "machine-class")).toBe(placementMachine?.class);
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

  it("opens attached automations without hijacking modified clicks", () => {
    const navigate = vi.fn();
    const href = "/control/automations?session=agent%3Aops%3Anight+watch&agent=ops";
    const container = renderCard({
      row: sessionRow({ hasAutomation: true }),
      automationLink: {
        href,
        navigate,
        gateway: null,
        sessionKey: "agent:ops:night watch",
        agentId: "ops",
      },
    });
    const link = cardPart<HTMLAnchorElement>(container, "automation-link")!;
    expect(link?.getAttribute("href")).toBe(href);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    const open = cardPart<HTMLAnchorElement>(container, "automation-open")!;
    open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith();
  });

  it("updates the retained channel-avatar fallback before authentication is ready", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const channelAvatarUrl = "/__openclaw__/channel-avatar/pending";
    const avatarAuth = { authTokens: [], authReady: false };
    renderCard({ row: sessionRow({ channelAvatarUrl }), avatarAuth }, container);
    const avatar = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-channel-avatar.session-hovercard__creator-avatar",
    );
    expect(container.querySelector("openclaw-viewer-avatar")).toBeNull();
    await customElements.whenDefined("openclaw-channel-avatar");
    await avatar?.updateComplete;
    await vi.waitFor(() => expect(cardText(avatar, "creator-avatar-fallback")).toBe("AB"));
    expect(avatar?.querySelector("img.channel-avatar")).toBeNull();
    renderCard(
      {
        row: sessionRow({
          channelAvatarUrl,
          createdActor: {
            type: "human",
            id: "charlie",
            identity: { type: "profile", id: "charlie" },
            label: "Charlie Delta",
          },
        }),
        avatarAuth,
      },
      container,
    );
    await avatar?.updateComplete;
    expect(container.querySelector("openclaw-channel-avatar")).toBe(avatar);
    expect(cardText(avatar, "creator-avatar-fallback")).toBe("CD");
  });

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
    const link = cardPart<HTMLAnchorElement>(container, "pr-row");
    expect(link?.href).toBe(task.url);
    expect(link?.dataset.state).toBeUndefined();
    expect(link?.textContent).toContain("Status unavailable");
    expect(link?.textContent).toContain("Task branch: fix/child");
    expect(cardPart<HTMLAnchorElement>(container, "branch-action")?.href).toBe(branch.createUrl);
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
    expect(cardText(container, "pr-count")).toBe("31");
    expect(cardText(container, "more")).toContain("29 more");
    // The branch PR can also belong to receipts outside the bounded task preview.
    renderCard({ pullRequests: snapshot({ ...bounded, pullRequestCount: 30 }) }, container);
    expect(cardText(container, "pr-count")).toBe("30");
    expect(container.querySelectorAll(".session-hovercard__pr-row")).toHaveLength(2);
    expect(cardText(container, "more")).toContain("28 more");
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
    expect(cardPart(container, "pr-row")?.getAttribute("data-state")).toBe("merged");
  });

  it("orders active PRs first and keeps external links detached", () => {
    const container = renderCard({
      pullRequests: snapshot({
        pullRequests: [
          pullRequest(103, "Third", "merged"),
          pullRequest(102, "Second", "draft"),
          pullRequest(101, "First"),
        ],
      }),
    });
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")];
    expect(links.map((link) => link.dataset.state)).toEqual(["open", "draft", "merged"]);
    expect(links[0]).toMatchObject({
      href: "https://github.com/openclaw/openclaw/pull/101",
      target: "_blank",
      rel: expect.stringContaining("noopener"),
    });
    expect(links[0]?.getAttribute("aria-label")).toContain("First");
    expect(links[0]?.getAttribute("aria-label")).not.toMatch(/Opened by|files/);
    expect(container.querySelector("details")).toBeNull();
    expect(cardPart(container, "section--header")).toBeNull();
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
      expect(cardPart<HTMLAnchorElement>(container, "pr-row")?.href).toBe(retained.url);
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
      const container = renderCard({ row: sessionRow({ subtitle: "macbook", workContext }) });
      if (!workContext) {
        expect(cardPart(container, "section--metadata")).toBeNull();
        expect(cardPart(container, "context-text")).toBeNull();
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
        ? sessionRow({ workSession: true, subtitle: "openclaw/openclaw · feature" })
        : undefined,
      pullRequests: snapshot({ branch: { owner: "openclaw", repo: "openclaw", ...branch } }),
    });
    expect(cardPart(container, "branch-name")).toBeNull();
    expect(cardText(container, "additions")).toBe(`+${branch.additions}`);
    expect(cardText(container, "deletions")).toBe(`−${branch.deletions}`);
    const createLink = cardPart<HTMLAnchorElement>(container, "branch-action");
    if (branch.createUrl) {
      expect(cardPart(container, "files")).toBeNull();
      expect(createLink?.textContent).toBe("Create PR");
      expect(createLink?.href).toBe(branch.createUrl);
      expect(createLink?.title).toBe("Create a pull request for feature");
    } else {
      expect(createLink).toBeNull();
      expect(cardText(container, "branch-label")).toBe("Changes");
    }
  });

  it.each(["active", "markdown-only", "completed"])(
    "keeps Agent Notepad separate from %s plan metadata",
    (mode) => {
      const card = progressCard({
        markdown:
          '**Release** is ready.\n\n<progress aria-label="CI · 4/6" value="4" max="6"></progress>\n\nWaiting on Windows.',
      });
      const container = renderCard({
        row: sessionRow({
          ...(mode === "active" ? { lastMessagePreview: "This must not appear." } : {}),
          ...(mode === "completed" ? { status: "done" } : {}),
        }),
        progressCard: { ...card, steps: mode === "markdown-only" ? undefined : card.steps },
      });

      const plan = cardPart(container, "plan-row");
      if (mode === "active") {
        expect(cardText(plan, "plan-step")).toBe("Verify");
        expect(cardText(plan, "plan-count")).toBe("0/1");
        expect(plan?.querySelector(".session-run-spinner")).not.toBeNull();
        const markdown = container.querySelector(".session-progress-card__markdown");
        expect(
          markdown?.firstElementChild?.classList.contains("session-progress-card__progress"),
        ).toBe(true);
        expect(markdown?.querySelector(".session-progress-card__progress-label")?.textContent).toBe(
          "CI · 4/6",
        );
        expect(markdown?.querySelector("progress")?.getAttribute("value")).toBe("4");
        expect(markdown?.textContent).toContain("Release is ready.");
        expect(markdown?.textContent).toContain("Waiting on Windows.");
      } else {
        expect(plan).toBeNull();
      }
      const notepad = cardPart(container, "notepad");
      expect(notepad).not.toBeNull();
      expect(cardText(notepad, "notepad-title")).toBe("Agent Notepad");
      expect(notepad?.querySelector("strong")?.textContent).toBe("Release");
      expect(container.querySelector(".session-progress-card")).toBeNull();
      expect(container.querySelector("time")).toBeNull();
      expect(cardPart(container, "excerpt")).toBeNull();
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
      row: sessionRow({ startedAt, status, hasActiveRun }),
      progressCard: progressCard({ updatedAt: startedAt + updateOffset }),
    });

    const plan = cardPart(container, "plan-row");
    expect(plan?.getAttribute("aria-label")).toBe("Verify, paused");
    expect(plan?.querySelector(".session-run-spinner")).toBeNull();
    expect(plan?.querySelector("polyline")).not.toBeNull();
  });

  it("shows the first active step, otherwise the first pending step, and never completed work", () => {
    const container = document.createElement("div");
    const done = { step: "Done", status: "completed" as const };
    const next = { step: "Next", status: "pending" as const };
    const later = { step: "Later", status: "pending" as const };
    const renderSteps = (steps: ProgressCard["steps"]) =>
      renderCard(
        {
          row: sessionRow(),
          progressCard: progressCard({ markdown: undefined, steps }),
        },
        container,
      );
    renderSteps([done, next, { step: "Working", status: "in_progress" }, later]);
    expect(cardText(container, "plan-step")).toBe("Working");
    expect(cardText(container, "plan-count")).toBe("1/4");
    expect(cardPart(container, "notepad")).toBeNull();

    renderSteps([done, next, later]);
    expect(cardText(container, "plan-step")).toBe("Next");
    expect(cardText(container, "plan-count")).toBe("1/3");

    renderSteps([done]);
    expect(cardPart(container, "plan-row")).toBeNull();
    expect(cardPart(container, "notepad")).toBeNull();
  });

  it.each([
    { hasCreator: true, participantCount: 7, summary: "Alice Baker & 5 others" },
    { hasCreator: false, participantCount: 5, summary: "Mira & 3 others" },
  ])(
    "deduplicates attribution identities with creator: $hasCreator",
    ({ hasCreator, participantCount, summary }) => {
      const session = sessionRow();
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
        row: sessionRow({
          createdActor: hasCreator ? session.createdActor : undefined,
          participants,
          participantCount,
        }),
      });
      expect(attributionSummary(container)).toBe(summary);
      if (hasCreator) {
        expect(cardPart(container, "attribution")?.getAttribute("aria-label")).toBe(
          "Alice Baker, 5 more participants",
        );
      }
    },
  );

  it("retains an open participant menu and focused attribution while progress and PR facts refresh", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const input: SessionHovercardInput = {
      row: sessionRow({
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
    const participantLink = cardPart<HTMLAnchorElement>(tooltip, "participant-link")!;
    expect(participantLink.getAttribute("href")).toBe("/activity/mira");
    participantLink.click();
    expect(input.personActivity?.navigate).toHaveBeenCalledWith("mira", "Mira");
    const name = cardPart<HTMLAnchorElement>(container, "attribution-name")!;
    const markdown = container.querySelector(".session-progress-card__markdown")!;
    trigger.focus();

    renderCard(
      {
        ...input,
        row: { ...input.row!, label: "Refreshed session" },
        progressCard: progressCard({ markdown: "**Updated** release notes." }),
        pullRequests: snapshot({ status: "unavailable" }),
      },
      container,
    );
    await tooltip.updateComplete;
    expect(cardPart(container, "participants-tooltip")).toBe(tooltip);
    expect(cardPart(tooltip, "attribution-others")).toBe(trigger);
    expect(tooltip.hasAttribute("open")).toBe(true);
    expect(cardPart(container, "attribution-name")).toBe(name);
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector(".session-progress-card__markdown")).toBe(markdown);
    expect(markdown.textContent).toContain("Updated release notes.");
    expect(cardText(container, "title")).toBe("Refreshed session");
    renderCard({}, container);
    expect(container.childElementCount).toBe(0);
  });
});

const exampleAutomation = {
  gateway: null,
  sessionKey: "agent:main:example",
  agentId: "main",
  href: "/automations",
  navigate: () => {},
};

function mountCard(
  initial: SidebarSessionHovercardRow,
  automationLink?: SessionHovercardInput["automationLink"],
) {
  const container = renderCard({ row: initial, automationLink });
  const find = (suffix = "") => container.querySelector<HTMLElement>(`.session-hovercard${suffix}`);
  const parts = () => ({
    channel: find("__channel"),
    creator: find("__creator-avatar"),
    color: container.querySelector(".session-color-dot"),
  });
  return {
    container,
    find,
    parts,
    setRow: (row: SidebarSessionHovercardRow | undefined) =>
      renderCard({ row, automationLink }, container),
    unmount: () => unmountCards.get(container)?.(),
  };
}

it("refreshes retained hovercard labels and age without replacing its focused link", async () => {
  const restoreI18n = captureI18nStateForTesting();
  await i18n.setLocale("en");
  const row: SidebarSessionHovercardRow = {
    label: "Example session",
    hasActiveRun: false,
    hasAutomation: true,
    createdAt: Date.now() - 2 * 60 * 60_000,
    channelPresentation: { channel: "slack", channelLabel: "Slack", kind: "group" },
    workContext: { kind: "project", name: "Example", path: "/workspace/example" },
    placementProviderId: "local",
    placementProfileId: "default",
    placementMachine: { cpu: 4, memoryGb: 16 },
    attention: { kind: "error", reason: "Failure", sourceSessionKey: "agent:main:example" },
  };
  const view = mountCard(row, exampleAutomation);
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  await waitForSolid(() => expect(view.find("__automation-link")).not.toBeNull());
  const card = view.find();
  const link = view.find("__automation-link")!;
  link.focus();
  for (const [locale, channel, project, placement, age, failure] of [
    ["en", "Linked to Slack", "Project", "Runs on", "2h", "Run failed"],
    ["de", "Mit Slack verknüpft", "Projekt", "Läuft auf", "2 Std.", "Ausführung fehlgeschlagen"],
  ] as const) {
    await i18n.setLocale(locale);
    await waitForSolid(() => {
      for (const text of [channel, `${failure}: Failure`]) {
        expect(card?.textContent).toContain(text);
      }
      for (const label of [`${project}: Example`, `${placement} local · default`]) {
        expect(card?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
      }
      expect(view.find("__created-age")).toMatchObject({
        textContent: age,
        ...(locale === "de" ? { title: "vor 2 Std." } : {}),
      });
      if (locale === "en") {
        expect(view.find("__machine")?.textContent).toContain("16 GB");
      }
      expect(view.find()).toBe(card);
      expect(document.activeElement).toBe(link);
    });
  }
  const machine = view.find("__machine");
  await i18n.setLocale("fr");
  await waitForSolid(() => {
    expect(machine?.textContent).toContain("16 Go");
    expect(view.find("__machine")).toBe(machine);
    expect(document.activeElement).toBe(link);
  });
});

it("retains the header across row updates and clears optional details without stale snapshots", async () => {
  const initial: SidebarSessionHovercardRow = {
    label: "Synthetic session",
    hasActiveRun: false,
    hasAutomation: false,
    color: "blue",
    channelPresentation: { channel: "slack", channelLabel: "Slack", kind: "group" },
    createdActor: {
      type: "human",
      id: "synthetic-person",
      label: "Synthetic person",
      identity: { type: "profile", id: "synthetic-person" },
    },
  };
  const { container, find, parts, setRow } = mountCard(initial, exampleAutomation);
  const populated = { color: expect.any(Element), creator: expect.any(Element) };
  await waitForSolid(() => expect(parts()).toMatchObject(populated));
  const header = find("__header");
  setRow({ ...initial, label: "Updated synthetic session", color: "purple" });
  await waitForSolid(() => {
    expect(find("__header")).toBe(header);
    expect(header?.textContent).toContain("Updated synthetic session");
    expect(parts().color?.getAttribute("style")).toContain("--session-color-purple");
    expect(parts().color?.getAttribute("aria-label")).toBe("Session color: Purple");
  });
  setRow({
    label: "Plain synthetic session",
    lastMessagePreview: "  Finished <strong>without markup</strong>.  ",
    hasActiveRun: false,
    hasAutomation: true,
    boardFace: "dashboard",
  });
  await waitForSolid(() => {
    expect(find("__header")).toBe(header);
    expect(parts()).toEqual({ color: null, channel: null, creator: null });
    expect(cardText(container, "excerpt")).toBe("Finished <strong>without markup</strong>.");
    expect(cardPart(container, "excerpt strong")).toBeNull();
    expect(container.querySelector(".session-progress-card")).toBeNull();
    expect(
      [...container.querySelectorAll(".session-hovercard__context-row")].map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["Opens as dashboard", "Automation attached"]);
    expect(Boolean(cardPart(container, "section--metadata"))).toBe(true);
    expect(container.querySelectorAll("a.session-hovercard__automation-link")).toHaveLength(1);
  });
  setRow(undefined);
  await waitForSolid(() => expect(find()).toBeNull());
  setRow(initial);
  await waitForSolid(() => {
    expect(find("__header")?.textContent).toContain("Synthetic session");
    expect(parts()).toMatchObject(populated);
  });
});

it("updates retained automation labels and schedule without reloading its jobs", async () => {
  const restoreI18n = captureI18nStateForTesting();
  await i18n.setLocale("en");
  const job = createCronJob("example", "Example automation", {
    schedule: { kind: "every", everyMs: 300_000 },
  });
  const request = createGatewayRequestMock(async () => cronJobsListResponse([job], { limit: 20 }));
  const connect = () => {
    const source = createApplicationGateway();
    source.publish({
      ...source.gateway.snapshot,
      phase: "connected",
      client: createTestGatewayClient(request),
    });
    return source;
  };
  const source = connect();
  const [automation, setAutomation] = createSignal<SessionHovercardAutomation>({
    gateway: source.gateway,
    sessionKey: "agent:main:example",
    agentId: "main",
    href: "/automations",
    navigate: () => {},
  });
  const view = mountSolid(() =>
    createComponent(
      SessionHovercardAutomations,
      merge(() => ({ automation: automation() })),
    ),
  );
  const find = (suffix: string) =>
    view.container.querySelector<HTMLElement>(`.session-hovercard__${suffix}`);
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  await waitForSolid(() => {
    expect(find("automation-name")?.textContent).toBe("Example automation");
    expect(view.container.textContent).toContain("Every 5m");
  });
  const tooltip = view.container.querySelector("openclaw-tooltip");
  const content = find("automations");
  const expectStatus = (textContent: string) =>
    expect(content?.querySelector('[role="status"]')).toMatchObject({ textContent });
  const link = find("automation-open")!;
  expect(content?.getAttribute("aria-label")).toBe("Automations");
  const trigger = find("automation-link")!;
  trigger.focus();

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(content?.getAttribute("aria-label")).toBe("Automatisierungen");
    expect(content?.textContent).toContain(
      `Every ${new Intl.NumberFormat("de", { style: "unit", unit: "minute", unitDisplay: "narrow" }).format(5)}`,
    );
    expect(trigger.closest("openclaw-tooltip")).toBe(tooltip);
    expect(content?.querySelector(".session-hovercard__automation-open")).toBe(link);
    expect(document.activeElement).toBe(trigger);
    expect(request).toHaveBeenCalledTimes(1);
  });

  source.publish({ ...source.gateway.snapshot, phase: "offline", client: null });
  await waitForSolid(() => expectStatus("Automatisierungen für diese Sitzung nicht verfügbar."));
  await i18n.setLocale("en");
  await waitForSolid(() => {
    expectStatus("Automations unavailable for this session.");
    expect(request).toHaveBeenCalledTimes(1);
  });
  setAutomation((previous) => ({ ...previous, href: "/automations?updated=1" }));
  await waitForSolid(() => {
    expect(trigger.getAttribute("href")).toBe("/automations?updated=1");
    expect(find("automations")).toBe(content);
    expect(request).toHaveBeenCalledTimes(1);
  });

  const replacement = connect();
  setAutomation((previous) => ({ ...previous, gateway: replacement.gateway }));
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(find("automation-name")?.textContent).toBe("Example automation");
  });
  source.publishEvent({ type: "event", event: "cron", payload: {} });
  expect(request).toHaveBeenCalledTimes(2);
  view.unmount();
  replacement.publishEvent({ type: "event", event: "cron", payload: {} });
  expect(request).toHaveBeenCalledTimes(2);
});
