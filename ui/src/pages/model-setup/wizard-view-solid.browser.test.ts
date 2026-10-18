import { createComponent, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../test-helpers/load-styles.ts";
import "../../styles/model-setup.css";
import type { ModelSetupWizardState } from "./state.ts";
import { ModelSetupWizard } from "./wizard-view-solid.tsx";

it.runIf("__vitest_browser__" in globalThis)(
  "keeps the success dialog height stable and centers the model readiness message",
  async () => {
    const [state, setState] = createSignal<ModelSetupWizardState>({
      phase: "starting",
      authChoice: "meta/muse-code",
      authLabel: "Muse Code",
    });
    const startChat = vi.fn();
    const close = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const view = mountSolid(
      () =>
        createComponent(ModelSetupWizard, {
          mode: "auth",
          get state() {
            return state();
          },
          refreshWarning: null,
          doneMessage: "Muse Code is connected",
          doneDescription: "Muse Spark 1.3 is ready for your agent.",
          doneAction: { label: "Start a new chat with Muse Spark 1.3", onClick: startChat },
          value: undefined,
          onValueChange: () => undefined,
          onAnswer: () => undefined,
          onCancel: () => undefined,
          onClose: close,
        }),
      { container },
    );
    onTestFinished(() => {
      view.unmount();
      container.remove();
    });
    await waitForSolid(() => expect(container.querySelector("dialog")?.open).toBe(true));
    const wizard = container.querySelector<HTMLElement>(".model-setup-wizard")!;
    await waitForSolid(() =>
      expect(wizard.getBoundingClientRect().height).toBe(Math.min(420, window.innerHeight - 48)),
    );
    const startingHeight = wizard.getBoundingClientRect().height;
    setState({ phase: "done", authLabel: "Muse Code" });
    await waitForSolid(() =>
      expect(container.querySelector(".model-setup-wizard__success-title")?.textContent).toBe(
        "Muse Code is connected",
      ),
    );
    expect(wizard.getBoundingClientRect().height).toBe(startingHeight);
    expect(container.querySelector(".model-setup-wizard__header")).toBeNull();
    const success = container.querySelector<HTMLElement>(".model-setup-wizard__success")!;
    const mark = success.querySelector<HTMLElement>(".model-setup-wizard__success-icon")!;
    const title = success.querySelector<HTMLElement>("h2")!;
    const description = success.querySelector<HTMLElement>("p")!;
    const markBounds = mark.getBoundingClientRect();
    const successBounds = success.getBoundingClientRect();
    expect(markBounds.left + markBounds.width / 2).toBeCloseTo(
      successBounds.left + successBounds.width / 2,
      0,
    );
    expect(title.getBoundingClientRect().top).toBeGreaterThan(markBounds.bottom);
    expect(description.getBoundingClientRect().top).toBeGreaterThan(
      title.getBoundingClientRect().bottom,
    );
    expect(description.textContent).toBe("Muse Spark 1.3 is ready for your agent.");
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>(".model-setup-wizard__footer button"),
    ];
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Start a new chat with Muse Spark 1.3",
      "Close",
    ]);
    actions[0]!.click();
    actions[1]!.click();
    expect(startChat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);
