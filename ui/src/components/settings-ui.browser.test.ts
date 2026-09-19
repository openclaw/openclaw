import { html, render } from "lit";
import { expect, it, vi } from "vitest";
import { renderSettingsSegmented } from "./settings-ui.ts";

it("restores segmented controls after fieldset busy state while preserving disabled options", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onChange = vi.fn();
  const draw = (busy: boolean, disabled = false) =>
    render(
      html`<fieldset ?disabled=${busy}>
        ${renderSettingsSegmented({
          value: "first",
          disabled,
          ariaLabel: "Schedule",
          options: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
            { value: "locked", label: "Locked", disabled: true },
          ],
          onChange,
        })}
      </fieldset>`,
      container,
    );
  const disabledStates = () =>
    [...container.querySelectorAll("wa-radio")].map((radio) => radio.getAttribute("aria-disabled"));
  try {
    draw(false);
    await expect.poll(disabledStates).toEqual(["false", "false", "true"]);
    draw(true);
    await expect.poll(disabledStates).toEqual(["true", "true", "true"]);
    draw(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(disabledStates()).toEqual(["true", "true", "true"]);
    container.querySelector<HTMLElement>('wa-radio[value="second"]')?.click();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(onChange).not.toHaveBeenCalled();
    draw(false);
    await expect.poll(disabledStates).toEqual(["false", "false", "true"]);
    container.querySelector<HTMLElement>('wa-radio[value="second"]')?.click();
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("second", expect.any(HTMLElement)),
    );
    onChange.mockClear();
    draw(true, true);
    await expect.poll(disabledStates).toEqual(["true", "true", "true"]);
    draw(false, true);
    await expect.poll(disabledStates).toEqual(["true", "true", "true"]);
    container.querySelector<HTMLElement>('wa-radio[value="second"]')?.click();
    expect(onChange).not.toHaveBeenCalled();
    draw(false);
    await expect.poll(disabledStates).toEqual(["false", "false", "true"]);
  } finally {
    render(null, container);
    container.remove();
  }
});
