import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AppearancePicker } from "./appearance-picker.ts";

const forms: HTMLFormElement[] = [];
afterEach(() => {
  for (const form of forms.splice(0)) {
    form.remove();
  }
});

async function appearanceForm() {
  const form = document.createElement("form");
  const picker = new AppearancePicker();
  const onChange = vi.fn();
  const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
  picker.props = { icon: "rocket", color: "blue", onChange };
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save board";
  form.append(picker, save);
  form.addEventListener("submit", onSubmit);
  document.body.append(form);
  forms.push(form);
  await picker.updateComplete;
  await page.getByRole("button", { name: "Custom emoji…", exact: true }).click();
  await picker.updateComplete;
  const input = page.getByRole("textbox", { name: "Custom emoji", exact: true });
  return { picker, input, onChange, onSubmit };
}

it("applies custom emoji with Enter without submitting the enclosing board form", async () => {
  const { picker, input, onChange, onSubmit } = await appearanceForm();
  await input.fill("🦉");
  await picker.updateComplete;
  // An IME confirmation must not apply the unfinished composition.
  for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...composition,
      bubbles: true,
      cancelable: true,
    });
    input.element().dispatchEvent(event);
    expect(onChange).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  }
  await userEvent.keyboard("{Enter}");
  await picker.updateComplete;
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ icon: "🦉", color: "blue" });
  expect(onSubmit).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Save board", exact: true }).click();
  expect(onSubmit).toHaveBeenCalledOnce();
});

it.each(["empty", "disabled", "SVG"] as const)(
  "does not apply or submit custom emoji with Enter when %s",
  async (state) => {
    const { picker, input, onChange, onSubmit } = await appearanceForm();
    await input.fill(
      state === "empty"
        ? ""
        : state === "SVG"
          ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'
          : "🦉",
    );
    if (state === "disabled") {
      picker.props = { ...picker.props, disabled: true };
    }
    await picker.updateComplete;
    input.element().focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  },
);
