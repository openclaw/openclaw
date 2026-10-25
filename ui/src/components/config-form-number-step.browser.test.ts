import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  renderNumberInputFixture,
  disposeConfigFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
it("steps the in-progress number rather than the committed value", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const onPatch = vi.fn();
  renderNumberInputFixture(container, {
    schema: { type: "integer", minimum: 1, default: 3 },
    value: undefined,
    path: ["retries"],
    onPatch,
    compact: false,
    commitOnBlur: true,
  });
  try {
    const input = container.querySelector<HTMLInputElement>("input")!;
    await page.elementLocator(input).fill("10");
    expect(onPatch).not.toHaveBeenCalled();
    await page.elementLocator(input).click();
    await userEvent.keyboard("{ArrowUp}");
    expect(input.value).toBe("11");
    expect(onPatch).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onPatch).toHaveBeenLastCalledWith(["retries"], 11);
  } finally {
    disposeConfigFormFixture(container);
    container.remove();
  }
});
