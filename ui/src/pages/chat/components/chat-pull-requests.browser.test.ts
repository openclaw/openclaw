import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderChatPullRequests } from "./chat-pull-requests.ts";
import baseStyles from "../../../styles/base.css?inline";
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

it("hides a retained pane's CI popup and restores its open disclosure when presented", async () => {
  await page.viewport(800, 600);
  document.body.append(container);
  const draw = (presented: boolean) =>
    render(
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
            presented,
            onDismiss: () => {},
          })}
        </section>
      `,
      container,
    );
  draw(true);
  const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
  const summary = disclosure.querySelector("summary")!;
  const menu = page.elementLocator(container.querySelector<HTMLElement>(".chat-pr__checks-menu")!);
  await page.elementLocator(summary).click();
  await expect.element(menu).toBeVisible();

  draw(false);
  await expect.element(menu).not.toBeVisible();
  expect(disclosure.open).toBe(true);

  draw(true);
  await expect.element(menu).toBeVisible();
  expect(disclosure.open).toBe(true);
  summary.focus();
  await userEvent.keyboard(" ");
  await expect.element(menu).not.toBeVisible();
});

it("uses canonical merge facts and pulses only fresh pending requests", () => {
  document.body.append(container);
  type Props = Parameters<typeof renderChatPullRequests>[0];
  type PullRequest = Props["pullRequests"][number];
  const draw = (
    mergeStatus: NonNullable<PullRequest["merge"]>["status"],
    snapshotStatus: Props["status"] = "ready",
    state: PullRequest["state"] = "open",
  ) => {
    render(
      html`
        <style>
          ${baseStyles}${layoutStyles}
        </style>
        ${renderChatPullRequests({
          pullRequests: [
            {
              number: 42,
              owner: "example",
              repo: "release-planning",
              branch: "review",
              title: "Review release checklist",
              url: "https://github.com/example/release-planning/pull/42",
              state,
              checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
              merge: { status: mergeStatus, message: "Merge request detail from GitHub." },
            },
          ],
          status: snapshotStatus,
          onDismiss: () => {},
        })}
      `,
      container,
    );
    const checks = container.querySelector<HTMLElement>(".chat-pr__checks")!;
    expect(checks.querySelector("summary")?.textContent?.trim()).toBe("CI");
    return {
      checks,
      animation: getComputedStyle(checks.querySelector(".chat-pr__checks-dot")!).animationName,
      detail: checks.querySelector(".chat-pr__merge-detail"),
    };
  };

  const pending = draw("pending");
  expect(pending.animation).toBe("github-merge-pulse");
  expect(pending.detail?.textContent).toContain("Merging…");
  expect(pending.detail?.textContent).toContain("Merge request detail from GitHub.");

  for (const [status, phase, label] of [
    ["merged", "verifying", "Confirming merge…"],
    ["enqueued", "enqueued", "Queued"],
    ["failed", "failed", "Merge failed"],
    ["unavailable", "unavailable", "Merge status unavailable"],
  ] as const) {
    const result = draw(status);
    expect(result.animation).toBe("none");
    expect(result.checks.dataset.merge).toBe(phase);
    expect(result.detail?.textContent).toContain(label);
  }

  for (const snapshotStatus of ["unavailable", "rate-limited"] as const) {
    const result = draw("pending", snapshotStatus);
    expect(result.animation).toBe("none");
    expect(result.detail?.textContent).toContain("Merge status unavailable");
    expect(result.detail?.textContent).not.toContain("Merge request detail from GitHub.");
  }

  for (const state of ["merged", "closed"] as const) {
    const result = draw("pending", "ready", state);
    expect(result.animation).toBe("none");
    expect(result.detail).toBeNull();
  }
});
