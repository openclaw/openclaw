import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DesktopPicker } from "./desktop-panel-view.tsx";

it.each([false, true])(
  "uses the current refresh callback without replacing the desktop picker button (automatic: %s)",
  (automatic) => {
    const initial = vi.fn();
    const replacement = vi.fn();
    let replace!: () => void;
    const view = mountSolid(() => {
      const [callbacks, setCallbacks] = createSignal({ refresh: initial });
      replace = () => setCallbacks({ refresh: replacement });
      return (
        <DesktopPicker
          automatic={automatic}
          environments={[]}
          loading={false}
          onConnect={() => {}}
          onRefresh={callbacks().refresh}
        />
      );
    });
    const button = view.getByRole("button");
    button.click();
    expect(initial).toHaveBeenCalledOnce();

    replace();
    flush();
    expect(view.getByRole("button")).toBe(button);
    button.click();
    expect(initial).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();
    view.unmount();
  },
);
