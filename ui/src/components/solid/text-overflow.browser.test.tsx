import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createTextOverflow } from "./text-overflow.ts";

afterEach(cleanupSolid);

async function settleLayout() {
  await document.fonts.ready;
  // Resize delivery and the shared layout owner's read/write frame both settle.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

it("keeps full labels and adjacent controls while fading only clipped text in either direction", async () => {
  const long = "release/international-configuration-review-with-complete-filename.ts";
  const [text, setText] = createSignal(long);
  const view = mountSolid(() => (
    <div style="display:flex;gap:8px;width:180px">
      <span ref={createTextOverflow(text)} style="overflow:hidden;white-space:nowrap;min-width:0">
        {text()}
      </span>
      <button style="flex:none">Open</button>
    </div>
  ));
  const label = view.container.querySelector("span")!;
  const button = view.getByRole("button", { name: "Open" });
  await settleLayout();
  expect(getComputedStyle(label).maskImage).toContain("to right");
  expect(label.textContent).toBe(long);
  const bounds = button.getBoundingClientRect();
  view.container.dir = "rtl";
  await settleLayout();
  expect(getComputedStyle(label).maskImage).toContain("to left");
  expect(button.getBoundingClientRect().width).toBe(bounds.width);
  setText("Short");
  await settleLayout();
  expect(getComputedStyle(label).maskImage).toBe("none");
  setText(long);
  await settleLayout();
  expect(getComputedStyle(label).maskImage).not.toBe("none");
  view.container.querySelector<HTMLDivElement>("div")!.style.width = "1200px";
  await settleLayout();
  expect(getComputedStyle(label).maskImage).toBe("none");
  expect(label.textContent).toBe(long);
});
