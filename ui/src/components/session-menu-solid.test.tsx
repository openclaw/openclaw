/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { menuItem, menuItemLabels } from "../test-helpers/session-menu.ts";
import { createSessionOwnerMenuHarness } from "../test-helpers/session-owner-menu.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { EMPTY_SESSION_MENU_DATA } from "./session-menu-actions.ts";
import { SessionMenu, type SessionMenuWork } from "./session-menu.ts";

it("updates Solid menu props and retires its keyboard owner when unmounted", async () => {
  const [archived, setArchived] = createSignal(false);
  const calls: string[] = [];
  const mounted = mountSolid(() => (
    <SessionMenu
      session={{ ...EMPTY_SESSION_MENU_DATA, label: "Synthetic session", archived: archived() }}
      archiveAllowed
      deleteAllowed
      onClose={() => calls.push("close")}
      onAction={(action) => calls.push(action.kind)}
    />
  ));
  await waitForSolid(() =>
    expect(mounted.container.querySelector('[value="toggle-archived"]')?.textContent).toContain(
      "Archive session",
    ),
  );
  setArchived(true);
  flush();
  expect(mounted.container.querySelector('[value="toggle-archived"]')?.textContent).toContain(
    "Restore session",
  );
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
  mounted.unmount();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
});

it("preserves focused rows and an open owner search across external updates", async () => {
  const { context } = createSessionOwnerMenuHarness();
  const provider = createSolidApplicationContextProvider(context);
  const [session, setSession] = createSignal({ ...EMPTY_SESSION_MENU_DATA, label: "First title" });
  const [work, setWork] = createSignal<SessionMenuWork | null>(null);
  const mounted = mountSolid(
    () => <SessionMenu session={session()} work={work()} archiveAllowed />,
    {
      wrapper: provider.wrapper,
    },
  );
  const host = mounted.container.querySelector("openclaw-session-menu")!;
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Assign to…"));
  const pin = menuItem(host, "Pin session");
  await pin.updateComplete;
  pin.focus();
  setSession((current) => ({ ...current, label: "Fresh title" }));
  flush();
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
  setSession((current) => ({ ...current, unread: true }));
  setWork({ loading: false, pullRequestUrl: "https://example.test/pull/1", worktreePath: null });
  flush();
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Open PR"));
  expect(menuItem(host, "Assign to…")).toBe(owner);
  expect(owner.getAttribute("aria-expanded")).toBe("true");
  expect(owner.querySelector('input[type="search"]')).toBe(search);
  expect(search.value).toBe("Research");
  expect(document.activeElement).toBe(search);
  expect(menuItemLabels(host)).toContain("Mark as read");
});
