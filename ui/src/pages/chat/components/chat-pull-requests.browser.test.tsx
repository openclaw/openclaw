import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import { publication, sessionBranch } from "./chat-pull-requests.test-support.ts";
import { ChatPullRequests } from "./chat-pull-requests.tsx";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";

const container = document.createElement("div");
let mounted: ReturnType<typeof mountSolid> | undefined;
let originalViewport: { width: number; height: number };
beforeEach(() => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  mounted?.unmount();
  mounted = undefined;
  container.remove();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each(["props", "owner", "parked"])(
  "hides a retained pane's CI popup and restores disclosure through %s presentation",
  async (mode) => {
    await page.viewport(800, 600);
    document.body.append(container);
    const owner = new EventTarget();
    let isPresented = true;
    let updatePresented!: (value: boolean) => void;
    let updateParked!: (value: boolean) => void;
    let updateDismissed!: (value: boolean) => void;
    const binding = { owner, isPresented: () => isPresented };
    mounted = mountSolid(
      () => {
        const [presented, setPresented] = createSignal(true);
        const [active, setActive] = createSignal(true);
        const [dismissed, setDismissed] = createSignal(false);
        updatePresented = setPresented;
        updateParked = setActive;
        updateDismissed = setDismissed;
        return (
          <ContentPresentation value={active}>
            <style>
              {baseStyles}
              {layoutStyles}
            </style>
            <section
              style={`width: 500px; padding-top: 260px; opacity: ${mode === "props" && !presented() ? 0 : 1}`}
            >
              <ChatPullRequests
                pullRequests={[
                  {
                    number: 42,
                    owner: "example",
                    repo: "release-planning",
                    branch: "review",
                    title: "Review release checklist",
                    url: "https://github.com/example/release-planning/pull/42",
                    state: "open",
                    checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
                  },
                ]}
                status="ready"
                presented={mode === "props" ? presented() : binding}
                dismissed={dismissed()}
                onDismiss={() => {}}
              />
            </section>
          </ContentPresentation>
        );
      },
      { container },
    );
    const draw = (presented: boolean, dismissed = false) => {
      updateDismissed(dismissed);
      isPresented = presented;
      if (mode === "props") {
        updatePresented(presented);
      } else {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        if (mode === "parked") {
          updateParked(presented);
        }
      }
      flush();
    };
    draw(true);
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    const summary = disclosure.querySelector("summary")!;
    const menu = page.elementLocator(
      container.querySelector<HTMLElement>(".chat-pr__checks-menu")!,
    );
    await page.elementLocator(summary).click();
    await expect.element(menu).toBeVisible();

    draw(false);
    await expect.element(menu).not.toBeVisible();
    expect(disclosure.open).toBe(true);

    draw(true);
    await expect.element(menu).toBeVisible();
    expect(container.querySelector(".chat-pr__checks")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    summary.focus();
    await userEvent.keyboard(" ");
    await expect.element(menu).not.toBeVisible();
    if (mode === "props") {
      await page.elementLocator(summary).click();
      await expect.element(menu).toBeVisible();
      draw(false, true);
      await expect.element(menu).not.toBeVisible();
      expect(disclosure.open).toBe(false);
      draw(true);
      await expect.element(menu).not.toBeVisible();
      expect(disclosure.open).toBe(false);
    }
  },
);

it.each([
  { viewport: 1440, width: 360, repo: "openclaw" },
  { viewport: 900, width: 300, repo: "a-very-long-repository-name-that-needs-truncation" },
  { viewport: 393, width: 360, repo: "openclaw" },
])(
  "keeps branch labels horizontal beside publication controls at $viewport/$width",
  async ({ viewport, width, repo }) => {
    await page.viewport(viewport, 700);
    document.body.append(container);
    const onPublish = vi.fn();
    const onDismissBranch = vi.fn();
    const branch = sessionBranch({ repo, branch: "openclaw/custom-snooze-date-time" });
    const shared = { source: "agent-override" as const, accountId: 1, login: "agent-bot" };
    mounted = mountSolid(
      () => (
        <>
          <style>{`${baseStyles}${layoutStyles}${detailsStyles}`}</style>
          <section class="chat-details" style={`position:relative;width:${width}px`}>
            <ChatPullRequests
              pullRequests={[]}
              branch={branch}
              status="ready"
              compact
              onDismiss={() => {}}
              onDismissBranch={onDismissBranch}
              publication={publication({
                onPublish,
                onSelect: () => {},
                options: {
                  shared,
                  personal: {
                    state: "connected",
                    generation: "personal",
                    account: { accountId: 2, login: "alice-tools" },
                    accessExpiresAtMs: null,
                    refreshState: "available",
                    pending: null,
                  },
                  pendingPersonal: null,
                  latestShared: null,
                },
                selection: { source: "shared", expected: shared },
              })}
            />
          </section>
        </>
      ),
      { container },
    );
    flush();
    const row = container.querySelector<HTMLElement>(".chat-pr")!;
    const identity = row.querySelector<HTMLElement>(".chat-pr__identity")!;
    const repository = row.querySelector<HTMLElement>(".chat-pr__repo")!;
    const branchLabel = row.querySelector<HTMLElement>(".chat-pr__branch")!;
    const controls = row.querySelector<HTMLElement>(".chat-pr__meta")!;
    await expect.element(page.elementLocator(row)).toBeVisible();
    expect(row.getBoundingClientRect().height).toBeLessThan(64);
    expect(identity.getBoundingClientRect().right).toBeLessThanOrEqual(
      controls.getBoundingClientRect().left,
    );
    expect(branchLabel.getBoundingClientRect().width).toBeGreaterThan(40);
    expect(branchLabel.getBoundingClientRect().height).toBeLessThanOrEqual(
      Number.parseFloat(getComputedStyle(branchLabel).lineHeight) + 1,
    );
    if (viewport > 640) {
      expect(repository.getBoundingClientRect().width).toBeGreaterThan(40);
      expect(repository.getBoundingClientRect().height).toBeLessThanOrEqual(
        Number.parseFloat(getComputedStyle(repository).lineHeight) + 1,
      );
      if (repo === "openclaw") {
        expect(repository.scrollWidth).toBeLessThanOrEqual(repository.clientWidth);
      }
    }
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    await page.elementLocator(row.querySelector<HTMLButtonElement>(".chat-pr__create")!).click();
    expect(onPublish).toHaveBeenCalledOnce();
    await page.elementLocator(row.querySelector<HTMLButtonElement>(".chat-pr__dismiss")!).click();
    expect(onDismissBranch).toHaveBeenCalledExactlyOnceWith(branch);
  },
);

it.each([
  { width: 360, repo: "openclaw", checks: "passing", state: "merged" },
  {
    width: 300,
    repo: "a-very-long-repository-name-that-needs-truncation",
    checks: "pending",
    state: "draft",
  },
  {
    width: 220,
    repo: "a-very-long-repository-name-that-needs-truncation",
    checks: "failing",
    state: "closed",
  },
] as const)(
  "keeps title-first Details cards usable at $width px with $checks checks",
  async ({ width, repo, checks, state }) => {
    await page.viewport(800, 700);
    document.body.append(container);
    const onDismiss = vi.fn();
    const onOpenSessionDiff = vi.fn();
    const pullRequest = {
      number: 173824,
      owner: "openclaw",
      repo,
      branch: "fix/sidebar-cards",
      title: "fix: keep long pull request titles readable in the session Details sidebar",
      url: "https://github.com/openclaw/" + repo + "/pull/173824",
      state: "open" as const,
      additions: 383,
      deletions: 441,
      checks: {
        state: checks,
        passed: 12,
        failed: checks === "failing" ? 1 : 0,
        skipped: 0,
        running: checks === "pending" ? 2 : 0,
      },
    };
    mounted = mountSolid(
      () => (
        <>
          <style>{baseStyles + layoutStyles + detailsStyles}</style>
          <section class="chat-details" style={"position:relative;width:" + width + "px"}>
            {createComponent(ChatDetailsSession, {
              presented: true,
              props: {
                sessionKey: "agent:main:cards",
                selectedSession: undefined,
                currentAgentId: "main",
                messages: [],
                pullRequests: [pullRequest, { ...pullRequest, number: 173825, state }],
                onDismissPullRequest: onDismiss,
                onOpenSessionDiff,
              },
            })}
          </section>
        </>
      ),
      { container },
    );
    const host = container.querySelector("openclaw-chat-details-session")!;
    await host.updateComplete;
    const group = container.querySelector<HTMLDetailsElement>(
      '[data-details-group="pull-requests"]',
    )!;
    const row = group.querySelector<HTMLElement>(".chat-pr")!;
    const title = row.querySelector<HTMLElement>(".chat-pr__link")!;
    const reference = row.querySelector<HTMLElement>(".chat-pr__number")!;
    const repository = row.querySelector<HTMLElement>(".chat-pr__repo")!;
    const header = row.querySelector<HTMLElement>(".chat-pr__header")!;
    const footer = row.querySelector<HTMLElement>(".chat-pr__meta")!;
    await expect.element(page.elementLocator(title)).toBeVisible();
    expect(reference.textContent).toBe("#173824");
    expect(reference.scrollWidth).toBeLessThanOrEqual(reference.clientWidth + 1);
    expect(reference.getBoundingClientRect().height).toBeLessThanOrEqual(
      Number.parseFloat(getComputedStyle(reference).lineHeight) + 1,
    );
    expect(repository.textContent).toBe("openclaw/" + repo);
    expect(getComputedStyle(repository).textOverflow).toBe("ellipsis");
    expect(title.getBoundingClientRect().width).toBeCloseTo(
      header.getBoundingClientRect().width,
      0,
    );
    expect(title.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      header.getBoundingClientRect().bottom,
    );
    expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      title.getBoundingClientRect().bottom,
    );
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    expect(container.querySelector<HTMLElement>(".chat-details")!.scrollWidth).toBeLessThanOrEqual(
      width,
    );
    expect(row.querySelector(".chat-pr__checks")?.getAttribute("data-checks")).toBe(checks);
    expect(group.querySelectorAll(".chat-pr")).toHaveLength(2);
    expect(group.querySelectorAll(".chat-pr")[1]?.getAttribute("data-state")).toBe(state);
    // PR totals stay descriptive; only All changes opens the session diff.
    expect(row.querySelector("button.chat-pr__diff")).toBeNull();
    expect(footer.textContent).toContain("+383");
    expect(footer.textContent).toContain("−441");
    const allChanges = container.querySelector<HTMLButtonElement>(".chat-details__all-changes")!;
    expect(allChanges.closest("summary")).toBeNull();
    expect(allChanges.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      header.getBoundingClientRect().top,
    );
    await page.elementLocator(allChanges).click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    expect(group.open).toBe(true);
    const summary = group.querySelector<HTMLElement>(":scope > summary")!;
    summary.focus();
    await userEvent.keyboard(" ");
    await expect.element(page.elementLocator(title)).not.toBeVisible();
    summary.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.elementLocator(title)).toBeVisible();
    const trigger = row.querySelector<HTMLButtonElement>(".chat-pr__actions button")!;
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dismiss = page.getByRole("menuitem", {
      name: "Dismiss pull request openclaw/" + repo + "#173824",
      exact: true,
    });
    await expect.element(dismiss).toBeVisible();
    await userEvent.keyboard("{Escape}");
    const menu = row.querySelector<HTMLElement>('[role="menu"]')!;
    await expect.poll(() => menu.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard("{Enter}");
    await expect.element(dismiss).toBeVisible();
    host.presented = false;
    await host.updateComplete;
    await expect.poll(() => menu.matches(":popover-open")).toBe(false);
    host.presented = true;
    await host.updateComplete;
    expect(menu.matches(":popover-open")).toBe(false);
    await page.elementLocator(trigger).click();
    await dismiss.click();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(pullRequest);
  },
);
