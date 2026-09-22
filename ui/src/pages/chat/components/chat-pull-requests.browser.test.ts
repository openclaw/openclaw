import { html, render } from "lit";
import { afterEach, assert, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderChatPullRequests } from "./chat-pull-requests.ts";
import baseStyles from "../../../styles/base.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";
import textStyles from "../../../styles/chat/text.css?inline";

const container = document.createElement("div");
afterEach(() => {
  render(null, container);
  container.remove();
});

it("keeps disclosure geometry and surrounding message spacing through keyboard toggles", async () => {
  document.body.append(container);
  let expanded = false;
  const draw = () =>
    render(
      html`
        <style>
          ${baseStyles}${layoutStyles}${textStyles}
        </style>
        <div class="chat-text">
          <p>Pull requests for this change:</p>
          ${renderChatPullRequests({
            pullRequests: Array.from({ length: 10 }, (_, index) => ({
              number: index + 1,
              owner: "openclaw",
              repo: "openclaw",
              branch: "fix/example",
              title: `Example ${index + 1}`,
              url: `https://github.com/openclaw/openclaw/pull/${index + 1}`,
              state: "merged",
            })),
            status: "ready",
            expanded,
            onToggle: () => {
              expanded = !expanded;
              draw();
            },
            onDismiss: () => {},
          })}
          <p>Review the remaining changes.</p>
        </div>
      `,
      container,
    );
  draw();
  const stack = container.querySelector<HTMLElement>(".chat-prs")!;
  const following = stack.nextElementSibling!;
  const toggle = stack.querySelector<HTMLButtonElement>(".chat-prs__more")!;
  const geometry = () => {
    const rows = [...stack.children].map((row) => row.getBoundingClientRect());
    const firstRow = rows[0];
    assert.isDefined(firstRow);
    const bounds = stack.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(stack).rowGap);
    expect(bounds.height).toBeCloseTo(
      rows.reduce((height, row) => height + row.height, 0) + gap * (rows.length - 1),
      1,
    );
    expect(toggle.getBoundingClientRect().width).toBe(firstRow.width);
    expect(Math.abs(toggle.getBoundingClientRect().height - firstRow.height)).toBeLessThanOrEqual(
      1,
    );
    expect(getComputedStyle(toggle).borderRadius).toBe(
      getComputedStyle(stack.firstElementChild!).borderRadius,
    );
    expect(following.getBoundingClientRect().top - bounds.bottom).toBeCloseTo(
      Number.parseFloat(getComputedStyle(following).marginTop),
      1,
    );
  };
  geometry();
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.elementLocator(toggle)).toHaveTextContent("Show less");
  expect(document.activeElement).toBe(toggle);
  expect(stack.querySelectorAll(".chat-pr")).toHaveLength(10);
  geometry();
  await userEvent.keyboard(" ");
  await expect.element(page.elementLocator(toggle)).toHaveTextContent("Show 8 more");
  expect(document.activeElement).toBe(toggle);
  expect(stack.querySelectorAll(".chat-pr")).toHaveLength(2);
  geometry();
});
