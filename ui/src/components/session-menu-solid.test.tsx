/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import {
  menuItem,
  menuItemLabels,
  mountMenu,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import { createSessionOwnerMenuHarness } from "../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

it("updates registered menu props and retires its keyboard owner when unmounted", async () => {
  const calls: string[] = [];
  const host = await mountMenu({
    session: { label: "Synthetic session", archived: false },
    archiveAllowed: true,
    deleteAllowed: true,
    onClose: () => calls.push("close"),
    onAction: (action) => calls.push(action.kind),
  });
  await waitForSolid(() =>
    expect(host.querySelector('[value="toggle-archived"]')?.textContent).toContain(
      "Archive session",
    ),
  );
  host.session = { ...host.session, archived: true };
  await settleSessionMenu(host);
  expect(host.querySelector('[value="toggle-archived"]')?.textContent).toContain("Restore session");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
  host.remove();
  await Promise.resolve();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
});

it("preserves focused rows and an open owner search across external updates", async () => {
  const { context } = createSessionOwnerMenuHarness();
  const host = await mountMenu({
    context,
    session: { label: "First title" },
    archiveAllowed: true,
  });
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Assign to…"));
  const pin = menuItem(host, "Pin session");
  await pin.updateComplete;
  pin.focus();
  host.session = { ...host.session, label: "Fresh title" };
  await settleSessionMenu(host);
  expect(menuItem(host, "Pin session")).toBe(pin);
  expect(document.activeElement).toBe(pin);

  const owner = menuItem(host, "Assign to…");
  owner.click();
  await waitForSolid(() => expect(owner.getAttribute("aria-expanded")).toBe("true"));
  const search = owner.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "Research";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => expect(menuItemLabels(owner)).toEqual(["Research"]));
  search.focus();
  host.session = { ...host.session, unread: true };
  host.work = { loading: false, pullRequestUrl: "https://example.test/pull/1", worktreePath: null };
  await settleSessionMenu(host);
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Open PR"));
  expect(menuItem(host, "Assign to…")).toBe(owner);
  expect(owner.getAttribute("aria-expanded")).toBe("true");
  expect(owner.querySelector('input[type="search"]')).toBe(search);
  expect(search.value).toBe("Research");
  expect(document.activeElement).toBe(search);
  expect(menuItemLabels(host)).toContain("Mark as read");
});
