import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { choosePickerValue, updatePickers } from "../test-helpers/select-picker.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { WizardStepControls } from "./wizard-step-controls.tsx";

afterEach(cleanupSolid);

describe("WizardStepControls", () => {
  it("submits boolean confirmation answers and replaces busy channel choices with a status", () => {
    const [busy, setBusy] = createSignal(false);
    const answer = vi.fn();
    const { container } = mountSolid(() => (
      <WizardStepControls
        step={{ id: "confirm", type: "confirm", message: "Continue?" }}
        value={undefined}
        busy={busy()}
        inputId="wizard-confirm"
        presentation="channels"
        confirmAffirmativeLabel="Proceed"
        busyLabel="Submitting answer"
        onValueChange={vi.fn()}
        onAnswer={answer}
      />
    ));
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(Array.from(buttons, (button) => button.textContent?.trim())).toEqual(["No", "Proceed"]);
    buttons[0]?.click();
    buttons[1]?.click();
    expect(answer.mock.calls).toEqual([[false], [true]]);

    setBusy(true);
    flush();
    const busyButton = container.querySelector<HTMLButtonElement>("button");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Submitting answer");
  });

  it("retains an uncommitted channel draft through validation updates and submits its DOM value", () => {
    const [validationError, setValidationError] = createSignal<string>();
    const [stepId, setStepId] = createSignal("account");
    const answer = vi.fn();
    const { container } = mountSolid(() => (
      <WizardStepControls
        step={{ id: stepId(), type: "text", message: "Account name" }}
        value=""
        busy={false}
        inputId="wizard-account"
        presentation="channels"
        validationErrorId={validationError()}
        onValueChange={vi.fn()}
        onAnswer={answer}
      />
    ));
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "typed account";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setValidationError("account-error");
    flush();
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("typed account");
    expect(input.getAttribute("aria-describedby")).toBe("account-error");
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(answer).toHaveBeenCalledExactlyOnceWith("typed account");

    setStepId("workspace");
    flush();
    const nextInput = container.querySelector<HTMLInputElement>("input")!;
    expect(nextInput.value).toBe("");
    nextInput.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(answer).toHaveBeenLastCalledWith("");
  });

  it("keeps a sensitive answer and its native cancel action across reveal changes", () => {
    const answer = vi.fn();
    const cancel = vi.fn();
    const { container } = mountSolid(() => {
      const [value, setValue] = createSignal("", { ownedWrite: true });
      const [revealed, setRevealed] = createSignal(false, { ownedWrite: true });
      return (
        <WizardStepControls
          step={{ id: "secret", type: "text", message: "Synthetic secret", sensitive: true }}
          value={value()}
          busy={false}
          inputId="wizard-secret"
          validationErrorId="secret-error"
          sensitiveRevealed={revealed()}
          onToggleSensitiveVisibility={() => setRevealed((current) => !current)}
          onValueChange={(next) => setValue(typeof next === "string" ? next : "")}
          onAnswer={answer}
          leadingAction={
            <button type="button" class="cancel" onClick={cancel}>
              Cancel
            </button>
          }
        />
      );
    });
    const input = container.querySelector<HTMLInputElement>("#wizard-secret");
    if (input) {
      input.value = "synthetic-key";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    flush();
    expect(input?.type).toBe("password");
    expect(input?.getAttribute("aria-describedby")).toBe("secret-error");
    expect(container.querySelector("[data-sensitive-mask-text]")?.textContent).toBe(
      "*************",
    );
    container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")?.click();
    flush();
    expect(input?.type).toBe("text");
    expect(input?.value).toBe("synthetic-key");
    container
      .querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(answer).toHaveBeenCalledWith("synthetic-key");
    container.querySelector<HTMLButtonElement>(".cancel")?.click();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves model setup paragraphs, cancellation, and non-string single-choice answers", () => {
    const answer = vi.fn();
    const cancel = vi.fn();
    const selected = { preset: "synthetic" };
    const { container } = mountSolid(() => (
      <WizardStepControls
        step={{
          id: "choice",
          type: "select",
          message: "Choose a preset\n\nSynthetic preset details",
          options: [
            { label: "One", value: selected },
            { label: "Two", value: 2 },
          ],
        }}
        value={undefined}
        presentation="model-setup"
        busy={false}
        inputId="wizard-choice"
        onValueChange={vi.fn()}
        onAnswer={answer}
        leadingAction={
          <button type="button" class="cancel" onClick={cancel}>
            Cancel
          </button>
        }
      />
    ));
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
    "keeps model submission in its native form with manual sign-in %s",
    (externalAuthInput) => {
      const answer = vi.fn();
      const cancel = vi.fn();
      const { container } = mountSolid(() => (
        <WizardStepControls
          step={{ id: "token", type: "text", message: "Synthetic token" }}
          value="synthetic-answer"
          presentation="model-setup"
          externalAuthInput={externalAuthInput}
          busy={false}
          inputId="wizard-token"
          onValueChange={vi.fn()}
          onAnswer={answer}
          leadingAction={
            <button type="button" class="cancel" onClick={cancel}>
              Cancel
            </button>
          }
        />
      ));
      const form = container.querySelector<HTMLFormElement>("form")!;
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const cancelButton = container.querySelector<HTMLButtonElement>(".cancel")!;
      expect(submit.form).toBe(form);
      expect(Boolean(submit.closest("openclaw-modal-actions"))).toBe(!externalAuthInput);
      expect(Boolean(submit.closest("details"))).toBe(externalAuthInput);
      expect(cancelButton.closest("openclaw-modal-actions")).not.toBeNull();
      expect(cancelButton.closest("details")).toBeNull();
      submit.click();
      expect(answer).toHaveBeenCalledExactlyOnceWith("synthetic-answer");
      cancelButton.click();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("submits the channel ID from a single-choice picker", async () => {
    const answer = vi.fn();
    const { container } = mountSolid(() => (
      <WizardStepControls
        step={{
          id: "channel",
          type: "select",
          message: "Choose a channel",
          options: [
            { label: "Telegram", value: "telegram" },
            { label: "Discord", value: "discord" },
          ],
        }}
        value="telegram"
        busy={false}
        inputId="wizard-channel"
        presentation="channels"
        channelSelect
        onValueChange={vi.fn()}
        onAnswer={answer}
      />
    ));
    await updatePickers(container);
    const picker = container.querySelector<HTMLElement>("openclaw-select-picker")!;
    await choosePickerValue(picker, "discord");
    expect(answer).toHaveBeenCalledExactlyOnceWith("discord");
  });

  it("delegates channel multiselect toggles and submits the caller-owned selection", () => {
    const change = vi.fn();
    const answer = vi.fn();
    const { container } = mountSolid(() => (
      <WizardStepControls
        step={{
          id: "channels",
          type: "multiselect",
          message: "Choose channels",
          options: [
            { label: "First", value: "first" },
            { label: "Second", value: "second" },
          ],
        }}
        value={["first"]}
        busy={false}
        inputId="wizard-channels"
        presentation="channels"
        onValueChange={change}
        onAnswer={answer}
      />
    ));
    const options = container.querySelectorAll<HTMLButtonElement>(".channels-wizard__option");
    expect(options[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(options[1]?.getAttribute("aria-pressed")).toBe("false");
    options[1]?.click();
    expect(change).toHaveBeenCalledWith("second");
    container.querySelector<HTMLButtonElement>(".channels-wizard__footer button")?.click();
    expect(answer).toHaveBeenCalledWith(["first"]);
  });
});
