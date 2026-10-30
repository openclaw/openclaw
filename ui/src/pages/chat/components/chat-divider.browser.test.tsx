import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatNotice } from "./chat-notice-view.tsx";
import "../../../styles/base.css";
import "../../../styles/chat/grouped.css";

const root = document.documentElement;
const originalTheme = root.getAttribute("data-theme");
const originalMode = root.getAttribute("data-theme-mode");
const originalViewport = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  cleanupSolid();
  for (const [attribute, value] of [
    ["data-theme", originalTheme],
    ["data-theme-mode", originalMode],
  ] as const) {
    if (value === null) {
      root.removeAttribute(attribute);
    } else {
      root.setAttribute(attribute, value);
    }
  }
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each([
  ["light", 1280],
  ["dark", 1280],
  ["light", 390],
  ["dark", 390],
] as const)("shows plugin steering as a collapsed row in %s at %ipx", async (theme, width) => {
  root.dataset.theme = theme;
  root.dataset.themeMode = theme;
  await page.viewport(width, 900);
  const pluginName = "release-review-plugin-with-a-long-unbroken-display-name";
  const label = `${pluginName} guidance`;
  const item: Extract<ChatItem, { kind: "notice" }> = {
    kind: "notice",
    key: "plugin-steering",
    icon: "cpu",
    label,
    timestamp: new Date(2026, 9, 16, 14, 37).getTime(),
    text: "Check the **rollback path** before continuing.",
    collapsedBody: true,
    showTimestamp: true,
  };
  const view = mountSolid(() => <ChatNotice item={item} />);
  await expect.element(page.getByText(label)).toBeVisible();
  const row = view.container.querySelector<HTMLDetailsElement>("details.chat-notice-inline")!;
  const summary = row.querySelector<HTMLElement>("summary")!;
  const body = row.querySelector<HTMLElement>(".chat-notice__body")!;
  const time = row.querySelector<HTMLElement>(".chat-notice-inline__time")!;

  expect(time.textContent).toBe("2:37 PM");
  expect(row.open).toBe(false);
  await expect.element(body).not.toBeVisible();
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);

  summary.focus();
  await userEvent.keyboard("{Enter}");
  expect(row.open).toBe(true);
  await expect.element(body).toBeVisible();
  expect(body.textContent?.trim()).toBe("Check the rollback path before continuing.");
  expect(body.querySelector("strong")?.textContent).toBe("rollback path");
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  // The row reads as part of the agent's turn: body text starts at the row's left edge, not centered.
  expect(getComputedStyle(body).textAlign).not.toBe("center");

  await userEvent.click(summary);
  expect(row.open).toBe(false);
  await expect.element(body).not.toBeVisible();
});
