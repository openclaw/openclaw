/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { mountMenu, menuItem, selectMenuValue } from "../test-helpers/session-menu.ts";

const policy = { send: "never", receive: "ask" } as const;

describe("session communication menu", () => {
  it("shows Gateway-resolved defaults without inventing another picker choice", async () => {
    const menu = await mountMenu({ session: { effectiveCommunication: policy } });
    const send = menuItem(menu, "Send messages");
    expect(send.textContent).toContain("Never");
    expect(send.textContent).toContain("default");
    expect(menuItem(menu, "Receive messages").textContent).toContain("Ask");
    expect(
      Array.from(send.querySelectorAll("wa-dropdown-item")).map((item) =>
        item.getAttribute("value"),
      ),
    ).toEqual(["communication:send:always", "communication:send:ask", "communication:send:never"]);
    expect(send.querySelector('[value="communication:send:never"]')?.hasAttribute("checked")).toBe(
      true,
    );
    expect(menu.querySelector('[value="communication:reset"]')).toBeNull();
  });

  it("dispatches only the selected direction and resets raw overrides together", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      onAction,
    });
    selectMenuValue(menu, "communication:receive:always");
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "set-communication",
      communication: { receive: "always" },
    });
    selectMenuValue(menu, "communication:reset");
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-communication", communication: null });
    expect(
      menuItem(menu, "Send messages").querySelector(".session-menu__communication-default"),
    ).toBeNull();
  });

  it("uses compact drillins and returns to the same root", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      compact: true,
      session: { effectiveCommunication: policy },
      onAction,
    });
    selectMenuValue(menu, "compact:open-communication-receive");
    await menu.updateComplete;
    expect(menuItem(menu, "Back")).toBeTruthy();
    expect(menuItem(menu, "Ask").hasAttribute("checked")).toBe(true);
    selectMenuValue(menu, "communication:receive:never");
    expect(onAction).toHaveBeenCalledWith({
      kind: "set-communication",
      communication: { receive: "never" },
    });
    selectMenuValue(menu, "compact:back");
    await menu.updateComplete;
    expect(menuItem(menu, "Receive messages")).toBeTruthy();
  });

  it("preserves access reasons and refuses synthesized changes when disabled", async () => {
    const onAction = vi.fn();
    const reason = "Only the session creator or an admin can make this change.";
    const menu = await mountMenu({
      session: { communication: { send: "never" }, effectiveCommunication: policy },
      actionDisabledReasons: { "set-communication": reason },
      onAction,
    });
    expect(menuItem(menu, "Send messages").disabled).toBe(true);
    expect(menuItem(menu, "Send messages").title).toBe(reason);
    selectMenuValue(menu, "communication:send:always");
    selectMenuValue(menu, "communication:reset");
    expect(onAction).not.toHaveBeenCalled();
    expect(menuItem(menu, "Reset").disabled).toBe(true);
  });

  it("does not derive policy from missing metadata or expose batch editing", async () => {
    for (const options of [
      {},
      { session: { effectiveCommunication: policy }, selectionCount: 2 },
    ]) {
      const menu = await mountMenu(options);
      expect(menu.querySelector('[value="communication:send:always"]')).toBeNull();
    }
  });
});
