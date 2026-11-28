import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps } from "./chat-composer-plus-menu.types.ts";
import "./chat-camera-capture.tsx";

afterEach(cleanup);

it.each(["entering", "resizing"] as const)(
  "closes a composer menu while %s before activating its retained file input",
  async (presentation) => {
    const handle = createChatAttachmentInputHandle();
    const [open, setOpen] = createSignal(false);
    const [rootToggles, setRootToggles] = createSignal<ChatComposerPlusMenuProps["rootToggles"]>();
    const view = render(() => (
      <div class="agent-chat__input">
        <textarea value="Qa" aria-label="Draft" />
        <ChatAttachmentInputs inputHandle={handle} />
        <ChatComposerPlusMenu
          menu={makeMenu({
            open: open(),
            onOpenChange: setOpen,
            inputHandle: handle,
            rootToggles: rootToggles(),
          })}
        />
      </div>
    ));
    const surface = view.container.querySelector<HTMLElement>("[popover]")!;
    if (presentation === "entering") {
      surface.style.setProperty("--oc-overlay-show-duration", "10s");
    }
    const input = view.container.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
    const parent = input.parentElement;
    let activations = 0;
    let menuStillOpen: boolean | undefined;
    input.addEventListener("click", (event) => {
      event.preventDefault();
      activations += 1;
      menuStillOpen = surface.matches(":popover-open");
    });
    await userEvent.click(view.getByRole("button", { name: "Add attachment" }));
    await expect
      .poll(() => view.container.querySelector('[role="menuitem"][data-value="file"]'))
      .not.toBeNull();
    if (presentation === "resizing") {
      await expect.poll(() => surface.dataset.phase).toBe("open");
      // The menu frame owns the panel height and measures it a layout frame after opening;
      // `auto` does not interpolate. Wait for that pixel height, then grow the menu the way
      // late capabilities do, slowing only the panel's own height transition.
      await expect.poll(() => surface.style.height).toMatch(/px$/);
      surface.style.transitionDuration = "10s";
      setRootToggles([
        { value: "web", label: "Web search", checked: true, disabled: false, onChange() {} },
      ]);
    }
    await expect
      .poll(() => surface.getAnimations().some((animation) => animation.playState === "running"))
      .toBe(true);
    const file = view.container.querySelector<HTMLElement>('[role="menuitem"][data-value="file"]')!;
    let animatingAtPointerDown = false;
    file.addEventListener("pointerdown", () => {
      animatingAtPointerDown = surface
        .getAnimations()
        .some((animation) => animation.playState === "running");
    });
    await userEvent.click(file, { force: true });
    expect(animatingAtPointerDown).toBe(true);
    expect(activations).toBe(1);
    expect(menuStillOpen).toBe(false);
    expect(view.container.querySelector(".agent-chat__attach-menu")?.hasAttribute("open")).toBe(
      false,
    );
    expect(input.isConnected).toBe(true);
    expect(input.parentElement).toBe(parent);
    expect((view.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("Qa");
  },
);
