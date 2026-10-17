/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
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
const target = (name = "settings") => ({
  target: { key: `agent:main:${name}`, ...(name === "settings" ? {} : { agentId: "main" }) },
  sessionId: `${name}-id`,
});
function descriptor(
  name = "settings",
  effectiveCommunication: GatewaySessionRow["effectiveCommunication"] = policy,
) {
  const {
    target: { key },
    sessionId,
  } = target(name);
  return {
    session: { key, sessionId, kind: "direct" as const, updatedAt: 1, effectiveCommunication },
  };
}
const keyOptions = { key: "Tab", bubbles: true, composed: true, cancelable: true };
const keydown = (shiftKey = false) => new KeyboardEvent("keydown", { ...keyOptions, shiftKey });
async function select(menu: Parameters<typeof selectMenuValue>[0], value: string) {
  await selectMenuValue(menu, value);
  await settleSessionMenu(menu);
}

function settingsHarness(read: (params?: unknown) => unknown) {
  return createSessionOwnerMenuHarness((method, params) =>
    method === "sessions.describe" ? read(params) : sessionOwnerProfiles("Ada"),
  );
}
async function setup(options: Parameters<typeof mountMenu>[0] = {}) {
  const menu = await mountMenu(options);
  return { menu, advanced: await openSubmenu(menu, "Advanced") };
}
function pressed(
  menu: ParentNode,
  direction: "send" | "receive",
  mode: "always" | "ask" | "never",
) {
  return choice(menu, direction, mode).getAttribute("aria-pressed");
}
function choice(menu: ParentNode, direction: "send" | "receive", mode: "always" | "ask" | "never") {
  return menu.querySelector<HTMLButtonElement>(
    `button[value="communication:${direction}:${mode}"]`,
  )!;
}

describe("session communication menu", () => {
  it("loads compact settings and ignores the previous target reply", async () => {
    const oldReply = createDeferred<{ session: GatewaySessionRow }>();
    const nextReply = createDeferred<{ session: GatewaySessionRow }>();
    const { context, request } = settingsHarness(
      (params) =>
        (isRecord(params) && params.key === "agent:main:old" ? oldReply : nextReply).promise,
    );
    const { menu, advanced } = await setup({ context, session: target("old") });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:main:old",
        agentId: "main",
      }),
    );
    expect(choice(advanced, "send", "always").disabled).toBe(true);
    menu.session = { ...menu.session, ...target("next") };
    await menu.updateComplete;
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:main:next",
        agentId: "main",
      }),
    );
    nextReply.resolve(descriptor("next", { send: "ask", receive: "always" }));
    await waitForFast(() => expect(pressed(advanced, "send", "ask")).toBe("true"));
    expect(choice(advanced, "send", "always").disabled).toBe(false);
    oldReply.resolve(descriptor("old", { send: "never", receive: "never" }));
    await oldReply.promise;
    await menu.updateComplete;
    expect(pressed(advanced, "send", "ask")).toBe("true");
    expect(pressed(advanced, "receive", "always")).toBe("true");
    expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(2);
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
    const request = createGatewayRequestMock((method) =>
      method === "sessions.describe"
        ? descriptor("settings", { send: "ask", receive: "always" })
        : sessionOwnerProfiles("Ada"),
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
    await selectMenuValue(menu, "reload-settings");
    await waitForFast(() => expect(pressed(advanced, "send", "never")).toBe("true"));
    expect(advanced.textContent).not.toContain("Settings unavailable");
  });

  it("dispatches only the selected direction and resets raw overrides together", async () => {
    const onAction = vi.fn();
    const { menu, advanced } = await setup({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      onAction,
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
    await select(menu, "compact:open-advanced");
    expect(menuItem(menu, "Back").getAttribute("data-value")).toBe("compact:back");
    expect(pressed(menu, "receive", "ask")).toBe("true");
    expect(menuPanel(menu).querySelector('[role="menu"]')).toBeNull();
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
    for (const view of ["icon", "copy", "open-in"]) {
      await select(menu, `compact:open-${view}`);
      expect(menuItem(menu, "Back").getAttribute("data-value")).toBe("compact:back-advanced");
      await select(menu, "compact:back-advanced");
      expect(choice(menu, "receive", "ask")).toBeTruthy();
    }
    await select(menu, "compact:back");
    expect(menuItemLabels(menu)).toContain("Advanced");
    expect(menu.querySelector('[role="group"]')).toBeNull();
    await select(menu, "compact:open-advanced");
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
    const { advanced } = await setup({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      actionDisabledReasons: { "set-communication": reason },
      onAction,
    });
    expect(choice(advanced, "send", "always")).toMatchObject({ disabled: true, title: reason });
    choice(advanced, "send", "always").click();
    const reset = menuItem(advanced, "Reset");
    expect(reset.disabled).toBe(true);
    reset.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("disables missing metadata and hides batch settings", async () => {
    const onAction = vi.fn();
    const { advanced } = await setup({ onAction });
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
