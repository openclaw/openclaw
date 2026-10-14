import { afterEach, describe, expect, it } from "vitest";
import { Menu, type MenuHandle } from "../../components/solid/menu.tsx";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { closeAgentPicker, closeSessionMenus } from "./new-session-runtime.ts";

afterEach(cleanupSolid);

describe("new session menu dismissal", () => {
  it.each(["agent reset", "draft handoff"])("closes owned menus on %s", async (action) => {
    let menu!: MenuHandle;
    const view = mountSolid(() => (
      <div class="new-session-page__select--agent">
        <Menu
          id="draft-agent"
          label="Agent"
          items={[{ id: "main", label: "Main" }]}
          ref={(handle) => (menu = handle)}
        />
      </div>
    ));
    await waitForSolid(() => expect(menu).toBeDefined());
    menu.open();
    expect(menu.overlay.open).toBe(true);

    // Native surfaces may be reparented; the trigger still identifies their owner.
    document.body.append(menu.overlay.surface);
    try {
      if (action === "agent reset") {
        closeAgentPicker(view.container);
      } else {
        closeSessionMenus(view.container);
      }
      expect(menu.overlay.open).toBe(false);
    } finally {
      view.container.append(menu.overlay.surface);
    }
  });

  it("honors close vetoes and leaves menus outside the draft alone", async () => {
    let menu!: MenuHandle;
    const view = mountSolid(() => (
      <Menu
        id="retained-agent"
        label="Agent"
        items={[{ id: "main", label: "Main" }]}
        onBeforeHide={(event) => event.preventDefault()}
        ref={(handle) => (menu = handle)}
      />
    ));
    await waitForSolid(() => expect(menu).toBeDefined());
    menu.open();
    closeSessionMenus(document.createElement("div"));
    expect(menu.overlay.open).toBe(true);
    closeSessionMenus(view.container);
    expect(menu.overlay.open).toBe(true);
  });
});
