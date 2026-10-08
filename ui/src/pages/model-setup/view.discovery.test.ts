/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { detected, mount, props, text } from "./test-helpers/view.test-support.ts";

describe("Gateway discovery inside Models", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([false, true])(
    "filters credential choices while retaining setup-only methods: %s",
    (setupOnly) => {
      const onStartAuth = vi.fn();
      const onManualConnect = vi.fn();
      const install = {
        id: "install-provider",
        label: "Installable provider",
        kind: "install" as const,
        featured: false,
      };
      const custom = {
        id: "custom-endpoint",
        label: "Compatible endpoint",
        kind: "custom" as const,
        featured: false,
      };
      const container = mount(
        props({
          embedded: true,
          agentLabel: "Writer",
          credentialChoices: ["openai-oauth", "other-device", "openai", "gemini-api-key"],
          manualProviderId: "special-token",
          manualApiKey: "synthetic-token",
          onStartAuth,
          onManualConnect,
          page: {
            phase: "ready",
            result: {
              ...detected,
              configuredModel: "openai/gpt-5.6-luna",
              authOptions: [...(detected.authOptions ?? []), install, custom],
              manualProviders: setupOnly
                ? [{ id: "special-token", brandId: "openai", label: "Special account token" }]
                : detected.manualProviders,
            },
          },
        }),
      );
      expect(container.querySelector(".content-header")).toBeNull();
      expect(container.querySelector(".model-setup__current")).toBeNull();
      expect(text(container)).toContain("for Writer");
      expect(text(container)).toContain("not the global defaults");
      expect(container.querySelector('[data-auth-choice="openai-oauth"]')).toBeNull();
      expect(container.querySelector('[data-prepare-choice="ollama"]')).not.toBeNull();
      for (const option of [install, custom]) {
        container
          .querySelector<HTMLButtonElement>(`[data-auth-choice="${option.id}"] button`)!
          .click();
        expect(onStartAuth).toHaveBeenLastCalledWith(option);
      }
      if (setupOnly) {
        expect(container.querySelector('[data-manual-provider="special-token"]')).not.toBeNull();
        container.querySelector<HTMLButtonElement>(".model-setup__manual button.primary")!.click();
        expect(onManualConnect).toHaveBeenCalledOnce();
      } else {
        expect(container.querySelector(".model-setup__manual")).toBeNull();
      }
    },
  );

  it.each(["wizard", "primary", "utility"] as const)(
    "leaves the %s dialog in control of its action",
    (mode) => {
      const onWizardCancel = vi.fn();
      const onClose = vi.fn();
      const onOpenChat = vi.fn();
      const onOpenSetupAssistant = vi.fn();
      const container = mount(
        props({
          embedded: true,
          onClose,
          onWizardCancel,
          onOpenChat,
          onOpenSetupAssistant,
          ...(mode === "wizard"
            ? {
                wizard: {
                  phase: "step",
                  authChoice: "local",
                  busy: false,
                  validationError: null,
                  step: { id: "choice", type: "confirm", message: "Prepare local model?" },
                },
              }
            : {
                activation: {
                  phase: "success",
                  modelRef: mode === "utility" ? "local/setup" : "openai/gpt-5.6-luna",
                  ...(mode === "utility" ? { modelTarget: "utility" } : {}),
                },
              }),
        }),
      );
      const dialogs = container.querySelectorAll("openclaw-modal-dialog");
      expect(dialogs).toHaveLength(1);
      if (mode === "wizard") {
        expect(container.querySelector(".model-setup__intro")).toBeNull();
        dialogs[0]!.dispatchEvent(
          new CustomEvent("modal-cancel", { bubbles: true, cancelable: true }),
        );
        expect(onWizardCancel).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
      } else {
        const success = container.querySelector(".model-setup-success")!;
        const done = success.querySelector<HTMLButtonElement>("button.primary")!;
        if (mode === "utility") {
          expect(text(success)).toContain("Setup & utility model ready");
          expect(text(success)).not.toContain("Active model");
          expect(text(success)).not.toContain("Return to Models");
          done.click();
          expect(onOpenSetupAssistant).toHaveBeenCalledOnce();
          expect(onOpenChat).not.toHaveBeenCalled();
        } else {
          expect(done.textContent).toContain("Return to Models");
          done.click();
          expect(onOpenChat).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("keeps utility actions distinct from agent primary selection during rescans", () => {
    const utility = {
      kind: "provider-auto:local" as const,
      label: "Local utility",
      detail: "Available on this Gateway",
      modelRef: "local/setup",
      recommended: false,
      modelTarget: "utility" as const,
    };
    const onActivateCandidate = vi.fn();
    const page = {
      phase: "ready" as const,
      result: {
        ...detected,
        configuredModel: "cloud/primary",
        candidates: [...detected.candidates, utility],
      },
    };
    const container = mount(props({ embedded: true, page, onActivateCandidate }));
    const utilityButton = container.querySelector<HTMLButtonElement>(
      '[data-candidate-kind="provider-auto:local"] button',
    )!;
    expect(utilityButton.textContent).toContain("Use as utility");
    expect(
      container.querySelector('[data-candidate-kind="codex-cli"] button')?.textContent,
    ).toContain("Test & use for this agent");
    utilityButton.click();
    expect(onActivateCandidate).toHaveBeenCalledExactlyOnceWith(utility);
    const scanning = mount(props({ embedded: true, detecting: true, page }));
    const buttons = scanning.querySelectorAll<HTMLButtonElement>("[data-candidate-kind] button");
    expect(buttons).toHaveLength(2);
    expect([...buttons].every((button) => button.disabled)).toBe(true);
  });
});
