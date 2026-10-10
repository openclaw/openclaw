import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderChatSessionSharing } from "../pages/chat/components/chat-session-sharing.ts";
import { menuItem, mountMenu } from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../test-helpers/load-styles.ts";

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
      document.addEventListener("wa-after-show", () => resolve(), { once: true, capture: true });
    });
    const onAction = vi.fn();
    let root: HTMLElement;
    if (surface !== "members") {
      const { context } = createSessionOwnerMenuHarness(() =>
        sessionOwnerProfiles(
          ...Array.from({ length: count }, (_, i) => `Person ${String(i).padStart(4, "0")}`),
        ),
      );
      root = await mountMenu({ context, onAction, compact: surface === "compact assignment" });
      await shown;
      const settings = menuItem(root, "Session settings");
      settings.focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("Assign to…", { exact: true })).toBeVisible();
      const assignment = menuItem(root, "Assign to…");
      // A resting pointer opens the submenu first; Enter on its owner must not select a row.
      await userEvent.hover(assignment);
      assignment.focus();
      await userEvent.keyboard("{Enter}");
    } else {
      root = document.createElement("div");
      roots.push(root);
      document.body.append(root);
      render(
        html`${renderChatSessionSharing({
          session: { key: "agent:main:people", kind: "direct", updatedAt: 1, sharingRole: "owner" },
          state: {
            loading: false,
            result: {
              sessionKey: "agent:main:people",
              role: "owner",
              allowedVisibilities: ["shared"],
              members: [],
              identities: Array.from({ length: count }, (_, i) => ({
                type: "human" as const,
                id: `person-${i}`,
                label: `Person ${String(i).padStart(4, "0")}`,
              })),
            },
          },
          onOpen: vi.fn(),
          onVisibilityChange: vi.fn(),
          onMemberChange: onAction,
        })}`,
        root,
      );
      const trigger = page.getByRole("button", { name: "Session sharing", exact: true });
      await expect.element(trigger).toBeVisible();
      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await shown;
    }
    const input = page.getByRole("searchbox", { name: "Search people and agents…" });
    await expect.element(input).toBeVisible();
    if (surface === "assignment") {
      const submenu = input
        .element()
        .closest("wa-dropdown-item")
        ?.shadowRoot?.querySelector('[part="submenu"]');
      const style = submenu ? getComputedStyle(submenu) : null;
      expect(style?.width).toBe("320px");
      expect(style?.maxHeight).toBe("420px");
      expect(style?.overflowY).toBe("auto");
    }
    const selector = surface !== "members" ? '[value^="assign-owner:"]' : '[value^="member:"]';
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
        .poll(() => document.activeElement?.getAttribute("value"))
        .toBe("compact:back-settings");
    }
    await userEvent.keyboard("{End}");
    await expect
      .poll(() => document.activeElement)
      .toBe([...root.querySelectorAll(selector)].at(-1));
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(input.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(root.querySelector(selector));
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(input.element());
    await userEvent.keyboard("pc");
    expect(onAction).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue("pc");
    await expect
      .element(page.getByText("No matching people or agents", { exact: true }))
      .toBeVisible();
    await input.fill(`Person ${String(count - 1).padStart(4, "0")}`);
    await expect.poll(() => root.querySelectorAll(selector).length).toBe(1);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(root.querySelector(selector));
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
