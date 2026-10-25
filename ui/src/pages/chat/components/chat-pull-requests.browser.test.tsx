import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import { publication, pullRequest, sessionBranch } from "./chat-pull-requests.test-support.ts";
import { ChatPullRequests } from "./chat-pull-requests.tsx";
import baseStyles from "../../../styles/base.css?inline";
import desktopDetailsStyles from "../../../styles/chat/details-desktop.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";
import componentsStyles from "../../../styles/components.css?inline";

const container = document.createElement("div");
const query = <T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = container,
) => root.querySelector<T>(selector)!;
const rect = (element: Element) => element.getBoundingClientRect();
const styles = baseStyles + componentsStyles + layoutStyles + detailsStyles + desktopDetailsStyles;
const visible = (element: HTMLElement) =>
  expect.element(page.elementLocator(element)).toBeVisible();
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
              style={{
                width: "500px",
                "padding-top": "260px",
                opacity: mode === "props" && !presented() ? 0 : 1,
              }}
            >
              <ChatPullRequests
                pullRequests={[
                  pullRequest({ additions: undefined, deletions: undefined, checksUrl: undefined }),
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
    await waitForSolid(() => expect(query(".chat-pr__checks")).not.toBeNull());
    const disclosure = query<HTMLDetailsElement>(".chat-pr__checks");
    const summary = query("summary", disclosure);
    const menu = page.elementLocator(query(".chat-pr__checks-menu"));
    await page.elementLocator(summary).click();
    await expect.element(menu).toBeVisible();

    draw(false);
    await expect.element(menu).not.toBeVisible();
    expect(disclosure.open).toBe(true);

    draw(true);
    await expect.element(menu).toBeVisible();
    expect(query(".chat-pr__checks")).toBe(disclosure);
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
  { viewport: 1440, width: 360, repo: "openclaw", clipped: false },
  { viewport: 393, width: 360, repo: "openclaw", clipped: false },
  { viewport: 900, width: 300, repo: "openclaw", clipped: true },
])(
  "keeps the native branch row above aligned diff and publication actions at $viewport/$width (clipped: $clipped)",
  async ({ viewport, width, repo, clipped }) => {
    await page.viewport(viewport, 700);
    document.body.append(container);
    const onPublish = vi.fn();
    const onSelect = vi.fn();
    const onDismissBranch = vi.fn();
    const branch = sessionBranch({
      repo,
      branch: clipped
        ? "openclaw/custom-snooze-date-time-with-a-branch-name-that-needs-truncation"
        : "openclaw/custom-snooze-date-time",
    });
    const shared = { source: "agent-override" as const, accountId: 1, login: "agent-bot" };
    mounted = mountSolid(
      () => (
        <>
          <style>{styles}</style>
          <section
            class="chat-details"
            data-desktop
            data-open
            data-instant
            style={{ position: "relative", width: `${width}px`, "max-width": "none" }}
          >
            <div class="chat-details-desktop-body">
              <ChatDetailsEnvironment
                presented
                details={{
                  sessionKey: "agent:main:branch",
                  currentAgentId: "main",
                  messages: [],
                  selectedSession: undefined,
                  detailsWorkspace: {
                    root: "/synthetic/project",
                    label: "project",
                    branch: branch.branch,
                  },
                }}
                work={{
                  pullRequests: [],
                  branch,
                  status: "ready",
                  onDismiss: () => {},
                  onDismissBranch,
                  publication: publication({
                    onPublish,
                    onSelect,
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
                  }),
                }}
              />
            </div>
          </section>
        </>
      ),
      { container },
    );
    await waitForSolid(() =>
      expect(query(".chat-environment__branch .chat-pr__actions-trigger")).not.toBeNull(),
    );
    const row = query(".chat-environment__branch");
    const branchLabel = query(".chat-environment__branch-name", row);
    const diff = query(".chat-pr__diff", row);
    const trigger = query<HTMLButtonElement>(".chat-pr__actions-trigger", row);
    const publish = page.getByRole("button", { name: "Create PR", exact: true });
    await expect.element(publish).toBeVisible();
    const publishButton = query<HTMLButtonElement>("button.chat-pr__create", row);
    await visible(trigger);
    expect(rect(trigger).width).toBeGreaterThanOrEqual(26);
    expect(rect(row).left).toBeGreaterThanOrEqual(0);
    expect(rect(row).right).toBeLessThanOrEqual(viewport);
    expect(branchLabel.textContent).toBe(branch.branch);
    expect(row.querySelector(".chat-pr__repo")).toBeNull();
    expect(Math.abs(rect(branchLabel).left - rect(diff).left)).toBeLessThanOrEqual(1);
    expect(rect(diff).top).toBeGreaterThanOrEqual(rect(branchLabel).bottom);
    expect(rect(diff).top - rect(branchLabel).bottom).toBeLessThanOrEqual(12);
    expect(rect(diff).right).toBeLessThanOrEqual(rect(publishButton).left);
    expect(rect(publishButton).right).toBeLessThanOrEqual(rect(trigger).left);
    expect(diff.textContent).toContain("+2,819");
    expect(diff.textContent).toContain("−205");
    expect(rect(branchLabel).width).toBeGreaterThan(40);
    expect(rect(branchLabel).height).toBeLessThanOrEqual(
      Number.parseFloat(getComputedStyle(branchLabel).lineHeight) + 1,
    );
    await waitForSolid(() => {
      expect(branchLabel.scrollWidth > branchLabel.clientWidth + 1).toBe(clipped);
      expect(getComputedStyle(branchLabel).maskImage !== "none").toBe(clipped);
    });
    expect(branchLabel.parentElement?.getAttribute("title")).toBe(branch.branch);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);

    const dismiss = page.getByRole("button", {
      name: `Hide ${branch.branch} for this session`,
      exact: true,
    });
    const menu = page.elementLocator(row.querySelector<HTMLElement>('[role="menu"]')!);
    await expect.element(menu).not.toBeVisible();
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(dismiss).toBeVisible();
    const personalChoice = page.getByRole("menuitemradio", { name: "@alice-tools", exact: true });
    await expect.element(personalChoice).toBeVisible();
    await personalChoice.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("personal");
    await expect.element(menu).not.toBeVisible();
    await publish.click();
    expect(onPublish).toHaveBeenCalledOnce();
    expect(onDismissBranch).not.toHaveBeenCalled();
    await page.elementLocator(trigger).click();
    await dismiss.click();
    expect(onDismissBranch).toHaveBeenCalledExactlyOnceWith(branch);
    await expect.element(menu).not.toBeVisible();
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
    const request = pullRequest({
      number: 173824,
      owner: "openclaw",
      repo,
      branch: "fix/sidebar-cards",
      title: "fix: keep long pull request titles readable in the session Details sidebar",
      url: "https://github.com/openclaw/" + repo + "/pull/173824",
      additions: 383,
      deletions: 441,
      checks: {
        state: checks,
        passed: 12,
        failed: checks === "failing" ? 1 : 0,
        skipped: 0,
        running: checks === "pending" ? 2 : 0,
      },
      checksUrl: undefined,
    });
    mounted = mountSolid(
      () => (
        <>
          <style>{baseStyles + componentsStyles + layoutStyles + detailsStyles}</style>
          <section class="chat-details" style={"position:relative;width:" + width + "px"}>
            {createComponent(ChatDetailsSession, {
              presented: true,
              props: {
                sessionKey: "agent:main:cards",
                selectedSession: undefined,
                currentAgentId: "main",
                messages: [],
                pullRequests: [request, { ...request, number: 173825, state }],
                pullRequestsBranch: {
                  owner: request.owner,
                  repo,
                  branch: request.branch,
                  additions: 12,
                  deletions: 3,
                },
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
    await waitForSolid(() => expect(container.querySelector("a.chat-pr__link")).not.toBeNull());
    const group = query<HTMLDetailsElement>('[data-details-group="pull-requests"]');
    const row = query(".chat-pr", group);
    const title = query(".chat-pr__link", row);
    const titleText = query(".chat-pr__title", row);
    await visible(title);
    expect(title.getAttribute("href")).toBe(request.url);
    expect(title.getAttribute("aria-label")).toContain("openclaw/" + repo + "#173824");
    expect(titleText.textContent).toBe(request.title);
    const expectTitleFade = (overflow: boolean) =>
      waitForSolid(() => {
        expect(titleText.scrollWidth > titleText.clientWidth + 1).toBe(overflow);
        expect(getComputedStyle(titleText).maskImage !== "none").toBe(overflow);
      });
    await expectTitleFade(true);
    const details = query(".chat-details");
    details.style.width = "1200px";
    await expectTitleFade(false);
    details.style.width = `${width}px`;
    await expectTitleFade(true);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    expect(details.scrollWidth).toBeLessThanOrEqual(width);
    const badge = checks === "failing" ? "failed" : checks === "pending" ? "running" : "passed";
    expect(query(".chat-pr__badge", row).classList.contains(`chat-pr__badge--${badge}`)).toBe(true);
    expect(group.querySelectorAll(".chat-pr")).toHaveLength(2);
    expect(group.querySelectorAll(".chat-pr")[1]?.getAttribute("data-state")).toBe(state);
    // PR totals stay descriptive; the Environment diff opens this session’s changes.
    expect(row.querySelector("button.chat-pr__diff")).toBeNull();
    const changes = query<HTMLButtonElement>(".chat-environment__branch button.chat-pr__diff");
    await visible(changes);
    expect(changes.textContent).toContain("+12");
    expect(changes.textContent).toContain("−3");
    expect(changes.closest("summary")).toBeNull();
    expect(rect(changes).bottom).toBeLessThanOrEqual(rect(row).top);
    await page.elementLocator(changes).click();
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
      name: "Hide",
      exact: true,
    });
    await expect.element(dismiss).toBeVisible();
    const facts = query(".chat-pr-menu__facts", row);
    expect(query(".chat-pr-menu__repository", facts).textContent).toContain("openclaw/" + repo);
    expect(query(".chat-pr-menu__repository", facts).textContent).toContain("#173824");
    expect(facts.textContent).toContain("+383");
    expect(facts.textContent).toContain("−441");
    expect(facts.textContent).toContain("Open");
    await userEvent.keyboard("{Escape}");
    const menu = row.querySelector<HTMLElement>('[role="menu"]')!;
    await expect.poll(() => menu.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard("{Enter}");
    await expect.element(dismiss).toBeVisible();

    for (const id of ["checks", "monitoring"]) {
      await page.elementLocator(menu.querySelector<HTMLElement>(`[data-value="${id}"]`)!).click();
      await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("back");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe(id);
    }
    host.presented = false;
    await host.updateComplete;
    await expect.poll(() => menu.matches(":popover-open")).toBe(false);
    host.presented = true;
    await host.updateComplete;
    expect(menu.matches(":popover-open")).toBe(false);
    await page.elementLocator(trigger).click();
    await dismiss.click();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(request);
  },
);
