import { createSignal, merge, type ComponentProps } from "solid-js";
import { expect, it, vi } from "vitest";
import type { WizardStep } from "../api/types.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { choosePickerValue, updatePickers } from "../test-helpers/select-picker.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { WizardStepControls } from "./wizard-step-controls.tsx";

type Props = ComponentProps<typeof WizardStepControls>;
const step = (type: WizardStep["type"], options?: WizardStep["options"]): WizardStep => ({
  id: "test",
  type,
  message: "Question",
  options,
});
const option = (label: string, value: unknown) => ({ label, value });
const cancelButton = (onClick: () => void) => (
  <button type="button" class="cancel" onClick={onClick}>
    Cancel
  </button>
);
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const typeInto = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
function mountStep(initialStep: WizardStep, configure: () => Partial<Props> = () => ({})) {
  const answer = vi.fn(),
    change = vi.fn();
  const defaults: Props = {
    step: initialStep,
    value: undefined,
    busy: false,
    inputId: "wizard-input",
    onAnswer: answer,
    onValueChange: change,
  };
  const view = mountSolid(() => {
    const props = merge(defaults, configure());
    return <WizardStepControls {...props} />;
  });
  return { ...view, answer, change };
}

it("submits both boolean channel choices", () => {
  const { container, answer } = mountStep(step("confirm"), () => ({
    presentation: "channels",
    confirmAffirmativeLabel: "Proceed",
  }));
  const buttons = container.querySelectorAll("button");
  expect(Array.from(buttons, (button) => button.textContent?.trim())).toEqual(["No", "Proceed"]);
  buttons[0]?.click();
  buttons[1]?.click();
  expect(answer.mock.calls).toEqual([[false], [true]]);
});

it("retains a channel draft through validation, submits it, and resets on a new step", () => {
  const [validationError, setValidationError] = createSignal<string>();
  const [stepId, setStepId] = createSignal("account");
  const { container, answer } = mountStep(step("text"), () => ({
    get step(): WizardStep {
      return { id: stepId(), type: "text", message: "Account name" };
    },
    value: "",
    presentation: "channels",
    get validationErrorId() {
      return validationError();
    },
  }));
  const input = container.querySelector("input")!;
  typeInto(input, "typed account");
  setValidationError("account-error");
  flush();
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("typed account");
  expect(input.getAttribute("aria-describedby")).toBe("account-error");
  submit(input.form!);
  expect(answer).toHaveBeenCalledExactlyOnceWith("typed account");
  setStepId("workspace");
  flush();
  const nextInput = container.querySelector("input")!;
  expect(nextInput.value).toBe("");
  submit(nextInput.form!);
  expect(answer).toHaveBeenLastCalledWith("");
});

it("preserves a sensitive answer and cancel action across reveal changes", () => {
  const cancel = vi.fn();
  const { container, answer } = mountStep({ ...step("text"), sensitive: true }, () => {
    const [value, setValue] = createSignal("", { ownedWrite: true });
    const [revealed, setRevealed] = createSignal(false, { ownedWrite: true });
    return {
      get value() {
        return value();
      },
      get sensitiveRevealed() {
        return revealed();
      },
      validationErrorId: "secret-error",
      leadingAction: cancelButton(cancel),
      onToggleSensitiveVisibility: () => setRevealed((current) => !current),
      onValueChange: (next) => setValue(typeof next === "string" ? next : ""),
    };
  });
  const input = container.querySelector("input")!;
  typeInto(input, "synthetic-key");
  flush();
  expect(input.type).toBe("password");
  expect(input.getAttribute("aria-describedby")).toBe("secret-error");
  expect(container.querySelector("[data-sensitive-mask-text]")?.textContent).toBe("*************");
  container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")?.click();
  flush();
  expect(input).toMatchObject({ type: "text", value: "synthetic-key" });
  submit(input.form!);
  expect(answer).toHaveBeenCalledWith("synthetic-key");
  container.querySelector<HTMLButtonElement>(".cancel")?.click();
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves model paragraphs, cancellation, and object-valued choices", () => {
  const cancel = vi.fn(),
    selected = { preset: "synthetic" };
  const { container, answer } = mountStep(
    {
      ...step("select", [option("One", selected), option("Two", 2)]),
      message: "Choose a preset\n\nSynthetic preset details",
    },
    () => ({ presentation: "model-setup", leadingAction: cancelButton(cancel) }),
  );
  expect(
    Array.from(container.querySelectorAll(".wizard-step__message p"), (p) => p.textContent),
  ).toEqual(["Choose a preset", "Synthetic preset details"]);
  const choices = container.querySelector('[role="group"]')!;
  expect(container.querySelectorAll(".cancel")).toHaveLength(1);
  choices.querySelector<HTMLButtonElement>(".cancel")?.click();
  expect(cancel).toHaveBeenCalledOnce();
  const firstChoice = choices.querySelector<HTMLButtonElement>("button.primary")!;
  expect(firstChoice.hasAttribute("autofocus")).toBe(true);
  firstChoice.click();
  expect(answer).toHaveBeenCalledWith(selected);
});

it.each([false, true])(
  "keeps model submission in its native form (manual sign-in: %s)",
  (externalAuthInput) => {
    const cancel = vi.fn();
    const { container, answer } = mountStep(step("text"), () => ({
      value: "synthetic-answer",
      presentation: "model-setup",
      externalAuthInput,
      leadingAction: cancelButton(cancel),
    }));
    const form = container.querySelector("form")!;
    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const cancelControl = container.querySelector<HTMLButtonElement>(".cancel")!;
    expect(submitButton.form).toBe(form);
    expect(Boolean(submitButton.closest("openclaw-modal-actions"))).toBe(!externalAuthInput);
    expect(Boolean(submitButton.closest("details"))).toBe(externalAuthInput);
    expect(cancelControl.closest("openclaw-modal-actions")).not.toBeNull();
    expect(cancelControl.closest("details")).toBeNull();
    submitButton.click();
    expect(answer).toHaveBeenCalledExactlyOnceWith("synthetic-answer");
    cancelControl.click();
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it("submits the channel ID from a single-choice picker", async () => {
  const { container, answer } = mountStep(
    step("select", [option("Telegram", "telegram"), option("Discord", "discord")]),
    () => ({ value: "telegram", presentation: "channels", channelSelect: true }),
  );
  await updatePickers(container);
  await choosePickerValue(
    container.querySelector<HTMLElement>("openclaw-select-picker")!,
    "discord",
  );
  expect(answer).toHaveBeenCalledExactlyOnceWith("discord");
});

it("delegates channel multiselect toggles and submits the caller-owned selection", () => {
  const { container, answer, change } = mountStep(
    step("multiselect", [option("First", "first"), option("Second", "second")]),
    () => ({ value: ["first"], presentation: "channels" }),
  );
  const options = container.querySelectorAll<HTMLButtonElement>(".channels-wizard__option");
  expect(Array.from(options, (button) => button.getAttribute("aria-pressed"))).toEqual([
    "true",
    "false",
  ]);
  options[1]?.click();
  expect(change).toHaveBeenCalledWith("second");
  container.querySelector<HTMLButtonElement>(".channels-wizard__footer button")?.click();
  expect(answer).toHaveBeenCalledWith(["first"]);
});
