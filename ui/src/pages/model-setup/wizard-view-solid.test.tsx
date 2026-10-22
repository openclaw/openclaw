/* @vitest-environment jsdom */

import { createSignal, flush, untrack } from "solid-js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ModelSetupWizardState } from "./state.ts";
import { ModelSetupWizard } from "./wizard-view-solid.tsx";

registerEnglishCatalog(registerModelSetupEnglish);

beforeEach(() => onTestFinished(installDialogPolyfill()));

const wizardDefaults = {
  mode: "auth" as const,
  refreshWarning: null,
  onValueChange: () => undefined,
  onAnswer: () => undefined,
  onCancel: () => undefined,
  onClose: () => undefined,
};

type StepState = Extract<ModelSetupWizardState, { phase: "step" }>;
function stepState(step: StepState["step"], busy = false): StepState {
  return { phase: "step", authChoice: "synthetic-provider", step, busy, validationError: null };
}

it("keeps the wizard draft mounted while typing and presenting a pending save", async () => {
  const [draft, setDraft] = createSignal("initial");
  const [saving, setSaving] = createSignal(false);
  const answer = vi.fn();
  const { container } = mountSolid(() => (
    <ModelSetupWizard
      {...wizardDefaults}
      state={stepState({ id: "access-code", type: "text", message: "Access code" })}
      busy={saving()}
      value={draft()}
      onValueChange={(value) => setDraft(String(value))}
      onAnswer={answer}
    />
  ));
  flush();
  const modal = container.querySelector("openclaw-modal-dialog")!;
  await modal.updateComplete;
  const input = container.querySelector<HTMLInputElement>("#model-setup-wizard-text-input")!;
  input.focus();
  input.value = "initial typed";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();

  expect(container.querySelector("openclaw-modal-dialog")).toBe(modal);
  expect(container.querySelector("#model-setup-wizard-text-input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect([input.value, untrack(draft)]).toEqual(["initial typed", "initial typed"]);

  setSaving(true);
  flush();
  expect(container.querySelector("#model-setup-wizard-text-input")).toBe(input);
  expect(input.value).toBe("initial typed");
  expect(input.disabled).toBe(true);
  expect(container.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain(
    "Working",
  );
  const cancel = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Cancel",
  );
  expect(cancel?.disabled).toBe(false);
  setSaving(false);
  flush();
  expect(input.disabled).toBe(false);

  input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(answer).toHaveBeenCalledExactlyOnceWith("initial typed");
});

it("shows live sign-in activity and focuses the primary action as each step changes", async () => {
  const [state, setState] = createSignal<ModelSetupWizardState>(
    stepState({
      id: "consent",
      type: "select",
      message: "Runs on this host.\n\nHost permissions apply.",
      options: [{ value: "continue", label: "Continue" }],
    }),
  );
  const [startingChat, setStartingChat] = createSignal(false);
  const startChat = vi.fn();
  const { container } = mountSolid(() => (
    <ModelSetupWizard
      {...wizardDefaults}
      state={state()}
      doneMessage="Provider is connected"
      doneAction={{ label: "Start a new chat", disabled: startingChat(), onClick: startChat }}
      value="continue"
    />
  ));
  flush();
  await container.querySelector("openclaw-modal-dialog")!.updateComplete;
  expect(document.activeElement?.textContent).toContain("Continue");
  const deviceStep = {
    id: "device-code",
    type: "progress" as const,
    executor: "gateway" as const,
    externalUrl: "https://example.com/sign-in",
    deviceCode: { code: "ABCD-1234" },
  };
  setState(stepState(deviceStep, true));
  flush();
  expect(document.activeElement?.textContent).toContain("Open sign-in");
  const status = container.querySelector('[role="status"][aria-busy="true"]');
  expect(status?.textContent).toContain("Waiting for approval in your browser");
  expect(status?.querySelector(".wizard-step__spinner")).not.toBeNull();
  const code = container.querySelector("code");
  expect(container.querySelector("code")?.textContent).toBe("ABCD-1234");
  const verifyStep = {
    ...deviceStep,
    id: "verify",
    deviceCode: { code: "ABCD-1234" },
    message: "Verifying access…",
    progressMessage: "Verifying access…",
  };
  setState(stepState(verifyStep, true));
  flush();
  expect(container.querySelectorAll(".wizard-step__spinner")).toHaveLength(1);
  expect(container.textContent).toContain("Verifying access…");
  expect(container.querySelector("code")).toBe(code);
  setState({ phase: "done" });
  flush();
  const primary = container.querySelector<HTMLButtonElement>("[data-login-start-chat]")!;
  expect(document.activeElement).toBe(primary);
  expect(container.querySelector(".wizard-step__spinner")).toBeNull();
  primary.click();
  expect(startChat).toHaveBeenCalledOnce();
  setStartingChat(true);
  flush();
  expect([primary.disabled, primary.getAttribute("aria-busy")]).toEqual([true, "true"]);
  expect(primary.querySelector(".btn__spinner")).not.toBeNull();
});
