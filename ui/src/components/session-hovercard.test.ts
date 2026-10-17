/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent, createSignal, merge } from "solid-js";
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
    createdActor: actor("alice", "Alice Baker"),
    children: [],
    ...overrides,
  } as SidebarRecentSession;
}

function snapshot(
  overrides: Partial<ControlUiSessionPullRequestSnapshot> = {},
): ControlUiSessionPullRequestSnapshot {
  return { status: "ready", pullRequests: [], rateLimited: false, ...overrides };
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

const participant = (id: string, label: string) => ({
  identity: { type: "profile" as const, id },
  label,
});
const actor = (id: string, label: string) => ({
  type: "human" as const,
  id,
  ...participant(id, label),
});
const automation = (href: string, navigate = vi.fn()) => ({
  gateway: null,
  sessionKey: "agent:main:work",
  agentId: "main",
  href,
  navigate,
});
function click(element: Element | null | undefined, options: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
  element?.dispatchEvent(event);
  return event;
}
function pullRequest(
  number: number,
  title: string,
  state: ControlUiSessionPullRequest["state"],
  extra: Partial<ControlUiSessionPullRequest> = {},
): ControlUiSessionPullRequest {
  return {
    number,
    title,
    state,
    owner: "openclaw",
    repo: "openclaw",
    branch: "feature",
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    ...extra,
  };
}
async function openParticipants(container: HTMLElement) {
  const tooltip = container.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>(
    "openclaw-tooltip.session-hovercard__participants-tooltip",
  )!;
  await tooltip.updateComplete;
  const trigger = find<HTMLButtonElement>(tooltip, "attribution-others")!;
  const pointer = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperty(pointer, "pointerType", { value: "touch" });
  trigger.dispatchEvent(pointer);
  trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  trigger.click();
  await tooltip.updateComplete;
  expect(tooltip.hasAttribute("open")).toBe(true);
  return { tooltip, trigger };
}

const updateCards = new WeakMap<HTMLElement, (input: SessionHovercardInput) => void>();
type CardInput = Omit<SessionHovercardInput, "row"> & { row?: Partial<SidebarRecentSession> };

function renderCard(options: CardInput, container = document.createElement("div")) {
  const input = { ...options, row: options.row && row(options.row) };
  const update = updateCards.get(container);
  if (update) {
    update(input);
  } else {
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(input);
        updateCards.set(container, (next) => setCurrent(next));
        return createComponent(SessionHovercard, merge(current));
      },
      { container },
    );
  }
  flush();
  return container;
}
function renderProgress(
  rowOverrides: Partial<SidebarRecentSession> = {},
  card: Partial<ProgressCard> = {},
  container?: HTMLElement,
) {
  return renderCard({ row: rowOverrides, progressCard: progressCard(card) }, container);
}

function find<T extends Element = HTMLElement>(container: ParentNode, suffix: string) {
  return container.querySelector<T>(`.session-hovercard__${suffix}`);
}
function text(container: ParentNode, suffix: string) {
  return find(container, suffix)?.textContent;
}
function expectTexts(container: ParentNode, values: Record<string, string>) {
  for (const [suffix, value] of Object.entries(values)) {
    expect(text(container, suffix), suffix).toBe(value);
  }
}
function expectAbsent(container: ParentNode, ...suffixes: string[]) {
  expect(
    container.querySelector(suffixes.map((suffix) => `.session-hovercard__${suffix}`).join(",")),
  ).toBeNull();
}

function hrefs(container: ParentNode, selector: string) {
  return [...container.querySelectorAll(selector)].map((link) => link.getAttribute("href"));
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
      const container = renderProgress(failed);
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
      renderCard({ row: { attention: { kind: "none" } } }, container);
      expect(find(container, "error")).toBeNull();
    },
  );

  it.each([true, false])("renders channel identity (group: %s)", (group) => {
    const container = renderCard({
      row: {
        workContext: undefined,
        label: group ? "Weekend plans" : "Alex",
        createdActor: group ? { type: "human", id: "cli", label: "CLI" } : undefined,
        participants: group ? [participant("alice", "Alice")] : undefined,
        participantCount: group ? 1 : undefined,
        channelPresentation: {
          channel: group ? "whatsapp" : "imessage",
          channelLabel: group ? "WhatsApp" : "iMessage",
          kind: group ? "group" : "direct",
          ...(group
            ? { conversation: "Weekend plans", account: "personal" }
            : { address: "alex@example.com" }),
        },
      },
    });
    const contributors = container.querySelector('[aria-label="In this session"]');
    if (group) {
      const header = find(container, "header");
      for (const fact of ["Linked to WhatsApp", "Group chat", "Via personal"]) {
        expect(header?.textContent).toContain(fact);
      }
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
  });

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
        row: { placementProviderId: "machine0", placementProfileId: "team", placementMachine },
      });
      const machine = find(container, "machine");
      if (summary) {
        expect(machine?.getAttribute("aria-label")).toBe(`Machine: ${summary}`);
        expect(
          [...container.querySelectorAll(".session-hovercard__machine span")]
            .map((item) => item.textContent)
            .join(" · "),
        ).toBe(summary);
        expect(machine?.querySelector(".session-hovercard__machine-class")?.textContent).toBe(
          placementMachine?.class,
        );
      } else {
        expect(machine).toBeNull();
      }
    },
  );

  it.each(["purple", undefined])("reflects the session color %s without unset chrome", (color) => {
    const container = renderCard({ row: { color } });
    const dot = container.querySelector(".session-color-dot");
    if (color === "purple") {
      expect(dot?.getAttribute("aria-label")).toBe("Session color: Purple");
      expect(dot?.getAttribute("style")).toContain("--session-color-purple");
    } else {
      expect(dot).toBeNull();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("renders board and automation facts without other metadata", () => {
    const container = renderCard({
      row: {
        createdActor: undefined,
        workContext: undefined,
        boardFace: "dashboard",
        hasAutomation: true,
      },
      automationLink: automation("/automations?session=agent%3Amain%3Awork&agent=main"),
    });
    expect(
      [...container.querySelectorAll(".session-hovercard__context-row")].map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["Opens as dashboard", "Automation attached"]);
    expect(find(container, "section--metadata")).not.toBeNull();
    expect(container.querySelectorAll("a.session-hovercard__automation-link")).toHaveLength(1);
  });

  it("opens attached automations without hijacking modified clicks", () => {
    const navigate = vi.fn();
    const href = "/control/automations?session=agent%3Aops%3Anight+watch&agent=ops";
    const container = renderCard({
      row: { hasAutomation: true },
      automationLink: {
        ...automation(href, navigate),
        sessionKey: "agent:ops:night watch",
        agentId: "ops",
      },
    });
    const link = find<HTMLAnchorElement>(container, "automation-link")!;
    expect(link?.getAttribute("href")).toBe(href);
    expect(click(link, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(click(link).defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    click(find(container, "automation-open"));
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
      renderCard({ row: { channelAvatarUrl }, avatarAuth: { authTokens, authReady } }, container);

      const avatar = container.querySelector<HTMLElementTagNameMap["openclaw-channel-avatar"]>(
        "openclaw-channel-avatar.session-hovercard__creator-avatar",
      )!;
      expect(avatar).toMatchObject({ routeUrl: channelAvatarUrl, authTokens, authReady });
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
            row: {
              channelAvatarUrl,
              createdActor: actor("charlie", "Charlie Delta"),
            },
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

  it("orders PRs and preserves identity, checks, and diff facts", () => {
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
    const first = links[0]!;
    expect(first).toMatchObject({
      href: "https://github.com/openclaw/openclaw/pull/101",
      target: "_blank",
      rel: expect.stringContaining("noopener"),
    });
    expectTexts(first, {
      "pr-title": "First",
      "pr-number": "openclaw/openclaw#101",
      additions: "+7",
      deletions: "−3",
      "pr-checks": "CI checks passing",
    });
    expect(find(first, "pr-title")?.getAttribute("title")).toBeNull();
    expectAbsent(first, "pr-author", "files");
    expect(find(first, "pr-state-icon")?.getAttribute("title")).toBe("Open · CI checks passing");
    expect(find(first, "pr-state-icon svg")).not.toBeNull();
    expect(first.getAttribute("aria-label")).toContain("First");
    expect(first.getAttribute("aria-label")).not.toContain("Opened by");
    expect(first.getAttribute("aria-label")).not.toContain("files");
    expect(links.map((link) => link.dataset.state)).toEqual(["open", "draft", "merged"]);
    expect(container.querySelector("details")).toBeNull();
    expect(find(container, "section--header")).toBeNull();
  });

  it.each(["rate-limited", "unavailable"] as const)(
    "shows and clears %s warnings with retained GitHub work",
    (status) => {
      const container = document.createElement("div");
      const branch = { owner: "openclaw", repo: "openclaw", branch: "feature" };
      const retained = pullRequest(101, "Retained pull request", "open");
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
      kind: "project",
      name: "project",
      path: "https://github.com/example/project",
      branch: "feature/ui",
    },
    {
      kind: "project",
      name: "project",
      path: "/repo/project",
      cwd: "/work/project",
      branch: "feature/ui",
    },
    { kind: "workspace", name: "release-notes", path: "/workspaces/release-notes" },
    undefined,
  ] satisfies SidebarRecentSession["workContext"][])(
    "renders authoritative context %j",
    (workContext) => {
      const container = renderCard({ row: { subtitle: "macbook", workContext } });
      if (!workContext) {
        expectAbsent(container, "section--metadata", "context-text");
        return;
      }
      const prefix = workContext.kind === "project" ? "Project" : "Workspace";
      const label = `${prefix}: ${workContext.name}`;
      const directory = workContext.kind === "project" ? workContext.cwd : undefined;
      const title = `${prefix}: ${directory ?? workContext.path}`;
      const context = container.querySelector(`[aria-label="${label}"]`);
      expect(context?.getAttribute("title")).toBe(title);
      if (workContext.kind === "project") {
        expect(
          container.querySelector('[aria-label="Branch: feature/ui"]')?.hasAttribute("title"),
        ).toBe(Boolean(directory));
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
    expectTexts(container, {
      additions: `+${branch.additions}`,
      deletions: `−${branch.deletions}`,
    });
    const createLink = find<HTMLAnchorElement>(container, "branch-action");
    if (branch.createUrl) {
      expect(find(container, "files")).toBeNull();
      expect(createLink).toMatchObject({
        textContent: "Create PR",
        href: branch.createUrl,
        title: "Create a pull request for feature",
      });
    } else {
      expect(createLink).toBeNull();
      expect(text(container, "branch-label")).toBe("Changes");
    }
  });

  it("renders the latest turn as plain text when progress is absent", () => {
    const container = renderCard({
      row: { lastMessagePreview: "  Finished <strong>without markup</strong>.  " },
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
        row: {
          ...(mode === "active" ? { lastMessagePreview: "This must not appear." } : {}),
          ...(mode === "completed" ? { status: "done" } : {}),
        },
        progressCard: { ...card, steps: mode === "markdown-only" ? undefined : card.steps },
      });

      const plan = find(container, "plan-row");
      if (mode === "active") {
        expectTexts(plan!, { "plan-step": "Verify", "plan-count": "0/1" });
        expect(plan?.querySelector(".session-run-spinner")).not.toBeNull();
      } else {
        expect(plan).toBeNull();
      }
      const notepad = find(container, "notepad");
      expectTexts(notepad!, { "notepad-title": "Agent Notepad" });
      expect(notepad?.querySelector("strong")?.textContent).toBe("Release");
      expect(container.querySelector(".session-progress-card,time")).toBeNull();
      expect(find(container, "excerpt")).toBeNull();
      expect(container.textContent).not.toContain("This must not appear.");
    },
  );

  it.each([
    [true, -1, "running"],
    [false, 1, "running"],
    [true, -1, "done"],
  ] as const)(
    "pauses unfinished progress (active=%s, age=%s, status=%s)",
    (hasActiveRun, updateOffset, status) => {
      const startedAt = Date.now();
      const container = renderProgress(
        { startedAt, status, hasActiveRun },
        { updatedAt: startedAt + updateOffset },
      );

      const plan = find(container, "plan-row");
      expect(plan?.getAttribute("aria-label")).toBe("Verify, paused");
      expect(plan?.querySelector(".session-run-spinner")).toBeNull();
      expect(plan?.querySelector("polyline")).not.toBeNull();
    },
  );

  it("promotes labeled progress above the notepad", () => {
    const container = renderProgress(
      {},
      {
        markdown:
          '**Build is healthy.**\n\n<progress aria-label="CI · 4/6" value="4" max="6"></progress>\n\nWaiting on Windows.',
      },
    );

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

  it("prefers active, then pending steps, and hides completed work", () => {
    const done = { step: "Done", status: "completed" } as const;
    const next = { step: "Next", status: "pending" } as const;
    const working = { step: "Working", status: "in_progress" } as const;
    const later = { step: "Later", status: "pending" } as const;
    const container = document.createElement("div");
    const showSteps = (steps: ProgressCard["steps"]) =>
      renderProgress({}, { markdown: undefined, steps }, container);
    showSteps([done, next, working, later]);
    expectTexts(container, { "plan-step": "Working", "plan-count": "1/4" });
    expect(find(container, "notepad")).toBeNull();
    showSteps([done, next, later]);
    expectTexts(container, { "plan-step": "Next", "plan-count": "1/3" });
    showSteps([done]);
    expectAbsent(container, "plan-row", "notepad");
  });

  it.each([
    { hasCreator: true, participantCount: 7, summary: "Alice Baker & 5 others" },
    { hasCreator: false, participantCount: 5, summary: "Mira & 3 others" },
  ])(
    "deduplicates attribution identities with creator: $hasCreator",
    ({ hasCreator, participantCount, summary }) => {
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
        row: {
          ...(hasCreator ? {} : { createdActor: undefined }),
          participants,
          participantCount,
        },
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
      const participants = ["Mira", "Riley", "Sam", "Lee"].map((label) =>
        participant(label.toLowerCase(), label),
      );
      const self = participant("self", "You");
      renderCard(
        {
          selfUserId: "self",
          row: {
            participants: expanded ? [self, ...participants.slice(0, 3)] : participants,
            expandedParticipants: expanded ? [self, ...participants] : undefined,
            participantCount: 5,
          },
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
      const expectedLinks = ["/activity/mira", "/activity/riley", "/activity/sam", "/activity/lee"];
      expect(participantLinks.map((link) => link.getAttribute("href"))).toEqual(expectedLinks);

      const { tooltip: participantsTooltip, trigger: participantTrigger } =
        await openParticipants(container);
      expect(participantsTooltip?.hasAttribute("open-on-click")).toBe(true);
      expect(participantTrigger?.textContent).toContain("4 others");
      expect(hrefs(participantsTooltip, ".session-hovercard__participant-link")).toEqual(
        expectedLinks,
      );

      click(participantLinks[1]);
      expect(navigate).toHaveBeenCalledWith("riley", "Riley");

      click(find(participantsTooltip, 'participant-link[href$="lee"]'));
      expect(navigate).toHaveBeenLastCalledWith("lee", "Lee");
    },
  );

  it("preserves participant menu identity and focus across refresh", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const input: CardInput = {
      row: { participants: [participant("mira", "Mira")], participantCount: 1 },
      personActivity: { basePath: "", navigate: vi.fn() },
      progressCard: progressCard(),
    };
    renderCard(input, container);
    const { tooltip, trigger } = await openParticipants(container);
    const name = find<HTMLAnchorElement>(container, "attribution-name")!;
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
