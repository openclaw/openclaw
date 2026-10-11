/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  mountMenu,
  menuItem,
  menuItemLabels,
  selectMenuValue,
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
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:main:old",
        agentId: "main",
      }),
    );
    expect(choice(menu, "send", "always").disabled).toBe(true);
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
      expect(choice(menu, "send", "ask").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(choice(menu, "send", "always").disabled).toBe(false);
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
    expect(choice(menu, "send", "ask").getAttribute("aria-pressed")).toBe("true");
    expect(choice(menu, "receive", "always").getAttribute("aria-pressed")).toBe("true");
  });

  it("groups settings and shows only Gateway-resolved selections in inline pickers", async () => {
    const menu = await mountMenu({ session: { effectiveCommunication: policy } });
    const settings = menuItem(menu, "Advanced");
    expect(menuItemLabels(menu)).not.toContain("Icon & color");
    expect(menuItemLabels(menu)).not.toContain("Assign to…");
    expect(menuItemLabels(menu)).toContain("Move to group");
    expect(menuItemLabels(settings)).toEqual([
      "Icon & color",
      "Fork conversation",
      "Copy details",
      "Open in",
      "Delete…",
    ]);
    expect(settings.querySelector('[role="group"][aria-label="Send messages"]')).not.toBeNull();
    expect(settings.querySelector('[role="group"][aria-label="Receive messages"]')).not.toBeNull();
    expect(choice(settings, "send", "never").getAttribute("aria-pressed")).toBe("true");
    expect(choice(settings, "receive", "ask").getAttribute("aria-pressed")).toBe("true");
    expect(choice(settings, "send", "never").title).toBe("default");
    expect(menu.querySelector('[value="communication:reset"]')).toBeNull();
  });

  it("dispatches only the selected direction and resets raw overrides together", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      onAction,
    });
    choice(menu, "receive", "always").click();
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "set-communication",
      communication: { receive: "always" },
    });
    selectMenuValue(menu, "communication:reset");
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-communication", communication: null });
    expect(choice(menu, "send", "never").title).toBe("");
  });

  it("keeps inline choices in compact settings and returns from appearance through settings to root", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      compact: true,
      session: { effectiveCommunication: policy },
      onAction,
    });
    selectMenuValue(menu, "compact:open-advanced");
    await menu.updateComplete;
    expect(menuItem(menu, "Back").getAttribute("value")).toBe("compact:back");
    expect(choice(menu, "receive", "ask").getAttribute("aria-pressed")).toBe("true");
    expect(menu.querySelector('[slot="submenu"]')).toBeNull();
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
      selectMenuValue(menu, `compact:open-${view}`);
      await menu.updateComplete;
      expect(menuItem(menu, "Back").getAttribute("value")).toBe("compact:back-advanced");
      selectMenuValue(menu, "compact:back-advanced");
      await menu.updateComplete;
      expect(choice(menu, "receive", "ask")).toBeTruthy();
    }
    choice(menu, "receive", "never").click();
    expect(onAction).toHaveBeenCalledWith({
      kind: "set-communication",
      communication: { receive: "never" },
    });
    selectMenuValue(menu, "compact:back");
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toContain("Advanced");
    expect(menu.querySelector('[role="group"]')).toBeNull();
  });

  it("preserves denied reasons and refuses synthesized changes", async () => {
    const onAction = vi.fn();
    const reason = "Only the session creator or an admin can make this change.";
    const menu = await mountMenu({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      actionDisabledReasons: { "set-communication": reason },
      onAction,
    });
    expect(choice(menu, "send", "always").disabled).toBe(true);
    expect(choice(menu, "send", "always").title).toBe(reason);
    choice(menu, "send", "always").click();
    selectMenuValue(menu, "communication:send:always");
    selectMenuValue(menu, "communication:reset");
    expect(onAction).not.toHaveBeenCalled();
    expect(menuItem(menu, "Reset").disabled).toBe(true);
  });

  it("keeps missing metadata visibly unselected and disables edits; batch settings remain unavailable", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({ onAction });
    expect(choice(menu, "send", "always").disabled).toBe(true);
    expect(menu.querySelector('.session-menu__communication [aria-pressed="true"]')).toBeNull();
    selectMenuValue(menu, "communication:send:always");
    expect(onAction).not.toHaveBeenCalled();
    const batch = await mountMenu({
      session: { effectiveCommunication: policy },
      selectionCount: 2,
    });
    expect(menuItemLabels(batch)).not.toContain("Advanced");
  });
});
