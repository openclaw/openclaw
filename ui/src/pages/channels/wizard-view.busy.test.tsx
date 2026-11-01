/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { renderWizard, setupWizardTests, wizardStep } from "./wizard-view.test-support.ts";

setupWizardTests();
const choices = [
  { label: "Alpha", value: "alpha" },
  { label: "Beta", value: "beta" },
];
function renderStep(
  step: WizardStep,
  busy = true,
  textValue = typeof step.initialValue === "string" ? step.initialValue : "",
) {
  return renderWizard(wizardStep(step, { busy }), { textValue, multiselectValues: ["alpha"] });
}

function expectBusyButton(container: HTMLElement, status: string) {
  const button = container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute("aria-label")).toBe("Continue");
  expect(button?.querySelector(".btn__label")?.textContent).toBe("Continue");
  expect(button?.querySelector(".btn__spinner")).not.toBeNull();
  expect(button?.querySelector(".btn__label + .btn__spinner")).not.toBeNull();
  expect(button?.querySelector(".sr-only")?.textContent).toBe(status);
  expect(container.querySelectorAll(".btn__spinner")).toHaveLength(1);
  return button;
}

describe("ChannelWizard busy controls", () => {
  it.each([
    { name: "note", step: { id: "note", type: "note", message: "Do this" } },
    { name: "confirm", step: { id: "confirm", type: "confirm", message: "Continue?" } },
  ] satisfies Array<{ name: string; step: WizardStep }>)(
    "shows one spinner button while a $name answer is running",
    ({ step }) => {
      const rendered = renderStep(step);
      const busyButton = expectBusyButton(rendered.container, "Working…");
      expect(busyButton?.closest(".channels-wizard__footer")).not.toBeNull();
      expect(
        Array.from(rendered.container.querySelectorAll(".channels-wizard__spinner")).some(
          (element) => element.textContent?.trim() === "Working…",
        ),
      ).toBe(false);
      busyButton?.click();
      expect(rendered.onAnswer).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "wizard startup",
      wizard: { phase: "starting", channel: "telegram" } as const,
      overrides: {},
      status: "Starting setup…",
    },
    {
      name: "WhatsApp QR loading",
      wizard: {
        phase: "done",
        channel: "whatsapp",
        channels: ["whatsapp"],
        accounts: [{ channel: "whatsapp", accountId: "default" }],
      } as const,
      overrides: { whatsappBusy: true },
      status: "Generating QR code…",
    },
  ])("uses the same spinner button for $name", ({ wizard, overrides, status }) => {
    const rendered = renderWizard(wizard, overrides);
    expectBusyButton(rendered.container, status);
  });

  it("announces gateway-owned progress and keeps cancellation available", () => {
    const progress = renderStep({
      id: "install-progress",
      type: "progress",
      executor: "gateway",
    });

    const status = progress.container.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent?.trim()).toBe("Working…");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(progress.container.querySelectorAll('[role="status"]')).toHaveLength(1);
    const busyButton = progress.container.querySelector<HTMLButtonElement>(
      '.channels-wizard__footer button[aria-busy="true"]',
    );
    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.querySelector(".btn__spinner")).not.toBeNull();

    const cancel = progress.container.querySelector<HTMLButtonElement>(
      '.channels-wizard__footer button:not([aria-busy="true"])',
    );
    expect(cancel?.textContent?.trim()).toBe("Cancel");
    cancel?.click();
    expect(progress.onClose).toHaveBeenCalledOnce();
    expect(progress.onAnswer).not.toHaveBeenCalled();
  });

  it("disables select choices while a step is running", async () => {
    const select = renderStep({
      id: "select",
      type: "select",
      message: "Pick one",
      options: choices,
    });
    await updatePickers(select.container);
    const group = select.container.querySelector("openclaw-select-picker .picker-select__trigger");
    expect(group?.hasAttribute("disabled")).toBe(true);
    expect(group?.getAttribute("aria-label")).toBe("Pick one");
  });

  it("disables multiselect choices and submission while a step is running", () => {
    const multiselect = renderStep({
      id: "multi",
      type: "multiselect",
      message: "Pick several",
      options: choices,
    });
    const buttons = Array.from(multiselect.container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    buttons.forEach((button) => button.click());
    expect(multiselect.onToggleMultiselect).not.toHaveBeenCalled();
    expect(multiselect.onAnswer).not.toHaveBeenCalled();
  });

  it("disables text editing and submission while a step is running", () => {
    const text = renderStep(
      {
        id: "text",
        type: "text",
        message: "Enter a value",
        sensitive: true,
      },
      true,
      "replacement",
    );
    const input = text.container.querySelector<HTMLInputElement>('input[name="wizard-text"]');
    const submit = text.container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
    const toggle = text.container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(input).toMatchObject({ disabled: true, type: "password", value: "replacement" });
    expect([toggle?.disabled, submit?.disabled]).toEqual([true, true]);
    submit?.click();
    expect(text.onAnswer).not.toHaveBeenCalled();
  });

  it("keeps controls enabled when no step request is running", async () => {
    const text = renderStep(
      { id: "text", type: "text", message: "Enter a value", initialValue: "original" },
      false,
    );
    expect(text.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
    expect(text.container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);

    const select = renderStep(
      {
        id: "select",
        type: "select",
        options: [{ label: "Alpha", value: "alpha" }],
      },
      false,
    );
    await updatePickers(select.container);
    const picker = select.container.querySelector("openclaw-select-picker .picker-select__trigger");
    expect(picker?.hasAttribute("disabled")).toBe(false);
  });
});
