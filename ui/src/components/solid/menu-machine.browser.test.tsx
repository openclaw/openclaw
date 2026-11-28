import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, onCleanup, onSettled } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { item, mountMenu, trigger } from "../../test-helpers/solid-menu.tsx";
import { createOverlay } from "../overlay-lifecycle.ts";
import { useMenuMachine, type MenuBinding } from "./menu-machine.ts";

afterEach(cleanup);

it.each(["ltr", "rtl"] as const)("backs out of a cold submenu before Escape in %s", (dir) => {
  const { handle } = mountMenu({ dir });
  const press = (key: string) =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  expect(handle.open()).toBe(true);
  const assign = trigger("people-assign");
  assign.focus();
  press(dir === "ltr" ? "ArrowRight" : "ArrowLeft");
  expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
  press(dir === "ltr" ? "ArrowLeft" : "ArrowRight");
  expect(document.activeElement).toBe(assign);
  expect(handle.overlay.open).toBe(true);
  press("Escape");
  expect(handle.overlay.open).toBe(false);
  expect(document.activeElement).toBe(trigger());
});

it("keeps current menu input reads bounded after visibility and direction changes", async () => {
  let binding!: MenuBinding;
  let surface!: HTMLDivElement;
  let contentReads = 0;
  const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr");
  const overlay = createOverlay("current-menu-inputs");
  render(() => {
    onCleanup(() => overlay.dispose());
    onSettled(() => overlay.bindSurface(surface));
    binding = useMenuMachine(overlay, direction, () => {}, undefined, {
      ids: {
        get content() {
          contentReads++;
          return "current-menu-inputs:content";
        },
      },
    });
    return (
      <div
        id="current-menu-inputs:content"
        popover="manual"
        ref={(element) => {
          surface = element;
        }}
      />
    );
  });
  flush();
  expect(binding.runtime()).toBeUndefined();
  expect(overlay.request(true)).toBe(true);
  await expect.poll(() => binding.runtime()).toBeDefined();
  expect(overlay.request(false)).toBe(true);
  await Promise.resolve();
  flush();
  const readCost = () => {
    contentReads = 0;
    const api = binding.runtime()!.read();
    expect(api.getContentProps().id).toBe("current-menu-inputs:content");
    return contentReads;
  };
  const initialCost = readCost();
  expect(initialCost).toBeGreaterThan(0);
  for (let index = 0; index < 16; index++) {
    setDirection(index % 2 === 0 ? "rtl" : "ltr");
    flush();
    expect(overlay.request(true)).toBe(true);
    await Promise.resolve();
    flush();
    expect(binding.runtime()!.read().open).toBe(true);
    expect(binding.runtime()!.service.prop("dir")).toBe(index % 2 === 0 ? "rtl" : "ltr");
    expect(overlay.request(false)).toBe(true);
    await Promise.resolve();
    flush();
    expect(binding.runtime()!.read().open).toBe(false);
  }
  expect(readCost()).toBe(initialCost);
});
