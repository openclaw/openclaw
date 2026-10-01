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

  it("keeps local, install, and custom activation without duplicating credential-only choices", () => {
    const onStartAuth = vi.fn();
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

        page: {
          phase: "ready",
          result: {
            ...detected,
            configuredModel: "openai/gpt-5.6-luna",
            authOptions: [...(detected.authOptions ?? []), install, custom],
          },
        },
        onStartAuth,
      }),
    );
    expect(container.querySelector(".content-header")).toBeNull();
    expect(container.querySelector(".model-setup__current")).toBeNull();
    expect(text(container)).toContain("for Writer");
    expect(text(container)).toContain("not the global defaults");
    expect(container.querySelector('[data-auth-choice="openai-oauth"]')).toBeNull();
    expect(container.querySelector(".model-setup__manual")).toBeNull();
    expect(container.querySelector('[data-prepare-choice="ollama"]')).not.toBeNull();
    container
      .querySelector<HTMLButtonElement>('[data-auth-choice="install-provider"] button')!
      .click();
    expect(onStartAuth).toHaveBeenLastCalledWith(install);
    container
      .querySelector<HTMLButtonElement>('[data-auth-choice="custom-endpoint"] button')!
      .click();
    expect(onStartAuth).toHaveBeenLastCalledWith(custom);
  });

  it("lets the admitted wizard own cancellation without a competing discovery dialog", () => {
    const onWizardCancel = vi.fn();
    const onClose = vi.fn();
    const container = mount(
      props({
        embedded: true,
        onClose,
        onWizardCancel,
        wizard: {
          phase: "step",
          authChoice: "local",
          busy: false,
          validationError: null,
          step: { id: "choice", type: "confirm", message: "Prepare local model?" },
        },
      }),
    );
    const dialogs = container.querySelectorAll("openclaw-modal-dialog");
    expect(dialogs).toHaveLength(1);
    expect(container.querySelector(".model-setup__intro")).toBeNull();
    dialogs[0]!.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, cancelable: true }));
    expect(onWizardCancel).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns a successful activation to Models instead of navigating to chat", () => {
    const onOpenChat = vi.fn();
    const container = mount(
      props({
        embedded: true,
        onOpenChat,
        activation: { phase: "success", modelRef: "openai/gpt-5.6-luna" },
      }),
    );
    expect(container.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
    const done = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Return to Models"),
    );
    expect(done).toBeDefined();
    done!.click();
    expect(onOpenChat).toHaveBeenCalledOnce();
  });
  it("retains a setup-only secret method when the same provider offers credential-only OAuth", () => {
    const onManualConnect = vi.fn();
    const container = mount(
      props({
        embedded: true,
        credentialChoices: ["openai-oauth"],
        manualProviderId: "special-token",
        manualApiKey: "synthetic-token",
        onManualConnect,
        page: {
          phase: "ready",
          result: {
            ...detected,
            manualProviders: [
              { id: "special-token", brandId: "openai", label: "Special account token" },
            ],
          },
        },
      }),
    );
    expect(container.querySelector('[data-manual-provider="special-token"]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>(".model-setup__manual button.primary")!.click();
    expect(onManualConnect).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-auth-choice="openai-oauth"]')).toBeNull();
  });

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

  it("keeps configured utility repair and assistant access in embedded discovery", () => {
    const utility = {
      kind: "provider-auto:local" as const,
      label: "Local utility",
      detail: "Available on this Gateway",
      modelRef: "local/setup",
      recommended: false,
      modelTarget: "utility" as const,
    };
    const onOpenSetupAssistant = vi.fn();
    const onActivateCandidate = vi.fn();
    const container = mount(
      props({
        embedded: true,
        onOpenSetupAssistant,
        onActivateCandidate,
        page: {
          phase: "ready",
          result: {
            ...detected,
            configuredModel: "cloud/primary",
            utilityModel: utility.modelRef,
            candidates: [utility],
          },
        },
      }),
    );
    expect(container.querySelector(".model-setup__current")).toBeNull();
    expect(container.querySelector('[data-candidate-kind="provider-auto:local"]')).toBeNull();
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".model-setup__utility button"),
    ];
    buttons.find((button) => button.textContent?.includes("Recheck & repair"))!.click();
    expect(onActivateCandidate).toHaveBeenCalledExactlyOnceWith(utility);
    buttons.find((button) => button.textContent?.includes("Open setup assistant"))!.click();
    expect(onOpenSetupAssistant).toHaveBeenCalledOnce();
  });

  it("opens the setup assistant instead of closing Models after utility activation", () => {
    const onOpenChat = vi.fn();
    const onOpenSetupAssistant = vi.fn();
    const container = mount(
      props({
        embedded: true,
        onOpenChat,
        onOpenSetupAssistant,
        activation: { phase: "success", modelRef: "local/setup", modelTarget: "utility" },
      }),
    );
    const success = container.querySelector(".model-setup-success")!;
    expect(text(success)).toContain("Setup & utility model ready");
    expect(text(success)).not.toContain("Active model");
    expect(text(success)).not.toContain("Return to Models");
    success.querySelector<HTMLButtonElement>("button.primary")!.click();
    expect(onOpenSetupAssistant).toHaveBeenCalledOnce();
    expect(onOpenChat).not.toHaveBeenCalled();
  });
});
