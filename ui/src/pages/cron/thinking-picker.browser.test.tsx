import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CronThinkingPicker } from "./thinking-picker.tsx";

registerEnglishCatalog(registerCronEnglish);

it("retains a custom reasoning input through capability changes and clears through Default", async () => {
  const [value, setValue] = createSignal("vendor-level");
  const [options, setOptions] = createSignal([{ value: "xhigh", label: "Extra high" }]);
  const [disabled, setDisabled] = createSignal(false);
  const { container } = mountSolid(() => (
    <fieldset disabled={disabled()}>
      <CronThinkingPicker value={value()} options={options()} invalid={false} onChange={setValue} />
    </fieldset>
  ));
  flush();
  await vi.waitFor(() =>
    expect(container.querySelector("button")?.textContent).toContain("vendor-level"),
  );
  container.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(
      container.querySelector('[role="option"][data-value="__custom_thinking__"]'),
    ).not.toBeNull(),
  );
  container
    .querySelector<HTMLElement>('[role="option"][data-value="__custom_thinking__"]')!
    .click();
  await vi.waitFor(() => expect(container.querySelector("input")).not.toBeNull());
  const input = container.querySelector<HTMLInputElement>("input")!;
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  input.value = "provider-special";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  setOptions([]);
  flush();
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("provider-special");
  expect(document.activeElement).toBe(input);
  container.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="option"][data-value=""]')).not.toBeNull(),
  );
  container.querySelector<HTMLElement>('[role="option"][data-value=""]')!.click();
  flush();
  await vi.waitFor(() =>
    expect(container.querySelector("button")?.textContent).toContain("Default reasoning"),
  );
  expect(container.querySelector("input")).toBeNull();
  setDisabled(true);
  flush();
  expect(container.querySelector("button")!.matches(":disabled")).toBe(true);
});
