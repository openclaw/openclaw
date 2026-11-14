import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionsListResult } from "../api/types.ts";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  mountPalette,
  paletteInput,
  pressKey,
  setInputValue,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";
import "../styles.css";

it("reverses a mode glide from the visible height and keeps search refresh out of layout", async () => {
  const empty = { ...createSessionResult("agent:main:fixture", "Unused"), sessions: [] };
  const refresh = createDeferred<SessionsListResult>();
  const list = vi.fn().mockResolvedValueOnce(empty).mockReturnValue(refresh.promise);
  const { palette, provider } = await mountPalette(
    createContext(createGateway(true).gateway, list),
  );
  onTestFinished(() => {
    provider.remove();
    vi.useRealTimers();
  });
  palette.openPalette();
  await palette.updateComplete;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const input = paletteInput(palette);
  setInputValue(input, "zzfixtureunique");
  await palette.updateComplete;
  await vi.advanceTimersByTimeAsync(200);
  await palette.updateComplete;
  await expect.poll(() => palette.textContent).toContain("No results match your search.");
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  const stack = palette.querySelector<HTMLElement>(".cmd-palette-stack")!;
  const searchHeight = stack.getBoundingClientRect().height;
  const top = stack.getBoundingClientRect().top;
  input.focus();
  input.setSelectionRange(2, 5);
  pressKey(input, "Tab");
  await palette.updateComplete;
  const collapse = stack.getAnimations()[0]!;
  expect(collapse).toBeDefined();
  collapse.pause();
  collapse.currentTime = 75;
  await nextFrame();
  const interruptedHeight = stack.getBoundingClientRect().height;
  expect(interruptedHeight).toBeLessThan(searchHeight);

  pressKey(input, "Tab");
  await palette.updateComplete;
  const animations = stack.getAnimations();
  expect(animations).toHaveLength(1);
  const expansion = animations[0]!;
  expansion.pause();
  const frames = (expansion.effect as KeyframeEffect).getKeyframes();
  expect(Number.parseFloat(String(frames[0]!.height))).toBeCloseTo(interruptedHeight, 1);
  expect(Number.parseFloat(String(frames.at(-1)!.height))).toBeCloseTo(searchHeight, 1);
  expansion.finish();
  await nextFrame();
  expect(stack.getBoundingClientRect().height).toBeCloseTo(searchHeight, 1);

  await vi.advanceTimersByTimeAsync(200);
  await palette.updateComplete;
  await expect.poll(() => palette.textContent).toContain("Searching sessions");
  expect(stack.getBoundingClientRect().height).toBeCloseTo(searchHeight, 1);
  refresh.resolve(empty);
  await palette.updateComplete;
  await expect.poll(() => palette.textContent).not.toContain("Searching sessions");
  expect(stack.getBoundingClientRect().height).toBeCloseTo(searchHeight, 1);
  expect(stack.getBoundingClientRect().top).toBe(top);
  expect(document.activeElement).toBe(input);
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual([
    "zzfixtureunique",
    2,
    5,
  ]);
});
