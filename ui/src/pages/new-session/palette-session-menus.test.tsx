import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { mount } from "../../test-helpers/palette-session-draft.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("palette settings menus", () => {
  it("lets the agent menu consume Escape before closing palette settings", async () => {
    const { host } = await mount({
      agents: [
        { id: "main", workspace: "/workspace" },
        { id: "other", workspace: "/other" },
      ],
    });
    host.querySelector<HTMLButtonElement>(".palette-session-settings__trigger")!.click();
    const settings = host.querySelector<HTMLElement>(".palette-session-settings")!;
    await waitForSolid(() => expect(settings.matches(":popover-open")).toBe(true));
    host.querySelector<HTMLButtonElement>(".agent-select__trigger")!.click();
    const menu = host.querySelector<HTMLElement>(".agent-select__menu")!;
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));

    menu
      .querySelector<HTMLElement>('[role="menuitemradio"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(false));
    expect(settings.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(host.querySelector(".agent-select__trigger"));
  });
});
