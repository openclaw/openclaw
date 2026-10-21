import { createSignal, flush } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { FolderDisclosure } from "./chat-session-workspace-disclosure.tsx";
import { ReviewDisclosure } from "./session-diff-disclosure.tsx";

it.each([
  { name: "Files", Disclosure: FolderDisclosure, duration: 200 },
  { name: "Review", Disclosure: ReviewDisclosure, duration: 240 },
])(
  "preserves $name disclosure geometry during reversal and synchronous exits",
  ({ Disclosure, duration }) => {
    const [open, setOpen] = createSignal(false);
    const [active, setActive] = createSignal(true);
    const [instant, setInstant] = createSignal(false);
    const view = mountSolid(() => (
      <div style={{ "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)", width: "320px" }}>
        <Disclosure open={open()} active={active()} instant={instant()}>
          <div style={{ height: "160px" }}>
            <input aria-label="Retained reader" />
          </div>
        </Disclosure>
      </div>
    ));
    const shell = view.container.querySelector<HTMLDivElement>(
      ".workspace-desktop__disclosure, .session-diff__disclosure",
    )!;
    expect(shell.hidden).toBe(true);
    setOpen(true);
    flush();
    const reader = view.getByRole("textbox", { name: "Retained reader" });
    expect(shell.getAnimations()).toHaveLength(1);
    const opening = shell.getAnimations()[0]!;
    expect(opening.effect?.getTiming().duration).toBe(duration);
    opening.pause();
    opening.currentTime = 0;
    expect(shell.getBoundingClientRect().height).toBeCloseTo(0, 1);
    opening.currentTime = 80;
    const interruptedHeight = shell.getBoundingClientRect().height;
    expect(interruptedHeight).toBeGreaterThan(0);
    expect(interruptedHeight).toBeLessThan(160);

    setOpen(false);
    flush();
    expect(shell.getAnimations()).toHaveLength(1);
    const closing = shell.getAnimations()[0]!;
    expect(closing).not.toBe(opening);
    closing.pause();
    closing.currentTime = 0;
    expect(shell.getBoundingClientRect().height).toBeCloseTo(interruptedHeight, 1);
    expect(shell.querySelector("input")).toBe(reader);
    expect(shell.inert).toBe(true);

    setActive(false);
    flush();
    expect(shell.getAnimations()).toHaveLength(0);
    expect(shell.hidden).toBe(true);

    setActive(true);
    setInstant(true);
    setOpen(true);
    flush();
    expect(shell.hidden).toBe(false);
    expect(shell.getBoundingClientRect().height).toBe(160);
    expect(shell.getAnimations()).toHaveLength(0);
    setOpen(false);
    flush();
    expect(shell.hidden).toBe(true);
    expect(shell.getAnimations()).toHaveLength(0);
  },
);
