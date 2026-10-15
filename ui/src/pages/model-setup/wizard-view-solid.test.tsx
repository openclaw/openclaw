/* @vitest-environment jsdom */

import { createSignal, flush, untrack } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ModelSetupWizardState } from "./state.ts";
import { ModelSetupWizard } from "./wizard-view-solid.tsx";

registerEnglishCatalog(registerModelSetupEnglish);

it("keeps the wizard and focused input mounted while typing a draft", async () => {
  const restoreDialog = installDialogPolyfill();
  onTestFinished(restoreDialog);
  const [draft, setDraft] = createSignal("initial");
  const answer = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(
    () => (
      <ModelSetupWizard
        mode="auth"
        state={{
          phase: "step",
          authChoice: "synthetic-provider",
          step: { id: "access-code", type: "text", message: "Access code" },
          busy: false,
          validationError: null,
        }}
        refreshWarning={null}
        value={draft()}
        onValueChange={(value) => setDraft(String(value))}
        onAnswer={answer}
        onCancel={() => undefined}
        onClose={() => undefined}
      />
    ),
    { container },
  );
  onTestFinished(() => {
    view.unmount();
    container.remove();
  });
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
  expect(input.value).toBe("initial typed");
  expect(untrack(draft)).toBe("initial typed");

  input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(answer).toHaveBeenCalledExactlyOnceWith("initial typed");
});

it("shows live sign-in activity and focuses the primary action as each step changes", async () => {
  onTestFinished(installDialogPolyfill());
  const [state, setState] = createSignal<ModelSetupWizardState>({
    phase: "step",
    authChoice: "synthetic-provider",
    step: {
      id: "consent",
      type: "select",
      message: "Runs on this host.\n\nHost permissions apply.",
      options: [{ value: "continue", label: "Continue" }],
    },
    busy: false,
    validationError: null,
  });
  const [startingChat, setStartingChat] = createSignal(false);
  const startChat = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(
    () => (
      <ModelSetupWizard
        mode="auth"
        state={state()}
        refreshWarning={null}
        doneMessage="Provider is connected"
        doneAction={{ label: "Start a new chat", disabled: startingChat(), onClick: startChat }}
        value="continue"
        onValueChange={() => undefined}
        onAnswer={() => undefined}
        onCancel={() => undefined}
        onClose={() => undefined}
      />
    ),
    { container },
  );
  onTestFinished(() => {
    view.unmount();
    container.remove();
  });
  flush();
  await container.querySelector("openclaw-modal-dialog")!.updateComplete;
  expect(document.activeElement?.textContent).toContain("Continue");
  setState({
    phase: "step",
    authChoice: "synthetic-provider",
    step: {
      id: "device-code",
      type: "progress",
      executor: "gateway",
      externalUrl: "https://example.com/sign-in",
      deviceCode: { code: "ABCD-1234" },
    },
    busy: true,
    validationError: null,
  });
  flush();
  expect(document.activeElement?.textContent).toContain("Open sign-in");
  const status = container.querySelector('[role="status"][aria-busy="true"]');
  expect(status?.textContent).toContain("Waiting for approval in your browser");
  expect(status?.querySelector(".wizard-step__spinner")).not.toBeNull();
  const code = container.querySelector("code");
  expect(container.querySelector("code")?.textContent).toBe("ABCD-1234");
  setState({
    phase: "step",
    authChoice: "synthetic-provider",
    step: {
      id: "verify",
      type: "progress",
      executor: "gateway",
      message: "Verifying access…",
      progressMessage: "Verifying access…",
      externalUrl: "https://example.com/sign-in",
      deviceCode: { code: "ABCD-1234" },
    },
    busy: true,
    validationError: null,
  });
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
  expect(primary.disabled).toBe(true);
  expect(primary.getAttribute("aria-busy")).toBe("true");
  expect(primary.querySelector(".btn__spinner")).not.toBeNull();
});
