import type { JSX } from "@solidjs/web";
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { options as accountOptions } from "../chat-github-publication.test-support.ts";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import { publication, sessionBranch } from "./chat-pull-requests.test-support.ts";
import { ChatPullRequests } from "./chat-pull-requests.tsx";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";

const baseRequest = {
  number: 42,
  owner: "example",
  repo: "release-planning",
  branch: "review",
  title: "Review release checklist",
  url: "https://github.com/example/release-planning/pull/42",
  state: "open" as const,
};
function element<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = container,
) {
  return root.querySelector<T>(selector)!;
}
const rect = (node: HTMLElement) => node.getBoundingClientRect();
function expectSingleLine(node: HTMLElement) {
  expect(rect(node).height).toBeLessThanOrEqual(
    Number.parseFloat(getComputedStyle(node).lineHeight) + 1,
  );
}
function expectFits(node: HTMLElement, allowance = 1) {
  expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + allowance);
}
const longRepo = "a-very-long-repository-name-that-needs-truncation";
const container = document.createElement("div");
let originalViewport: { width: number; height: number };
beforeEach(() => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  container.remove();
  await page.viewport(originalViewport.width, originalViewport.height);
});

function mountDetails(width: number, content: () => JSX.Element) {
  document.body.append(container);
  mountSolid(
    () => (
      <>
        <style>{baseStyles + layoutStyles + detailsStyles}</style>
        <section class="chat-details" style={`position:relative;width:${width}px`}>
          {content()}
        </section>
      </>
    ),
    { container },
  );
}

it.each(["props", "owner", "parked"])(
  "hides a retained pane's CI popup and restores disclosure through %s presentation",
  async (mode) => {
    await page.viewport(800, 600);
    document.body.append(container);
    const owner = new EventTarget();
    let isPresented = true;
    let updateState!: (value: { presented: boolean; active: boolean; dismissed: boolean }) => void;
    const binding = { owner, isPresented: () => isPresented };
    mountSolid(
      () => {
        const [state, setState] = createSignal({ presented: true, active: true, dismissed: false });
        updateState = setState;
        return (
          <ContentPresentation value={() => state().active}>
            <style>
              {baseStyles}
              {layoutStyles}
            </style>
            <section
              style={`width: 500px; padding-top: 260px; opacity: ${mode === "props" && !state().presented ? 0 : 1}`}
            >
              <ChatPullRequests
                pullRequests={[
                  {
                    ...baseRequest,
                    checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
                  },
                ]}
                status="ready"
                presented={mode === "props" ? state().presented : binding}
                dismissed={state().dismissed}
                onDismiss={() => {}}
              />
            </section>
          </ContentPresentation>
        );
      },
      { container },
    );
    const draw = (presented: boolean, dismissed = false) => {
      updateState({
        presented: mode === "props" ? presented : true,
        active: mode === "parked" ? presented : true,
        dismissed,
      });
      isPresented = presented;
      if (mode !== "props") {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
      }
      flush();
    };
    draw(true);
    const disclosure = element<HTMLDetailsElement>(".chat-pr__checks");
    const summary = disclosure.querySelector("summary")!;
    const menu = page.elementLocator(element(".chat-pr__checks-menu"));
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
  { viewport: 900, width: 300, repo: longRepo },
  { viewport: 393, width: 360, repo: "openclaw" },
])(
  "keeps branch labels horizontal beside publication controls at $viewport/$width",
  async ({ viewport, width, repo }) => {
    await page.viewport(viewport, 700);
    const onPublish = vi.fn();
    const onDismissBranch = vi.fn();
    const branch = sessionBranch({ repo, branch: "openclaw/custom-snooze-date-time" });
    const shared = { source: "agent-override" as const, accountId: 1, login: "agent-bot" };
    mountDetails(width, () => (
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
            ...accountOptions,
            shared,
            personal: { ...accountOptions.personal, generation: "personal" },
          },
          selection: { source: "shared", expected: shared },
        })}
      />
    ));
    flush();
    const row = element(".chat-pr");
    const identity = element(".chat-pr__identity", row);
    const repository = element(".chat-pr__repo", row);
    const branchLabel = element(".chat-pr__branch", row);
    const controls = element(".chat-pr__meta", row);
    await expect.element(page.elementLocator(row)).toBeVisible();
    expect(rect(row).height).toBeLessThan(64);
    expect(rect(identity).right).toBeLessThanOrEqual(rect(controls).left);
    expect(rect(branchLabel).width).toBeGreaterThan(40);
    expectSingleLine(branchLabel);
    if (viewport > 640) {
      expect(rect(repository).width).toBeGreaterThan(40);
      expectSingleLine(repository);
      if (repo === "openclaw") {
        expectFits(repository, 0);
      }
    }
    expectFits(row);
    await page.elementLocator(element<HTMLButtonElement>(".chat-pr__create", row)).click();
    expect(onPublish).toHaveBeenCalledOnce();
    await page.elementLocator(element<HTMLButtonElement>(".chat-pr__dismiss", row)).click();
    expect(onDismissBranch).toHaveBeenCalledExactlyOnceWith(branch);
  },
);

it.each([
  [360, "openclaw", "passing", "merged"],
  [300, longRepo, "pending", "draft"],
  [220, longRepo, "failing", "closed"],
] as const)(
  "keeps title-first Details cards usable at %s px (%s, %s checks, %s)",
  async (width, repo, checks, state) => {
    await page.viewport(800, 700);
    const onDismiss = vi.fn();
    const onOpenSessionDiff = vi.fn();
    const request = {
      ...baseRequest,
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
    };
    mountDetails(width, () =>
      createComponent(ChatDetailsSession, {
        presented: true,
        props: {
          sessionKey: "agent:main:cards",
          selectedSession: undefined,
          currentAgentId: "main",
          messages: [],
          pullRequests: [request, { ...request, number: 173825, state }],
          onDismissPullRequest: onDismiss,
          onOpenSessionDiff,
        },
      }),
    );
    const host = container.querySelector("openclaw-chat-details-session")!;
    await host.updateComplete;
    const group = element<HTMLDetailsElement>('[data-details-group="pull-requests"]');
    const row = element(".chat-pr", group);
    const title = element(".chat-pr__link", row);
    const reference = element(".chat-pr__number", row);
    const repository = element(".chat-pr__repo", row);
    const header = element(".chat-pr__header", row);
    const footer = element(".chat-pr__meta", row);
    await expect.element(page.elementLocator(title)).toBeVisible();
    expect(reference.textContent).toBe("#173824");
    expectFits(reference);
    expectSingleLine(reference);
    expect(repository.textContent).toBe("openclaw/" + repo);
    expect(getComputedStyle(repository).textOverflow).toBe("ellipsis");
    expect(rect(title).width).toBeCloseTo(rect(header).width, 0);
    expect(rect(title).top).toBeGreaterThanOrEqual(rect(header).bottom);
    expect(rect(footer).top).toBeGreaterThanOrEqual(rect(title).bottom);
    expectFits(row);
    expect(element(".chat-details").scrollWidth).toBeLessThanOrEqual(width);
    expect(row.querySelector(".chat-pr__checks")?.getAttribute("data-checks")).toBe(checks);
    expect(group.querySelectorAll(".chat-pr")).toHaveLength(2);
    expect(group.querySelectorAll(".chat-pr")[1]?.getAttribute("data-state")).toBe(state);
    // PR totals stay descriptive; only All changes opens the session diff.
    expect(row.querySelector("button.chat-pr__diff")).toBeNull();
    expect(footer.textContent).toContain("+383");
    expect(footer.textContent).toContain("−441");
    const allChanges = element<HTMLButtonElement>(".chat-details__all-changes");
    expect(allChanges.closest("summary")).toBeNull();
    expect(rect(allChanges).bottom).toBeLessThanOrEqual(rect(header).top);
    await page.elementLocator(allChanges).click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    expect(group.open).toBe(true);
    const summary = element(":scope > summary", group);
    summary.focus();
    await userEvent.keyboard(" ");
    await expect.element(page.elementLocator(title)).not.toBeVisible();
    summary.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.elementLocator(title)).toBeVisible();
    const trigger = element<HTMLButtonElement>(".chat-pr__actions button", row);
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dismiss = page.getByRole("menuitem", {
      name: "Dismiss pull request openclaw/" + repo + "#173824",
      exact: true,
    });
    await expect.element(dismiss).toBeVisible();
    await userEvent.keyboard("{Escape}");
    const menu = element('[role="menu"]', row);
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
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(request);
  },
);
