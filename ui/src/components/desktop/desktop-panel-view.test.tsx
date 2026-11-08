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

it.each([
  ["unsettled read, desktop", false, "desktop", false, false],
  ["unsettled read, no presentation", false, undefined, false, false],
  ["settled empty, desktop", true, "desktop", true, true],
  ["settled empty, no presentation", true, undefined, true, false],
] as const)(
  "shows the empty inventory copy only after a settled empty read (%s)",
  (_name, genuineEmpty, presentation, expectedCopy, expectedTitle) => {
    const view = mountSolid(() => (
      <DesktopPicker
        automatic={false}
        environments={[]}
        loading={false}
        genuineEmpty={genuineEmpty}
        presentation={presentation}
        onConnect={() => {}}
        onRefresh={() => {}}
      />
    ));
    const text = view.container.textContent ?? "";
    expect(text.includes("No desktop sources yet.")).toBe(expectedCopy);
    expect(text.includes("No desktops yet")).toBe(expectedTitle);
    view.unmount();
  },
);
