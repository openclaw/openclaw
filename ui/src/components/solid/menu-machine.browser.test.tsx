import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, onCleanup, onSettled } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { createOverlay } from "../overlay-lifecycle.ts";
import { useMenuMachine, type MenuBinding } from "./menu-machine.ts";

afterEach(cleanup);

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
