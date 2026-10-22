/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import {
  renderWizard,
  setupWizardTests,
  wizardInput,
  wizardStep,
} from "./wizard-view.test-support.ts";

setupWizardTests();
const choices = [
  { label: "Alpha", value: "alpha" },
  { label: "Beta", value: "beta" },
];
function busyButton(container: HTMLElement, status: string) {
  const button = container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute("aria-label")).toBe("Continue");
  expect(button?.querySelector(".btn__label")?.textContent).toBe("Continue");
  expect(button?.querySelector(".btn__label + .btn__spinner")).not.toBeNull();
  expect(button?.querySelector(".sr-only")?.textContent).toBe(status);
  expect(container.querySelectorAll(".btn__spinner")).toHaveLength(1);
  return button;
}
it.each([false, true])(
  "labels text inputs and recovers validation (sensitive: %s)",
  (sensitive) => {
    const wizard = wizardStep(
      { id: "account", type: "text", message: "New Matrix account id", sensitive },
      { channel: "matrix", busy: false },
    );
    const { container, update } = renderWizard(wizard);
    const input = wizardInput(container);
    const label = container.querySelector('label[for="channel-wizard-text-input"]');
    expect(label?.textContent).toBe("New Matrix account id");
    expect(input).toMatchObject({ type: sensitive ? "password" : "text", disabled: false });
    expect(input?.labels).toContain(label);
    expect(container.querySelector(".oc-sensitive-toggle") !== null).toBe(sensitive);
    update({ ...wizard, validationError: "That account id is not valid." });
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("That account id is not valid.");
    update(wizard);
    expect([input?.hasAttribute("aria-invalid"), input?.hasAttribute("aria-describedby")]).toEqual([
      false,
      false,
    ]);
  },
);
it("routes replacement secret input and visibility changes through the wizard host", () => {
  const wizard = wizardStep({ id: "secret", type: "text", sensitive: true }, { busy: false });
  const { container, actions, update } = renderWizard(wizard);
  const input = wizardInput(container)!;
  expect(input).toMatchObject({ type: "password", value: "" });
  const toggle = container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")!;
  expect(toggle.getAttribute("aria-label")).toBe("Reveal value");
  expect(toggle.dataset).toMatchObject({ sensitiveIcon: "eye" });
  input.value = "new-secret";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  toggle.click();
  expect(actions.setTextValue).toHaveBeenCalledWith("new-secret");
  expect(actions.toggleSecretVisibility).toHaveBeenCalledOnce();
  update(wizard, { secretVisible: true, textValue: "new-secret" });
  expect(wizardInput(container)).toMatchObject({ type: "text", value: "new-secret" });
  const hidden = container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")!;
  expect([
    hidden.getAttribute("aria-label"),
    hidden.getAttribute("aria-pressed"),
    hidden.dataset.sensitiveIcon,
  ]).toEqual(["Hide value", "true", "eye-off"]);
});
it("renders informational setup output as unpadded plain text", () => {
  const message = "iMessage — Local iMessage/SMS through the imsg bridge.";
  const { container } = renderWizard(
    wizardStep(
      { id: "selected", type: "note", title: "Selected channels", message },
      { channel: "imessage", busy: false },
    ),
  );
  expect(container.querySelector(".channels-wizard__output")?.textContent).toBe(message);
  expect(
    container.querySelector(".channels-wizard__note, .channels-wizard__links button"),
  ).toBeNull();
});
it("links channel docs from the subtitle without static helper links", () => {
  const { container } = renderWizard({ phase: "error", channel: "slack", message: "Setup failed" });
  const subtitle = container.querySelector(".channels-wizard__subtitle");
  expect(subtitle?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
    "Guided channel setup View docs",
  );
  expect(subtitle?.querySelector<HTMLAnchorElement>(".channels-wizard__link")?.href).toBe(
    "https://docs.openclaw.ai/channels/slack",
  );
  expect(container.querySelector(".channels-wizard__links")).toBeNull();
});
it.each(["note", "confirm"] as const)("shows one inactive spinner for a busy %s", (type) => {
  const { container, actions } = renderWizard(wizardStep({ id: type, type, message: "Continue?" }));
  const button = busyButton(container, "Working…");
  expect(button?.closest(".channels-wizard__footer")).not.toBeNull();
  expect(
    Array.from(container.querySelectorAll(".channels-wizard__spinner")).some(
      (node) => node.textContent?.trim() === "Working…",
    ),
  ).toBe(false);
  button?.click();
  expect(actions.answer).not.toHaveBeenCalled();
});
it.each([false, true])("uses the busy button for startup or WhatsApp QR (QR: %s)", (qr) => {
  const { container } = renderWizard(
    qr
      ? {
          phase: "done",
          channel: "whatsapp",
          channels: ["whatsapp"],
          accounts: [{ channel: "whatsapp", accountId: "default" }],
        }
      : { phase: "starting", channel: "telegram" },
    qr,
  );
  busyButton(container, qr ? "Generating QR code…" : "Starting setup…");
});
it("announces gateway progress while keeping cancellation available", () => {
  const { container, actions } = renderWizard(
    wizardStep({ id: "progress", type: "progress", executor: "gateway" }),
  );
  busyButton(container, "Working…");
  const status = container.querySelector('[role="status"]');
  expect(status?.textContent?.trim()).toBe("Working…");
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  const cancel = container.querySelector<HTMLButtonElement>(
    '.channels-wizard__footer button:not([aria-busy="true"])',
  );
  expect(cancel?.textContent?.trim()).toBe("Cancel");
  cancel?.click();
  expect(actions.close).toHaveBeenCalledOnce();
  expect(actions.answer).not.toHaveBeenCalled();
});
it("projects busy state into the single-choice picker", async () => {
  const wizard = wizardStep({
    id: "select",
    type: "select",
    message: "Pick one",
    options: choices,
  });
  const { container, update } = renderWizard(wizard);
  await updatePickers(container);
  const picker = () => container.querySelector("openclaw-select-picker .picker-select__trigger");
  expect(picker()?.hasAttribute("disabled")).toBe(true);
  expect(picker()?.getAttribute("aria-label")).toBe("Pick one");
  update({ ...wizard, busy: false });
  await updatePickers(container);
  expect(picker()?.hasAttribute("disabled")).toBe(false);
});
it("disables multiselect choices and submission while busy", () => {
  const { container, update, actions } = renderWizard(
    wizardStep({ id: "multi", type: "multiselect", message: "Pick several", options: choices }),
  );
  update(undefined, { multiselect: ["alpha"] });
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  expect(buttons).toHaveLength(3);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  buttons.forEach((button) => button.click());
  expect(actions.toggleMultiselect).not.toHaveBeenCalled();
  expect(actions.answer).not.toHaveBeenCalled();
});
it("disables text editing, reveal and submission while busy", () => {
  const wizard = wizardStep({ id: "text", type: "text", sensitive: true });
  const { container, update, actions } = renderWizard(wizard);
  update(wizard, { textValue: "replacement" });
  expect(wizardInput(container)).toMatchObject({
    disabled: true,
    type: "password",
    value: "replacement",
  });
  const submit = container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
  expect([
    container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")?.disabled,
    submit?.disabled,
  ]).toEqual([true, true]);
  submit?.click();
  expect(actions.answer).not.toHaveBeenCalled();
  update({ ...wizard, busy: false });
  expect(wizardInput(container)?.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
});
