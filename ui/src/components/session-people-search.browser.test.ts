import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  menuItem,
  mountMenu,
  openSubmenu,
  selectMenuValue,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import "../test-helpers/load-styles.ts";
import { mountPeopleSharing } from "./session-people-search.test-support.ts";

const roots: HTMLElement[] = [];
afterEach(() => roots.splice(0).forEach((root) => root.remove()));

function appendButton(textContent: string) {
  const button = document.body.appendChild(
    Object.assign(document.createElement("button"), { textContent, type: "button" }),
  );
  roots.push(button);
  return button;
}

it.each(
  (["assignment", "compact assignment", "members"] as const).flatMap((surface) =>
    [60, 101].map((count) => ({ surface, count })),
  ),
)(
  "shows every $surface entry with editable search and keyboard selection ($count entries)",
  async ({ surface, count }) => {
    const compact = surface === "compact assignment";
    await page.viewport(compact ? 414 : 1280, 900);
    const shown = new Promise<void>((resolve) => {
      document.addEventListener("overlay-after-show", () => resolve(), {
        once: true,
        capture: true,
      });
    });
    const onAction = vi.fn();
    let root: HTMLElement;
    let reopen: () => Promise<void>;
    if (surface !== "members") {
      const names = Array.from({ length: count }, (_, i) => `Person ${String(i).padStart(4, "0")}`);
      const { context } = createSessionOwnerMenuHarness(() => sessionOwnerProfiles(...names));
      const returnTarget = appendButton("Session actions");
      const menu = await mountMenu({ context, onAction, compact, trigger: returnTarget });
      root = menu;
      reopen = async () => {
        menu.anchor = { x: 100, y: 100 };
        await settleSessionMenu(menu);
        if (surface === "assignment") {
          await openSubmenu(menu, "Assign to…");
        } else if (menu.querySelector('[data-value="compact:open-assign-owner"]')) {
          await selectMenuValue(menu, "compact:open-assign-owner");
          await settleSessionMenu(menu);
        }
      };
      await shown;
      await expect.element(page.getByText("Assign to…", { exact: true })).toBeVisible();
      const assignment = menuItem(root, "Assign to…");
      // A resting pointer opens the submenu first; Enter on its owner must not select a row.
      await userEvent.hover(assignment);
      assignment.focus();
      await userEvent.keyboard("{Enter}");
    } else {
      root = mountPeopleSharing(count, onAction);
      const trigger = page.getByRole("button", { name: "Session sharing", exact: true });
      await expect.element(trigger).toBeVisible();
      const returnTarget = root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")!;
      reopen = () => userEvent.click(trigger);
      returnTarget.focus();
      await userEvent.keyboard("{Enter}");
      await shown;
    }
    const afterMenu = appendButton("After menu");
    const input = page.getByRole("searchbox", {
      name: surface === "members" ? "Search people…" : "Search people and agents…",
    });
    const sharingSearch = page.getByRole("button", { name: "Search people…", exact: true });
    if (surface === "members") {
      await expect.element(sharingSearch).toHaveAttribute("aria-expanded", "false");
    } else {
      await expect.element(input).toBeVisible();
    }
    if (surface === "assignment") {
      const style = getComputedStyle(input.element().closest('[role="menu"]')!);
      expect(style).toMatchObject({ width: "320px", maxHeight: "420px", overflowY: "auto" });
    }
    const selector =
      surface !== "members"
        ? '[data-value^="assign-owner:"]'
        : 'button.chat-pane__sharing-permission[data-value^="permission:"]';
    await expect
      .poll(() => root.querySelectorAll(selector).length)
      .toBe(count + (surface === "members" ? 0 : 2));
    for (const name of ["Next", "Previous"]) {
      await expect.element(page.getByRole("button", { name, exact: true })).not.toBeInTheDocument();
    }
    if (surface === "compact assignment") {
      await expect
        .poll(() => document.activeElement?.getAttribute("data-value"))
        .toBe("compact:back");
    }
    await userEvent.keyboard("{End}");
    await expect
      .poll(() => document.activeElement)
      .toBe([...root.querySelectorAll(selector)].at(-1));
    await userEvent.keyboard("{Tab}");
    await expect.element(input).not.toBeInTheDocument();
    expect(document.activeElement).toBe(afterMenu);
    await reopen();
    if (surface === "members") {
      await userEvent.click(sharingSearch);
    }
    await expect.element(input).toBeVisible();
    if (surface === "members") {
      await userEvent.click(input);
    }
    // Assignment typing must enter the visible search without a separate click.
    await userEvent.keyboard("pc");
    expect(onAction).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue("pc");
    await expect
      .element(
        page.getByText(surface === "members" ? "No people found" : "No matching people or agents", {
          exact: true,
        }),
      )
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    if (surface === "members") {
      await expect.element(sharingSearch).toHaveAttribute("aria-expanded", "false");
      expect(document.activeElement).toBe(sharingSearch.element());
      await userEvent.click(sharingSearch);
    }
    await expect.element(input).toHaveValue("");
    await expect.element(input).toBeVisible();
    expect(document.activeElement).toBe(input.element());
    await input.fill(`Person ${String(count - 1).padStart(4, "0")}`);
    await expect.poll(() => root.querySelectorAll(selector).length).toBe(1);
    await userEvent.keyboard(count === 101 ? "{Enter}" : "{ArrowDown}");
    expect(document.activeElement).toBe(root.querySelector(selector));
    expect(onAction).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    if (surface !== "members") {
      expect(onAction).toHaveBeenCalledWith({
        kind: "assign-owner",
        owner: { type: "human", id: `profile-person-${String(count - 1).padStart(4, "0")}` },
      });
    } else {
      const read = page.getByRole("menuitemradio", { name: "Can read", exact: true });
      const send = page.getByRole("menuitemradio", { name: "Can send", exact: true });
      await expect.element(read).toHaveAttribute("aria-checked", "true");
      await expect.poll(() => document.activeElement).toBe(read.element());
      expect(onAction).not.toHaveBeenCalled();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(send.element());
      await userEvent.keyboard("{Enter}");
      expect(onAction).toHaveBeenCalledWith(`person-${count - 1}`, true);
    }
  },
);
