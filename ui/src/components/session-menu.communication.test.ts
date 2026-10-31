/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import {
  mountMenu,
  menuPanel,
  openSubmenu,
  menuItem,
  selectMenuValue,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { createSessionMenuSettings } from "./session-menu-settings.ts";

const policy = { send: "never", receive: "ask" } as const;
const target = (name = "settings") => ({
  target: { key: `agent:main:${name}`, ...(name === "settings" ? {} : { agentId: "main" }) },
  sessionId: `${name}-id`,
});
function descriptor(
  name = "settings",
  effectiveCommunication: GatewaySessionRow["effectiveCommunication"] = policy,
) {
  const key = target(name).target.key;
  const sessionId = `${name}-id`;
  return {
    session: { key, sessionId, kind: "direct" as const, updatedAt: 1, effectiveCommunication },
  };
}
const keyOptions = { key: "Tab", bubbles: true, composed: true, cancelable: true };
const keydown = (shiftKey = false) => new KeyboardEvent("keydown", { ...keyOptions, shiftKey });

function settingsHarness(read: (params?: unknown) => unknown) {
  return createSessionOwnerMenuHarness((method, params) =>
    method === "sessions.describe" ? read(params) : sessionOwnerProfiles("Ada"),
  );
}
async function setup(options: Parameters<typeof mountMenu>[0] = {}) {
  const onAction = vi.fn();
  const menu = await mountMenu({ onAction, ...options });
  return { menu, advanced: await openSubmenu(menu, "Advanced"), onAction };
}
type Direction = keyof typeof policy;
type Mode = "always" | "ask" | "never";
function pressed(menu: ParentNode, direction: Direction, mode: Mode) {
  return choice(menu, direction, mode).getAttribute("aria-pressed");
}
function choice(menu: ParentNode, direction: Direction, mode: Mode) {
  return menu.querySelector<HTMLButtonElement>(
    `button[value="communication:${direction}:${mode}"]`,
  )!;
}

describe("session communication menu", () => {
  it("does not notify row consumers when empty settings are closed again", () => {
    const { settings, read, dispose } = createRoot((disposeRoot) => {
      const menuSettings = createSessionMenuSettings({
        context: () => undefined,
        readState: () => ({ session: { sessionId: null }, selectionCount: 0 }),
        runAction: () => {},
      });
      const readRow = vi.fn(menuSettings.row);
      createEffect(readRow, () => {});
      return { settings: menuSettings, read: readRow, dispose: disposeRoot };
    });
    try {
      flush();
      settings.close();
      flush();
      settings.close();
      flush();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it.each([
    { compact: false, involvingMeContext: false },
    { compact: true, involvingMeContext: false },
    { compact: false, involvingMeContext: true },
    { compact: true, involvingMeContext: true },
  ])(
    "separates Advanced sections once in $compact menus with list context $involvingMeContext",
    async (options) => {
      const owner = settingsHarness(() => descriptor());
      owner.publish({
        hello: {
          ...gatewayHelloForMethods(["sessions.setInvolvement"]),
          policy: { hasMultipleSessionSharingIdentities: true },
        },
      });
      const menu = await mountMenu({
        context: owner.context,
        session: { hiddenFromInvolvingMe: false },
        ...options,
      });
      const advanced = options.compact
        ? (await selectMenuValue(menu, "compact:open-advanced"), menuPanel(menu))
        : await openSubmenu(menu, "Advanced");
      expect(
        [...advanced.querySelectorAll('[role="separator"]')].filter(
          (element) => element.closest('[role="menu"]') === advanced,
        ),
      ).toHaveLength((options.involvingMeContext ? 2 : 3) + Number(options.compact));
      expect(advanced.querySelector('[data-value="toggle-involving-me"]') !== null).toBe(
        !options.involvingMeContext,
      );
    },
  );

  it("loads compact settings and ignores the previous target reply", async () => {
    const oldReply = createDeferred<{ session: GatewaySessionRow }>();
    const nextReply = createDeferred<{ session: GatewaySessionRow }>();
    const { context, request } = settingsHarness(
      (params) =>
        (isRecord(params) && params.key === "agent:main:old" ? oldReply : nextReply).promise,
    );
    const { menu, advanced } = await setup({ context, session: target("old") });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", target("old").target),
    );
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    menu.session = { ...menu.session, ...target("next") };
    await menu.updateComplete;
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", target("next").target),
    );
    nextReply.resolve(descriptor("next", { send: "ask", receive: "always" }));
    await waitForFast(() => expect(pressed(advanced, "send", "ask")).toBe("true"));
    expect(choice(advanced, "send", "always").disabled).toBe(false);
    oldReply.resolve(descriptor("old", { send: "never", receive: "never" }));
    await oldReply.promise;
    await menu.updateComplete;
    expect(pressed(advanced, "send", "ask")).toBe("true");
    expect(pressed(advanced, "receive", "always")).toBe("true");
  });

  it("retires settings on disconnect and reloads after reconnect", async () => {
    const oldReply = createDeferred<{ session: GatewaySessionRow }>();
    const { context, publish } = settingsHarness(() => oldReply.promise);
    const { menu, advanced } = await setup({ context, session: target() });
    publish({ phase: "reconnecting" });
    await settleSessionMenu(menu);
    oldReply.reject(new Error("Retired connection"));
    await settleSessionMenu(menu);
    expect(advanced.querySelector('[role="alert"]')).toBeNull();
    const { request } = settingsHarness(() =>
      descriptor("settings", { send: "ask", receive: "always" }),
    );
    publish({ phase: "connected", client: createTestGatewayClient(request) });
    await waitForFast(() => {
      expect(pressed(advanced, "send", "ask")).toBe("true");
      expect(choice(advanced, "receive", "always").disabled).toBe(false);
    });
    expect(advanced.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows descriptor failures and retries through the settings menu", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("Settings unavailable"))
      .mockResolvedValue(descriptor());
    const { context } = settingsHarness(read);
    const { menu, advanced } = await setup({ context, session: target() });
    await waitForFast(() => expect(advanced.textContent).toContain("Settings unavailable"));
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    expect(advanced.querySelectorAll(':scope > [role="separator"]')).toHaveLength(2);
    await selectMenuValue(menu, "reload-settings");
    await waitForFast(() => expect(pressed(advanced, "send", "never")).toBe("true"));
    expect(advanced.textContent).not.toContain("Settings unavailable");
    expect(advanced.querySelectorAll(':scope > [role="separator"]')).toHaveLength(2);
  });

  it("dispatches only the selected direction and resets raw overrides together", async () => {
    const { menu, advanced, onAction } = await setup({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
    });
    choice(advanced, "receive", "always").click();
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "set-communication",
      communication: { receive: "always" },
    });
    menu.anchor = { x: 100, y: 100 };
    await settleSessionMenu(menu);
    const reopened = await openSubmenu(menu, "Advanced");
    expect(choice(reopened, "send", "never").title).toBe("");
    expect(reopened.querySelectorAll(':scope > [role="separator"]')).toHaveLength(2);
    await selectMenuValue(menu, "communication:reset");
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-communication", communication: null });
  });

  it("navigates compact submenus and focuses inline choices", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      compact: true,
      session: { effectiveCommunication: policy },
      onAction,
    });
    await selectMenuValue(menu, "compact:open-advanced");
    expect(pressed(menu, "receive", "ask")).toBe("true");
    // jsdom has no layout; the communication controls in this fixture are visible.
    for (const control of menu.querySelectorAll<HTMLElement>(
      ".session-menu__communication-choice",
    )) {
      control.checkVisibility = () => true;
    }
    const appearance = menuItem(menu, "Icon & color");
    appearance.focus();
    appearance.dispatchEvent(keydown());
    expect(document.activeElement).toBe(choice(menu, "send", "always"));
    choice(menu, "send", "always").dispatchEvent(keydown(true));
    expect(document.activeElement).toBe(menuItem(menu, "Open in"));
    choice(menu, "receive", "never").click();
    expect(onAction).toHaveBeenCalledWith({
      kind: "set-communication",
      communication: { receive: "never" },
    });
    expect(menuPanel(menu).matches(":popover-open")).toBe(false);
  });

  it("preserves denied reasons and refuses disabled controls", async () => {
    const reason = "Only the session creator or an admin can make this change.";
    const { advanced, onAction } = await setup({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      actionDisabledReasons: { "set-communication": reason },
    });
    expect(choice(advanced, "send", "always")).toMatchObject({ disabled: true, title: reason });
    choice(advanced, "send", "always").click();
    const reset = menuItem(advanced, "Reset");
    expect(reset.disabled).toBe(true);
    reset.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("disables missing communication metadata", async () => {
    const { advanced, onAction } = await setup();
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    expect(advanced.querySelector('.session-menu__communication [aria-pressed="true"]')).toBeNull();
    choice(advanced, "send", "always").click();
    expect(onAction).not.toHaveBeenCalled();
  });
});
