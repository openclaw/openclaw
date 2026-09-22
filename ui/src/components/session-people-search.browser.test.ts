import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderChatSessionSharing } from "../pages/chat/components/chat-session-sharing.ts";
import { mountMenu } from "../test-helpers/session-menu.ts";
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
    [21, 1000].map((count) => ({ surface, count })),
  ),
)(
  "keeps $surface search editable, pages bounded, and keyboard selection intact ($count entries)",
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
      const groups = [
        ...root.querySelectorAll<HTMLElement>(
          ":scope > wa-dropdown > wa-dropdown-item:not([disabled])",
        ),
      ];
      const assignment = groups.findIndex(
        (item) => item.querySelector(".session-menu__text")?.textContent?.trim() === "Assign to…",
      );
      expect(assignment).toBeGreaterThanOrEqual(0);
      await expect.element(page.getByText("Assign to…", { exact: true })).toBeVisible();
      groups[assignment]!.focus();
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
    const selector = surface !== "members" ? '[value^="assign-owner:"]' : '[value^="member:"]';
    await expect.poll(() => root.querySelectorAll(selector).length).toBe(20);
    if (surface === "compact assignment") {
      await expect.poll(() => document.activeElement?.getAttribute("value")).toBe("compact:back");
    }
    await userEvent.keyboard("{End}");
    await expect
      .poll(() => document.activeElement)
      .toBe([...root.querySelectorAll(selector)].at(-1));
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(input.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Next", exact: true }).element(),
    );
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => root.querySelectorAll(selector).length)
      .toBe(Math.min(20, count + (surface === "members" ? 0 : 2) - 20));
    expect(root.querySelector(selector)?.textContent).toContain(
      surface !== "members" ? "Person 0018" : "Person 0020",
    );
    const next = page.getByRole("button", { name: "Next", exact: true }).element();
    if (!next.hasAttribute("disabled")) {
      await userEvent.keyboard("{Tab}{Tab}");
    }
    expect(document.activeElement).toBe(input.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Previous", exact: true }).element(),
    );
    await userEvent.keyboard("{Enter}");
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
