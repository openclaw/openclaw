/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiSessionPullRequestSnapshot } from "../../../src/gateway/control-ui-contract.js";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderSessionHovercard } from "./session-hovercard.ts";

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

function progressCard(): ProgressCard {
  return {
    sessionKey: "agent:main:work",
    revision: 1,
    updatedAt: Date.now(),
    markdown: "**Release** is ready.",
    steps: [{ step: "Verify", status: "in_progress" }],
  };
}

function renderCard(
  input: Parameters<typeof renderSessionHovercard>[0],
  container = document.createElement("div"),
) {
  render(renderSessionHovercard(input), container);
  return container;
}

function attributionSummary(container: ParentNode): string {
  return [
    container.querySelector(".session-hovercard__attribution-name")?.textContent,
    container.querySelector(".session-hovercard__attribution-others")?.textContent,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("renderSessionHovercard", () => {
  it.each([undefined, "Validation worker"])(
    "shows the full failure above the notepad (child: %s)",
    (childLabel) => {
      const reason = "Validation failed.\n<worker> was unavailable; retry after reconnecting.";
      const failed = row({
        attention: { kind: "error", reason, childLabel, sourceSessionKey: "agent:main:failed" },
      });
      const container = renderCard({ row: failed, progressCard: progressCard() });
      const error = container.querySelector(".session-hovercard__error");
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
      expect(container.querySelector(".session-hovercard__error")?.textContent).toContain(reason);
      expect(container.querySelector(".session-hovercard__notepad")).toBeNull();
      renderCard({ row: row({ attention: { kind: "none" } }) }, container);
      expect(container.querySelector(".session-hovercard__error")).toBeNull();
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
        participants: [{ identity: { type: "profile", id: "alice" }, label: "Alice" }],
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
        const header = container.querySelector(".session-hovercard__header");
        expect(header?.textContent).toContain("Linked to WhatsApp");
        expect(header?.textContent).toContain("Group chat");
        expect(header?.textContent).toContain("Via personal");
        expect(header?.textContent?.match(/Weekend plans/g)).toHaveLength(1);
        expect(header?.textContent).not.toContain("CLI");
        expect(contributors?.textContent).toContain("CLI");
        expect(contributors?.textContent).toContain("1 other");
        expect(container.textContent).not.toContain("members");
      } else {
        expect(container.querySelector(".session-hovercard__conversation")?.textContent).toContain(
          "alex@example.com",
        );
        expect(container.querySelector(".session-hovercard__conversation a")).toBeNull();
        expect(contributors).toBeNull();
        expect(container.textContent).not.toContain("Via");
      }
    },
  );

  it.each<[SidebarRecentSession["placementMachine"], string, boolean?]>([
    [
      { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 },
      "Linux · medium · 4 vCPU · 16 GB",
    ],
    [{ class: "medium" }, "medium"],
    [{ os: "windows/wsl2", memoryGb: 8 }, "windows/wsl2 · 8 GB"],
    [undefined, ""],
    [{}, ""],
    [{ class: "medium" }, "", false],
  ])(
    "shows only known machine facts: %j",
    (placementMachine: SidebarRecentSession["placementMachine"], summary, hasPlacement = true) => {
      const container = renderCard({
        row: row({
          placementProviderId: hasPlacement ? "machine0" : undefined,
          placementProfileId: hasPlacement ? "team" : undefined,
          placementMachine,
        }),
      });
      const machine = container.querySelector(".session-hovercard__machine");
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

  it.each(["purple", undefined, "default"])(
    "reflects the session color %s without unset chrome",
    (color) => {
      const container = renderCard({ row: row({ color }) });
      const dot = container.querySelector(".session-color-dot");
      if (color === "purple") {
        expect(dot?.getAttribute("aria-label")).toBe("Session color: Purple");
        expect(dot?.getAttribute("style")).toContain("--session-color-purple");
      } else {
        expect(dot).toBeNull();
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

  it("renders header and session metadata without inventing optional sections", () => {
    const container = renderCard({ row: row() });

    expect(container.querySelector(".session-hovercard__title")?.textContent).toBe(
      "Ship the release",
    );
    expect(container.querySelector(".session-hovercard__created-age")?.textContent).toBe("2h");
    expect(container.querySelector(".session-hovercard__meta")).toBeNull();
    expect(container.querySelector(".session-hovercard__attribution")?.textContent).toContain(
      "Alice Baker",
    );
    expect(
      [...container.querySelectorAll(".session-hovercard__context-text")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["openclaw", "feature/session-hovercard"]);
    expect(
      container
        .querySelector('[aria-label="Branch: feature/session-hovercard"]')
        ?.getAttribute("title"),
    ).toBe("/work/openclaw");
    expect(container.textContent).not.toContain("/work/openclaw");
    expect(container.textContent).not.toContain("Worktree");
    expect(
      [...container.querySelectorAll(".session-hovercard__section")].map((section) =>
        [...section.classList].find((name) => name.startsWith("session-hovercard__section--")),
      ),
    ).toEqual(["session-hovercard__section--header", "session-hovercard__section--metadata"]);
    expect(container.querySelector(".session-progress-card")).toBeNull();
    expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
    expect(container.querySelector(".session-hovercard__attribution-name")?.tagName).toBe("SPAN");
    expect(container.querySelector(".person-activity-avatar-link")).toBeNull();
  });

  it.each([
    { name: "dashboard", facts: { boardFace: "dashboard" }, labels: ["Opens as dashboard"] },
    { name: "automation", facts: { hasAutomation: true }, labels: ["Automation attached"] },
    {
      name: "both",
      facts: { boardFace: "dashboard", hasAutomation: true },
      labels: ["Opens as dashboard", "Automation attached"],
    },
    { name: "disabled", facts: { hasAutomation: false }, labels: [] },
  ] satisfies { name: string; facts: Partial<SidebarRecentSession>; labels: string[] }[])(
    "renders $name session facts without other metadata",
    ({ facts, labels }) => {
      const container = renderCard({
        row: row({ createdActor: undefined, workContext: undefined, ...facts }),
        automationLink: {
          href: "/automations?session=agent%3Amain%3Awork&agent=main",
          navigate: vi.fn(),
        },
      });
      expect(
        [...container.querySelectorAll(".session-hovercard__context-row")].map((entry) =>
          entry.textContent?.trim(),
        ),
      ).toEqual(labels);
      expect(Boolean(container.querySelector(".session-hovercard__section--metadata"))).toBe(
        labels.length > 0,
      );
      expect(container.querySelectorAll("a.session-hovercard__automation-link").length).toBe(
        facts.hasAutomation ? 1 : 0,
      );
    },
  );

  it("opens attached automations without hijacking modified clicks", () => {
    const navigate = vi.fn();
    const href = "/control/automations?session=agent%3Aops%3Anight+watch&agent=ops";
    const container = renderCard({
      row: row({ hasAutomation: true }),
      automationLink: { href, navigate },
    });
    const link = container.querySelector<HTMLAnchorElement>(".session-hovercard__automation-link")!;
    expect(link?.getAttribute("href")).toBe(href);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
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
          expect(
            avatar?.querySelector(".session-hovercard__creator-avatar-fallback")?.textContent,
          ).toBe("AB");
        });
        expect(avatar?.querySelector("img.channel-avatar")).toBeNull();
      }
    },
  );

  it("renders one titled PR row with compact diff facts and an overflow count", () => {
    const container = renderCard({
      pullRequests: snapshot({
        pullRequests: [
          {
            number: 101,
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature",
            title: "First",
            url: "https://github.com/openclaw/openclaw/pull/101",
            state: "open",
            changedFiles: 2,
            additions: 7,
            deletions: 3,
            checks: { state: "passing", passed: 2, failed: 0, skipped: 0, running: 0 },
          },
          {
            number: 102,
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature",
            title: "Second",
            url: "https://github.com/openclaw/openclaw/pull/102",
            state: "draft",
          },
          {
            number: 103,
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature",
            title: "Third",
            url: "https://github.com/openclaw/openclaw/pull/103",
            state: "merged",
          },
        ],
      }),
    });

    const links = [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")];
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://github.com/openclaw/openclaw/pull/101");
    expect(links[0]?.target).toBe("_blank");
    expect(links[0]?.rel).toContain("noopener");
    expect(links[0]?.querySelector(".session-hovercard__pr-title")?.textContent).toBe("First");
    expect(
      links[0]?.querySelector(".session-hovercard__pr-title")?.getAttribute("title"),
    ).toBeNull();
    expect(links[0]?.querySelector(".session-hovercard__pr-number")).toBeNull();
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
    expect(container.querySelector(".session-hovercard__more")?.textContent).toBe("+2 more");
    expect(container.querySelector(".session-hovercard__section--header")).toBeNull();
  });

  it.each(["rate-limited", "unavailable"] as const)(
    "explains %s GitHub lookups with or without retained work and clears the warning after recovery",
    (status) => {
      const container = document.createElement("div");
      const branch = { owner: "openclaw", repo: "openclaw", branch: "feature" };
      const pullRequest = {
        ...branch,
        number: 101,
        title: "Retained pull request",
        url: "https://github.com/openclaw/openclaw/pull/101",
        state: "open" as const,
      };
      for (const work of [{}, { branch }, { pullRequests: [pullRequest] }]) {
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
      expect(container.querySelector<HTMLAnchorElement>(".session-hovercard__pr-row")?.href).toBe(
        pullRequest.url,
      );
      renderCard({ pullRequests: snapshot({ pullRequests: [pullRequest] }) }, container);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).toContain(pullRequest.title);
    },
  );

  it("shows an accepted issue through refresh failure without inventing a pull request", () => {
    const container = document.createElement("div");
    const issue = { number: 17400, url: "https://fixture.ghe.com/example/project/issues/17400" };
    render(
      renderSessionHovercard({
        row: row(),
        pullRequests: snapshot({ issues: [issue], status: "unavailable" }),
      }),
      container,
    );
    const link = container.querySelector<HTMLAnchorElement>(".session-hovercard__issue-row");
    expect(link?.href).toBe(issue.url);
    expect(link?.textContent).toContain("17400");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(container.textContent).toContain("could not be refreshed");
    expect(
      container.querySelectorAll(".session-hovercard__pr-row:not(.session-hovercard__issue-row)"),
    ).toHaveLength(0);
    const pull = {
      number: 42,
      title: "Actual associated pull request",
      url: "https://fixture.ghe.com/example/project/pull/42",
      owner: "example",
      repo: "project",
      branch: "accepted-work",
      state: "open" as const,
    };
    render(
      renderSessionHovercard({
        row: row(),
        pullRequests: snapshot({ issues: [issue], pullRequests: [pull], status: "unavailable" }),
      }),
      container,
    );
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>(".session-hovercard__pr-row")].map(
        (anchor) => anchor.href,
      ),
    ).toEqual([issue.url, pull.url]);
  });

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
        expect(container.querySelector(".session-hovercard__section--metadata")).toBeNull();
        expect(container.querySelector(".session-hovercard__context-text")).toBeNull();
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
    expect(container.querySelector(".session-hovercard__branch-name")).toBeNull();
    expect(container.querySelector(".session-hovercard__additions")?.textContent).toBe(
      `+${branch.additions}`,
    );
    expect(container.querySelector(".session-hovercard__deletions")?.textContent).toBe(
      `−${branch.deletions}`,
    );
    const createLink = container.querySelector<HTMLAnchorElement>(
      ".session-hovercard__branch-action",
    );
    if (branch.createUrl) {
      expect(container.querySelector(".session-hovercard__files")).toBeNull();
      expect(createLink?.textContent).toBe("Create PR");
      expect(createLink?.href).toBe(branch.createUrl);
      expect(createLink?.title).toBe("Create a pull request for feature");
    } else {
      expect(createLink).toBeNull();
      expect(container.querySelector(".session-hovercard__branch-label")?.textContent).toBe(
        "Changes",
      );
    }
  });

  it("renders the latest turn as plain text when progress is absent", () => {
    const container = renderCard({
      row: row({ lastMessagePreview: "  Finished <strong>without markup</strong>.  " }),
    });

    expect(container.querySelector(".session-hovercard__excerpt")?.textContent).toBe(
      "Finished <strong>without markup</strong>.",
    );
    expect(container.querySelector(".session-hovercard__excerpt strong")).toBeNull();
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

      const plan = container.querySelector(".session-hovercard__plan-row");
      if (mode === "active") {
        expect(plan?.querySelector(".session-hovercard__plan-step")?.textContent).toBe("Verify");
        expect(plan?.querySelector(".session-hovercard__plan-count")?.textContent).toBe("0/1");
        expect(plan?.querySelector(".session-run-spinner")).not.toBeNull();
      } else {
        expect(plan).toBeNull();
      }
      const notepad = container.querySelector(".session-hovercard__notepad");
      expect(notepad).not.toBeNull();
      expect(notepad?.querySelector(".session-hovercard__notepad-title")?.textContent).toBe(
        "Agent Notepad",
      );
      expect(notepad?.querySelector("strong")?.textContent).toBe("Release");
      expect(container.querySelector(".session-progress-card")).toBeNull();
      expect(container.querySelector("time")).toBeNull();
      expect(container.querySelector(".session-hovercard__excerpt")).toBeNull();
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

    const plan = container.querySelector(".session-hovercard__plan-row");
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
    const container = renderCard({
      row: row(),
      progressCard: {
        ...progressCard(),
        markdown: undefined,
        steps: [
          { step: "Done", status: "completed" },
          { step: "Next", status: "pending" },
          { step: "Working", status: "in_progress" },
          { step: "Later", status: "pending" },
        ],
      },
    });
    expect(container.querySelector(".session-hovercard__plan-step")?.textContent).toBe("Working");
    expect(container.querySelector(".session-hovercard__plan-count")?.textContent).toBe("1/4");
    expect(container.querySelector(".session-hovercard__notepad")).toBeNull();

    renderCard(
      {
        row: row(),
        progressCard: {
          ...progressCard(),
          markdown: undefined,
          steps: [
            { step: "Done", status: "completed" },
            { step: "Next", status: "pending" },
            { step: "Later", status: "pending" },
          ],
        },
      },
      container,
    );
    expect(container.querySelector(".session-hovercard__plan-step")?.textContent).toBe("Next");
    expect(container.querySelector(".session-hovercard__plan-count")?.textContent).toBe("1/3");

    renderCard(
      {
        row: row(),
        progressCard: {
          ...progressCard(),
          markdown: undefined,
          steps: [{ step: "Done", status: "completed" }],
        },
      },
      container,
    );
    expect(container.querySelector(".session-hovercard__plan-row")).toBeNull();
    expect(container.querySelector(".session-hovercard__notepad")).toBeNull();
  });

  it.each([
    { hasCreator: true, participantCount: 7, summary: "Alice Baker & 5 others" },
    { hasCreator: false, participantCount: 5, summary: "Mira & 3 others" },
  ])(
    "deduplicates attribution identities with creator: $hasCreator",
    ({ hasCreator, participantCount, summary }) => {
      const session = row();
      const participants: NonNullable<SidebarRecentSession["participants"]> = [
        { identity: { type: "profile", id: "self" }, label: "You" },
        { identity: { type: "profile", id: "mira" }, label: "Mira" },
        { identity: { type: "profile", id: "riley" }, label: "Riley" },
      ];
      if (hasCreator) {
        participants.unshift({ identity: { type: "profile", id: "alice" }, label: "Alice Baker" });
        participants.push({ identity: { type: "profile", id: "mira" }, label: "Mira duplicate" });
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
        expect(
          container.querySelector(".session-hovercard__attribution")?.getAttribute("aria-label"),
        ).toBe("Alice Baker, 5 more participants");
      }
    },
  );

  it("opens the creator's activity feed from the attribution", () => {
    const navigate = vi.fn();
    const container = renderCard({ row: row(), personActivity: { basePath: "/ui", navigate } });

    const name = container.querySelector<HTMLAnchorElement>(".session-hovercard__attribution-name");
    expect(name?.getAttribute("href")).toBe("/ui/activity/alice");
    expect(
      container.querySelector(".person-activity-avatar-link")?.getAttribute("aria-hidden"),
    ).toBe("true");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    name?.dispatchEvent(click);
    expect(navigate).toHaveBeenCalledWith("alice", "Alice Baker");
    expect(click.defaultPrevented).toBe(true);
  });

  it.each([true, false])(
    "renders authoritative participant projections (expanded: %s)",
    async (expanded) => {
      const container = document.body.appendChild(document.createElement("div"));
      const navigate = vi.fn();
      const participants: NonNullable<SidebarRecentSession["participants"]> = [
        { identity: { type: "profile", id: "mira" }, label: "Mira" },
        { identity: { type: "profile", id: "riley" }, label: "Riley" },
        { identity: { type: "profile", id: "sam" }, label: "Sam" },
        { identity: { type: "profile", id: "lee" }, label: "Lee" },
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

  it("renders nothing when no session facts are known", () => {
    const container = renderCard({});

    expect(container.childElementCount).toBe(0);
  });
});
