/* @vitest-environment jsdom */

import { createSignal, flush, untrack } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
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
