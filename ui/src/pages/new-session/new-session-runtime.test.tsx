import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMenusWithin, Menu, type MenuHandle } from "../../components/solid/menu.tsx";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SessionPicker } from "./picker.tsx";
import { pickerParams } from "./where-chip.test-support.ts";

afterEach(cleanupSolid);

describe("new session menu dismissal", () => {
  it.each(["agent reset", "draft handoff"])("closes owned menus on %s", async (action) => {
    let menu!: MenuHandle;
    let picker!: HTMLDivElement;
    const view = mountSolid(() => (
      <div
        class="new-session-page__select--agent"
        ref={(node) => {
          picker = node;
        }}
      >
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
        closeMenusWithin(picker);
      } else {
        closeMenusWithin(view.container);
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
    closeMenusWithin(document.createElement("div"));
    expect(menu.overlay.open).toBe(true);
    closeMenusWithin(view.container);
    expect(menu.overlay.open).toBe(true);
  });
});

describe("new session picker focus", () => {
  it.each(["inside", "body", "outside"])(
    "restores only its own lost focus from %s",
    async (from) => {
      let popover!: PopoverHandle;
      let input!: HTMLInputElement;
      let outside!: HTMLButtonElement;
      const view = mountSolid(() => {
        const [open, setOpen] = createSignal(false);
        const { params } = pickerParams(true);
        vi.spyOn(params.place.browser, "popoverOpen").mockImplementation(() => open());
        vi.spyOn(params.place.browser, "popoverCallbacks").mockReturnValue({
          get popoverOpen() {
            return open();
          },
          onPopoverShow: () => setOpen(true),
          onPopoverHide: () => setOpen(false),
          onPopoverAfterHide: () => {},
        });
        return (
          <>
            <button
              ref={(node) => {
                outside = node;
              }}
            >
              Elsewhere
            </button>
            <SessionPicker
              kind="project"
              label="Project"
              value="Workspace"
              icon={<span />}
              params={params}
              ref={(handle) => {
                popover = handle;
              }}
            >
              <input
                ref={(node) => {
                  input = node;
                }}
              />
            </SessionPicker>
          </>
        );
      });
      await waitForSolid(() => expect(popover).toBeDefined());
      popover.show();
      await waitForSolid(() => expect(popover.overlay.open).toBe(true));
      input.focus();
      if (from === "body") {
        input.blur();
      }
      if (from === "outside") {
        outside.focus();
      }
      popover.hide();
      await waitForSolid(() =>
        expect(document.activeElement).toBe(
          from === "outside"
            ? outside
            : view.container.querySelector("#new-session-project-trigger"),
        ),
      );
    },
  );
});
