import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PRESENTATION_CHANGED_EVENT } from "../../../lit/presentation-binding.ts";
import { publication, sessionBranch } from "./chat-pull-requests.test-support.ts";
import { renderChatPullRequests } from "./chat-pull-requests.ts";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";

const container = document.createElement("div");
let originalViewport: { width: number; height: number };
beforeEach(() => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  render(nothing, container);
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
    let painted = false;
    let part: ReturnType<typeof render>;
    const binding = { owner, isPresented: () => isPresented };
    const draw = (presented: boolean, dismissed = false) => {
      isPresented = presented;
      if (mode !== "props" && painted) {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        if (mode === "parked") {
          part.setConnected(presented);
        }
        return;
      }
      part = render(
        html`
          <style>
            ${baseStyles}${layoutStyles}
          </style>
          <section style="width: 500px; padding-top: 260px; opacity: ${presented ? 1 : 0}">
            ${renderChatPullRequests({
              pullRequests: [
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
              ],
              status: "ready",
              presented: mode === "props" ? presented : binding,
              dismissed,
              onDismiss: () => {},
            })}
          </section>
        `,
        container,
      );
      painted = true;
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
    render(
      html`
        <style>
          ${baseStyles}${layoutStyles}${detailsStyles}
        </style>
        <section class="chat-details" style="position:relative;width:${width}px">
          ${renderChatPullRequests({
            pullRequests: [],
            branch,
            status: "ready",
            compact: true,
            onDismiss: () => {},
            onDismissBranch,
            publication: publication({
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
            }),
          })}
        </section>
      `,
      container,
    );
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

it.each(["openclaw", "a-very-long-repository-name-that-must-remain-readable"])(
  "keeps the full %s PR reference and title clear of CI controls",
  async (repo) => {
    await page.viewport(1440, 700);
    document.body.append(container);
    render(
      html`
        <style>
          ${baseStyles}${layoutStyles}${detailsStyles}
        </style>
        <section class="chat-details" style="position:relative;width:360px">
          ${renderChatPullRequests({
            pullRequests: [
              {
                number: 42,
                owner: "example",
                repo,
                branch: "fix/layout",
                title: "Keep long pull request titles readable in the narrow session Details panel",
                url: `https://github.com/example/${repo}/pull/42`,
                state: "open",
                checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
              },
            ],
            status: "ready",
            compact: true,
            onDismiss: () => {},
          })}
        </section>
      `,
      container,
    );
    const reference = container.querySelector<HTMLElement>(".chat-pr__number")!;
    expect(reference.textContent).toBe(`example/${repo}#42`);
    expect(reference.scrollWidth).toBeLessThanOrEqual(reference.clientWidth + 1);
    const title = container.querySelector<HTMLElement>(".chat-pr__repo")!;
    const link = container.querySelector<HTMLElement>(".chat-pr__link")!;
    const controls = container.querySelector<HTMLElement>(".chat-pr__meta")!;
    expect(title.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(title).lineHeight) * 2,
    );
    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1);
    expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
      controls.getBoundingClientRect().left,
    );
    expect(reference.getBoundingClientRect().right).toBeLessThanOrEqual(
      controls.getBoundingClientRect().left,
    );
  },
);
