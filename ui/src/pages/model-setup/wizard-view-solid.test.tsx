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
  expect(document.activeElement?.textContent).toContain("Reopen browser tab");
  expect(container.querySelector(".wizard-sign-in__title")?.textContent).toBe(
    "Enter this code in your browser",
  );
  const status = container.querySelector('.wizard-sign-in [role="status"]');
  expect(status?.textContent).toContain("Waiting for sign-in");
  expect(container.querySelector(".wizard-sign-in__ring")).not.toBeNull();
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
  expect(container.querySelectorAll(".wizard-sign-in__ring")).toHaveLength(1);
  expect(status?.textContent).toContain("Verifying access…");
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

const redirectStep = {
  id: "oauth",
  type: "progress" as const,
  executor: "gateway" as const,
  externalUrl: "https://example.com/authorize",
};

it("presents browser sign-in as a provider badge with quiet recovery and corner cancel", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const cancel = vi.fn();
  const { container } = mountSolid(() => (
    <ModelSetupWizard
      {...wizardDefaults}
      state={{ ...stepState(redirectStep, true), authLabel: "Linear" }}
      value={undefined}
      onCancel={cancel}
    />
  ));
  flush();
  await container.querySelector("openclaw-modal-dialog")!.updateComplete;

  expect(container.querySelector(".model-setup-wizard__header")).toBeNull();
  expect(container.querySelector(".wizard-sign-in__title")?.textContent).toBe(
    "Continue in your browser",
  );
  expect(container.querySelector(".wizard-sign-in__lead")?.textContent).toBe(
    "Linear is open in a new tab. Approve access there. This window updates by itself.",
  );
  expect(container.querySelector('.wizard-sign-in [role="status"]')?.textContent).toBe(
    "Waiting for Linear…",
  );
  const link = container.querySelector<HTMLAnchorElement>(".wizard-step__external-link")!;
  expect([link.textContent, link.classList.contains("primary")]).toEqual([
    "Reopen browser tab",
    false,
  ]);
  expect(container.querySelector(".wizard-sign-in__link")?.textContent).toBe("Copy sign-in link");
  expect(container.querySelector(".btn.primary")).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Cancel",
    ),
  ).toBe(false);

  container.querySelector<HTMLButtonElement>('[aria-label="Cancel sign-in"]')!.click();
  expect(cancel).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(45_000);
  flush();
  expect(container.querySelector(".wizard-sign-in__callout")?.textContent).toContain(
    "another browser or profile",
  );
  expect([link.textContent, link.classList.contains("primary")]).toEqual(["Try again", true]);
});

it("shows device-code expiry only near the end and retires an expired code", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { container } = mountSolid(() => (
    <ModelSetupWizard
      {...wizardDefaults}
      state={{
        ...stepState(
          { ...redirectStep, id: "device", deviceCode: { code: "WDJB-MJHT", expiresInMinutes: 7 } },
          true,
        ),
        authLabel: "GitHub",
      }}
      value={undefined}
    />
  ));
  flush();
  await container.querySelector("openclaw-modal-dialog")!.updateComplete;

  expect(container.querySelector(".wizard-sign-in__lead")?.textContent).toBe(
    "GitHub is open in a new tab. Make sure it shows the same code before you approve.",
  );
  expect(container.querySelector("code")?.textContent).toBe("WDJB-MJHT");
  expect(container.textContent).not.toContain("Expires in");

  vi.advanceTimersByTime(3 * 60_000);
  flush();
  expect(container.textContent).toContain("Expires in 4 minutes");

  vi.advanceTimersByTime(4 * 60_000);
  flush();
  expect(container.querySelector("code")).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "This code expired. Nothing was connected.",
  );
  expect(container.querySelector(".wizard-sign-in__ring")).toBeNull();
});
