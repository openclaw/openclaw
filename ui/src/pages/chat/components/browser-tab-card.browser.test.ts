import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../test-helpers/load-styles.ts";
import "./browser-tab-card.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("shows action icons and supports copy, external opening, and keyboard dismissal", async () => {
  const card = document.createElement("openclaw-browser-tab-card");
  const url = "https://example.com/project";
  card.preview = {
    kind: "browser-tab",
    target: "host",
    profile: "managed",
    targetId: "menu-tab",
    url,
  };
  document.body.append(card);
  await card.updateComplete;
  const trigger = card.shadowRoot!.querySelector<HTMLButtonElement>(".more")!;
  const dropdown = card.shadowRoot!.querySelector("wa-dropdown")!;
  const copy = card.shadowRoot!.querySelector<HTMLElement>('[value="copy-url"]')!;
  const open = card.shadowRoot!.querySelector<HTMLElement>('[value="open-new-tab"]')!;
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const openWindow = vi.spyOn(window, "open").mockReturnValue(null);

  await page.elementLocator(trigger).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy URL", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: "Open in new tab", exact: true }))
    .toBeVisible();
  for (const item of [copy, open]) {
    const icon = item.querySelector<SVGElement>("svg")!;
    expect(icon).not.toBeNull();
    expect(icon.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(icon.getBoundingClientRect().height).toBeGreaterThan(0);
  }
  await expect.poll(() => card.shadowRoot!.activeElement).toBe(copy);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => card.shadowRoot!.activeElement).toBe(open);
  await userEvent.keyboard("{ArrowUp}");
  await expect.poll(() => card.shadowRoot!.activeElement).toBe(copy);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => dropdown.open).toBe(false);
  await expect.poll(() => card.shadowRoot!.activeElement).toBe(trigger);

  await userEvent.keyboard("{Enter}");
  await expect.poll(() => card.shadowRoot!.activeElement).toBe(copy);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => writeText.mock.calls).toEqual([[url]]);
  await expect.poll(() => dropdown.open).toBe(false);
  await page.elementLocator(trigger).click();
  await page.elementLocator(open).click();
  expect(openWindow).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
  await expect.poll(() => dropdown.open).toBe(false);
  await expect.poll(() => card.shadowRoot!.activeElement).toBe(trigger);
});
