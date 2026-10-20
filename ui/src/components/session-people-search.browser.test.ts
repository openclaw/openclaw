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

it.each(
  (["assignment", "compact assignment", "members"] as const).flatMap((surface) =>
    [60, 101].map((count) => ({ surface, count })),
  ),
)(
  "shows every $surface entry with editable search and keyboard selection ($count entries)",
  async ({ surface, count }) => {
    await page.viewport(surface === "compact assignment" ? 414 : 1280, 900);
    const shown = new Promise<void>((resolve) => {
      document.addEventListener("overlay-after-show", () => resolve(), {
        once: true,
        capture: true,
      });
    });
    const onAction = vi.fn();
    let root: HTMLElement;
    let returnTarget: HTMLElement;
    let reopen: () => Promise<void>;
    if (surface !== "members") {
      const { context } = createSessionOwnerMenuHarness(() =>
        sessionOwnerProfiles(
          ...Array.from({ length: count }, (_, i) => `Person ${String(i).padStart(4, "0")}`),
        ),
      );
      const triggerRoot = document.createElement("div");
      triggerRoot.innerHTML = '<button type="button">Session actions</button>';
      roots.push(triggerRoot);
      document.body.append(triggerRoot);
      returnTarget = triggerRoot.querySelector("button")!;
      const menu = await mountMenu({
        context,
        onAction,
        compact: surface === "compact assignment",
        trigger: returnTarget,
      });
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
      returnTarget = root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")!;
      reopen = async () => {
        await userEvent.click(trigger);
      };
      returnTarget.focus();
      await userEvent.keyboard("{Enter}");
      await shown;
    }
    const afterMenu = document.createElement("button");
    afterMenu.textContent = "After menu";
    roots.push(afterMenu);
    document.body.append(afterMenu);
    const input = page.getByRole("searchbox", { name: "Search people and agents…" });
    await expect.element(input).toBeVisible();
    if (surface === "assignment") {
      const submenu = input.element().closest('[role="menu"]');
      const style = submenu ? getComputedStyle(submenu) : null;
      expect(style?.width).toBe("320px");
      expect(style?.maxHeight).toBe("420px");
      expect(style?.overflowY).toBe("auto");
    }
    const selector =
      surface !== "members" ? '[data-value^="assign-owner:"]' : '[data-value^="member:"]';
    await expect
      .poll(() => root.querySelectorAll(selector).length)
      .toBe(count + (surface === "members" ? 0 : 2));
    await expect
      .element(page.getByRole("button", { name: "Next", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Previous", exact: true }))
      .not.toBeInTheDocument();
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
    await expect.element(input).toBeVisible();
    await userEvent.click(input);
    await userEvent.keyboard("pc");
    expect(onAction).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue("pc");
    await expect
      .element(page.getByText("No matching people or agents", { exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
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
      expect(onAction).toHaveBeenCalledWith(`person-${count - 1}`, true);
    }
  },
);
