/* @vitest-environment jsdom */

import { createSignal, flush, untrack } from "solid-js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ModelSetupWizardState } from "./state.ts";
import { ModelSetupWizard, type WizardViewProps } from "./wizard-view-solid.tsx";

registerEnglishCatalog(registerModelSetupEnglish);

beforeEach(() => onTestFinished(installDialogPolyfill()));

function fakeTime() {
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());
}

const wizardDefaults = {
  mode: "auth" as const,
  refreshWarning: null,
  onValueChange: () => undefined,
  onAnswer: () => undefined,
  onCancel: () => undefined,
  onClose: () => undefined,
};

async function createWizardHarness(
  read: () => Pick<WizardViewProps, "state"> & Partial<WizardViewProps>,
) {
  const { container } = mountSolid(() => (
    <ModelSetupWizard {...wizardDefaults} value={undefined} {...read()} />
  ));
  flush();
  await container.querySelector("openclaw-modal-dialog")!.updateComplete;
  return {
    container,
    get: <E extends Element = HTMLElement>(selector: string) =>
      container.querySelector<E>(selector)!,
    expectText: (selector: string, content: string) =>
      expect(container.querySelector(selector)?.textContent).toContain(content),
    namedButton: (label: string) =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      ),
  };
}

type StepState = Extract<ModelSetupWizardState, { phase: "step" }>;
function stepState(step: StepState["step"], busy = false): StepState {
  return { phase: "step", authChoice: "synthetic-provider", step, busy, validationError: null };
}

it("keeps the wizard draft mounted while typing and presenting a pending save", async () => {
  const [draft, setDraft] = createSignal("initial");
  const [saving, setSaving] = createSignal(false);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const answer = vi.fn();
  const { container, get, expectText, namedButton } = await createWizardHarness(() => ({
    state: {
      ...stepState({ id: "access-code", type: "text", message: "Access code", sensitive: true }),
      validationError: validationError(),
    },
    busy: saving(),
    value: draft(),
    onValueChange: (value) => setDraft(String(value)),
    onAnswer: answer,
  }));
  const modal = get("openclaw-modal-dialog");
  const input = get<HTMLInputElement>("input");
  const label = get<HTMLLabelElement>(`label[for="${input.id}"]`);
  expect([input.type, label.textContent]).toEqual(["password", "Access code"]);
  expect(input.labels).toContain(label);
  input.focus();
  input.value = "initial typed";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();

  expect(container.querySelector("openclaw-modal-dialog")).toBe(modal);
  expect(get("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect([input.value, untrack(draft)]).toEqual(["initial typed", "initial typed"]);

  setSaving(true);
  flush();
  expect(get("input")).toBe(input);
  expect(input).toMatchObject({ value: "initial typed", disabled: true });
  expectText('[role="status"][aria-busy="true"]', "Working");
  expect(namedButton("Cancel")?.disabled).toBe(false);
  setSaving(false);
  flush();
  expect(input.disabled).toBe(false);

  input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(answer).toHaveBeenCalledExactlyOnceWith("initial typed");
  setValidationError("That access value is not valid.");
  flush();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toContain(
    "That access value is not valid.",
  );
  setValidationError(null);
  flush();
  expect([input.hasAttribute("aria-invalid"), input.hasAttribute("aria-describedby")]).toEqual([
    false,
    false,
  ]);
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
  const { container, get } = await createWizardHarness(() => ({
    state: state(),
    doneMessage: "Provider is connected",
    doneAction: { label: "Start a new chat", disabled: startingChat(), onClick: startChat },
    value: "continue",
  }));
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
  expect(document.activeElement?.textContent).toContain("Reopen browser tab");
  const status = container.querySelector('.wizard-sign-in [role="status"]');
  expect(status?.textContent).toContain("Waiting for sign-in");
  expect(container.querySelector(".wizard-sign-in__ring")).not.toBeNull();
  const code = get("code");
  expect(code.textContent).toBe("ABCD-1234");
  const verifyStep = {
    ...deviceStep,
    id: "verify",
    deviceCode: { code: "ABCD-1234" },
    message: "Verifying access…",
    progressMessage: "Verifying access…",
  };
  setState(stepState(verifyStep, true));
  flush();
  expect(container.querySelectorAll(".wizard-sign-in__ring")).toHaveLength(1);
  expect(status?.textContent).toContain("Verifying access…");
  expect(container.querySelector("code")).toBe(code);
  setState({ phase: "done" });
  flush();
  const primary = get<HTMLButtonElement>("[data-login-start-chat]");
  expect(document.activeElement).toBe(primary);
  expect(container.querySelector(".wizard-step__spinner")).toBeNull();
  primary.click();
  expect(startChat).toHaveBeenCalledOnce();
  setStartingChat(true);
  flush();
  expect([primary.disabled, primary.getAttribute("aria-busy")]).toEqual([true, "true"]);
  expect(primary.querySelector(".btn__spinner")).not.toBeNull();
});

const redirectStep = {
  id: "oauth",
  type: "progress" as const,
  executor: "gateway" as const,
  externalUrl: "https://example.com/authorize",
};

it("presents browser sign-in as a provider badge with quiet recovery and corner cancel", async () => {
  fakeTime();
  const cancel = vi.fn();
  const { container, get, expectText, namedButton } = await createWizardHarness(() => ({
    state: { ...stepState(redirectStep, true), authLabel: "Linear" },
    onCancel: cancel,
  }));

  expect(container.querySelector(".model-setup-wizard__header")).toBeNull();
  expect(get('.wizard-sign-in [role="status"]').textContent).toBe("Waiting for Linear…");
  const link = get<HTMLAnchorElement>(".wizard-step__external-link");
  expect(link).toMatchObject({ target: "_blank", rel: "noreferrer" });
  expect([link.textContent, link.classList.contains("primary")]).toEqual([
    "Reopen browser tab",
    false,
  ]);
  expect(container.querySelector(".btn.primary")).toBeNull();
  expect(namedButton("Cancel")).toBeUndefined();

  get<HTMLButtonElement>('[aria-label="Cancel sign-in"]').click();
  expect(cancel).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(45_000);
  flush();
  expectText(".wizard-sign-in__callout", "another browser or profile");
  expect([link.textContent, link.classList.contains("primary")]).toEqual(["Try again", true]);
});

it("shows device-code expiry only near the end and retires an expired code", async () => {
  fakeTime();
  const { container, expectText } = await createWizardHarness(() => ({
    state: {
      ...stepState(
        { ...redirectStep, id: "device", deviceCode: { code: "WDJB-MJHT", expiresInMinutes: 7 } },
        true,
      ),
      authLabel: "GitHub",
    },
  }));

  expectText(".wizard-sign-in__lead", "Make sure it shows the same code before you approve.");
  expect(container.querySelector("code")?.textContent).toBe("WDJB-MJHT");
  expect(container.textContent).not.toContain("Expires in");

  vi.advanceTimersByTime(3 * 60_000);
  flush();
  expect(container.textContent).toContain("Expires in 4 minutes");

  vi.advanceTimersByTime(4 * 60_000);
  flush();
  expect(container.querySelector("code")).toBeNull();
  expectText('[role="alert"]', "This code expired. Nothing was connected.");
  expect(container.querySelector(".wizard-sign-in__ring")).toBeNull();
});
