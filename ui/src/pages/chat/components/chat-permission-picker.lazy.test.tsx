/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatPermissionPicker } from "./chat-permission-picker.tsx";

const contentState = vi.hoisted(() => ({ fail: true }));
vi.mock("./chat-permission-picker-content.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chat-permission-picker-content.tsx")>();
  return {
    ...original,
    ChatPermissionPickerContent: (
      props: Parameters<typeof original.ChatPermissionPickerContent>[0],
    ) => {
      if (contentState.fail) {
        throw new Error("Permission content unavailable");
      }
      return original.ChatPermissionPickerContent(props);
    },
  };
});

it.each([false, true])(
  "recovers lazy content without losing keyboard custody (focus moved: %s)",
  async (moveFocus) => {
    contentState.fail = true;
    const onSelect = vi.fn();
    const { container } = mountSolid(() => (
      <>
        <input aria-label="Outside menu" />
        <ChatPermissionPicker canSelectFull mode="guarded" onSelect={onSelect} />
      </>
    ));
    flush();
    const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await waitForSolid(() =>
      expect(container.querySelector(".lazy-view-error__action")).not.toBeNull(),
    );
    const retry = container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!;
    retry.focus();
    contentState.fail = false;
    retry.click();
    const outside = container.querySelector("input")!;
    if (moveFocus) {
      outside.focus();
    }
    await waitForSolid(() =>
      expect(container.querySelector('[data-chat-permission-option="full"]')).not.toBeNull(),
    );
    await waitForSolid(() =>
      expect(document.activeElement).toBe(
        moveFocus ? outside : container.querySelector(".chat-controls__permission-learn-more"),
      ),
    );
    if (!moveFocus) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "4", bubbles: true, cancelable: true }),
      );
      expect(onSelect).toHaveBeenCalledExactlyOnceWith("workspace");
      expect(document.activeElement).toBe(trigger);
    }
  },
);
