/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  mountMenu,
  menuPanel,
  openSubmenu,
  menuItem,
  menuItemLabels,
  selectMenuValue,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";

const policy = { send: "never", receive: "ask" } as const;

function choice(menu: ParentNode, direction: "send" | "receive", mode: "always" | "ask" | "never") {
  const button = menu.querySelector<HTMLButtonElement>(
    `button[value="communication:${direction}:${mode}"]`,
  );
  if (!button) {
    throw new Error("Expected inline communication choice");
  }
  return button;
}

describe("session communication menu", () => {
  it("loads full settings for compact rows and rejects a late descriptor from a previous target", async () => {
    const oldReply = createDeferred<{ session: GatewaySessionRow }>();
    const nextReply = createDeferred<{ session: GatewaySessionRow }>();
    const { context, request } = createSessionOwnerMenuHarness((method, params) => {
      if (method === "sessions.describe") {
        return (isRecord(params) && params.key === "agent:main:old" ? oldReply : nextReply).promise;
      }
      return sessionOwnerProfiles("Ada");
    });
    const menu = await mountMenu({
      context,
      session: { target: { key: "agent:main:old", agentId: "main" }, sessionId: "old-id" },
    });
    const advanced = await openSubmenu(menu, "Advanced");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:main:old",
        agentId: "main",
      }),
    );
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    menu.session = {
      ...menu.session,
      target: { key: "agent:main:next", agentId: "main" },
      sessionId: "next-id",
    };
    await menu.updateComplete;
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:main:next",
        agentId: "main",
      }),
    );
    nextReply.resolve({
      session: {
        key: "agent:main:next",
        sessionId: "next-id",
        kind: "direct",
        updatedAt: 1,
        effectiveCommunication: { send: "ask", receive: "always" },
      },
    });
    await waitForFast(() =>
      expect(choice(advanced, "send", "ask").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(choice(advanced, "send", "always").disabled).toBe(false);
    oldReply.resolve({
      session: {
        key: "agent:main:old",
        sessionId: "old-id",
        kind: "direct",
        updatedAt: 1,
        effectiveCommunication: { send: "never", receive: "never" },
      },
    });
    await oldReply.promise;
    await menu.updateComplete;
    expect(choice(advanced, "send", "ask").getAttribute("aria-pressed")).toBe("true");
    expect(choice(advanced, "receive", "always").getAttribute("aria-pressed")).toBe("true");
  });

  it("dispatches only the selected direction and resets raw overrides together", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      onAction,
    });
    const advanced = await openSubmenu(menu, "Advanced");
    choice(advanced, "receive", "always").click();
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "set-communication",
      communication: { receive: "always" },
    });
    menu.anchor = { x: 100, y: 100 };
    await settleSessionMenu(menu);
    const reopened = await openSubmenu(menu, "Advanced");
    expect(choice(reopened, "send", "never").title).toBe("");
    await selectMenuValue(menu, "communication:reset");
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-communication", communication: null });
  });

  it("keeps inline choices in compact settings and returns from appearance through settings to root", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      compact: true,
      session: { effectiveCommunication: policy },
      onAction,
    });
    await selectMenuValue(menu, "compact:open-advanced");
    await settleSessionMenu(menu);
    expect(menuItem(menu, "Back").getAttribute("data-value")).toBe("compact:back");
    expect(choice(menu, "receive", "ask").getAttribute("aria-pressed")).toBe("true");
    expect(menuPanel(menu).querySelector('[role="menu"]')).toBeNull();
    // jsdom has no layout; the communication controls in this fixture are visible.
    for (const control of menu.querySelectorAll<HTMLElement>(
      ".session-menu__communication-choice",
    )) {
      control.checkVisibility = () => true;
    }
    const appearance = menuItem(menu, "Icon & color");
    appearance.focus();
    appearance.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(choice(menu, "send", "always"));
    choice(menu, "send", "always").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(menuItem(menu, "Open in"));
    for (const view of ["icon", "copy", "open-in"]) {
      await selectMenuValue(menu, `compact:open-${view}`);
      await settleSessionMenu(menu);
      expect(menuItem(menu, "Back").getAttribute("data-value")).toBe("compact:back-advanced");
      await selectMenuValue(menu, "compact:back-advanced");
      await settleSessionMenu(menu);
      expect(choice(menu, "receive", "ask")).toBeTruthy();
    }
    await selectMenuValue(menu, "compact:back");
    await settleSessionMenu(menu);
    expect(menuItemLabels(menu)).toContain("Advanced");
    expect(menu.querySelector('[role="group"]')).toBeNull();
    await selectMenuValue(menu, "compact:open-advanced");
    await settleSessionMenu(menu);
    choice(menu, "receive", "never").click();
    expect(onAction).toHaveBeenCalledWith({
      kind: "set-communication",
      communication: { receive: "never" },
    });
    expect(menuPanel(menu).matches(":popover-open")).toBe(false);
  });

  it("preserves denied reasons and refuses disabled controls", async () => {
    const onAction = vi.fn();
    const reason = "Only the session creator or an admin can make this change.";
    const menu = await mountMenu({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      actionDisabledReasons: { "set-communication": reason },
      onAction,
    });
    const advanced = await openSubmenu(menu, "Advanced");
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    expect(choice(advanced, "send", "always").title).toBe(reason);
    choice(advanced, "send", "always").click();
    const reset = menuItem(advanced, "Reset");
    expect(reset.disabled).toBe(true);
    reset.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps missing metadata visibly unselected and disables edits; batch settings remain unavailable", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({ onAction });
    const advanced = await openSubmenu(menu, "Advanced");
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    expect(advanced.querySelector('.session-menu__communication [aria-pressed="true"]')).toBeNull();
    choice(advanced, "send", "always").click();
    expect(onAction).not.toHaveBeenCalled();
    const batch = await mountMenu({
      session: { effectiveCommunication: policy },
      selectionCount: 2,
    });
    expect(menuItemLabels(batch)).not.toContain("Advanced");
  });
});
