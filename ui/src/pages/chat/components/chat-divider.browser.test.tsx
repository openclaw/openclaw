import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatNotice } from "./chat-divider.tsx";
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
] as const)("keeps plugin steering collapsed and readable in %s at %ipx", async (theme, width) => {
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
  const notice = view.container.querySelector<HTMLElement>(".chat-notice")!;
  const details = notice.querySelector<HTMLDetailsElement>("details")!;
  const body = notice.querySelector<HTMLElement>(".chat-notice__body")!;
  const metric = notice.querySelector<HTMLElement>(".chat-divider__metric")!;
  const header = notice.querySelector<HTMLElement>(".chat-divider__label")!;
  const toggle = view.getByText("Show content");

  await expect.element(view.getByText(label)).toBeVisible();
  await expect.element(metric).toBeVisible();
  expect(metric.textContent).toBe("2:37 PM");
  expect(details.open).toBe(false);
  await expect.element(body).not.toBeVisible();
  expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);

  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(details.open).toBe(true);
  await expect.element(body).toBeVisible();
  await expect.element(view.getByText("Hide content")).toBeVisible();
  expect(body.textContent?.trim()).toBe("Check the rollback path before continuing.");
  expect(body.querySelector("strong")?.textContent).toBe("rollback path");
  expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
  const textRange = document.createRange();
  textRange.selectNodeContents(body.querySelector("p")!);
  const textBounds = textRange.getBoundingClientRect();
  const headerBounds = header.getBoundingClientRect();
  const textCenter = textBounds.left + textBounds.width / 2;
  const headerCenter = headerBounds.left + headerBounds.width / 2;
  expect(Math.abs(textCenter - headerCenter)).toBeLessThanOrEqual(1);

  await userEvent.click(view.getByText("Hide content"));
  expect(details.open).toBe(false);
  await expect.element(body).not.toBeVisible();
  await expect.element(view.getByText("Show content")).toBeVisible();
});
