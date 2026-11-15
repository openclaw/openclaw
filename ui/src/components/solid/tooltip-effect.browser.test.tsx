import { createRoot, flush, onSettled } from "solid-js";
import { afterEach, expect, it } from "vitest";
import "../tooltip.ts";

const tooltips: HTMLElementTagNameMap["openclaw-tooltip"][] = [];
let disposeRoot: (() => void) | undefined;
afterEach(() => {
  disposeRoot?.();
  for (const tooltip of tooltips.splice(0)) {
    tooltip.remove();
  }
});

async function createTooltip(content: string) {
  const tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = content;
  const button = document.createElement("button");
  button.textContent = "Help";
  tooltip.append(button);
  tooltips.push(tooltip);
  document.body.append(tooltip);
  await tooltip.updateComplete;
  return { tooltip, button };
}

it("mounts a cached tooltip view when an owned settled callback focuses its trigger", async () => {
  const first = await createTooltip("First details");
  first.button.focus();
  await first.tooltip.updateComplete;
  expect(first.tooltip.hasAttribute("open")).toBe(true);
  first.button.blur();
  const next = await createTooltip("Next details");
  disposeRoot = createRoot((dispose) => {
    onSettled(() => next.button.focus());
    return dispose;
  });
  flush();
  await expect.poll(() => next.tooltip.hasAttribute("open")).toBe(true);
  expect(next.tooltip.shadowRoot!.querySelector(".tooltip-content")?.textContent).toBe(
    "Next details",
  );
  expect(first.tooltip.hasAttribute("open")).toBe(false);
});
