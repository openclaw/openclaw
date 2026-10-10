/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { activationTargetId } from "./state.ts";
import { detected, mount, props, text } from "./test-helpers/view.test-support.ts";
import { renderModelSetup } from "./view.ts";

function wizardStep(step: WizardStep, value: unknown = step.initialValue): HTMLDivElement {
  return mount(
    props({
      wizard: {
        phase: "step",
        authChoice: "provider-auth",
        step,
        busy: false,
        validationError: null,
      },
      wizardValue: value,
    }),
  );
}

const ready: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [],
  recommendedInstalls: [],
  workspace: "/tmp/workspace",
  configuredModel: "openai/gpt-5",
  setupComplete: true,
};

const firstRunProps = () =>
  props({
    page: { phase: "ready", result: ready },
    firstRun: true,
    manualProviderId: "",
    iconUrls: {},
  });

describe("renderModelSetup", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("shows detected authentication without credential values", () => {
    const detail = "logged in · ChatGPT account · alex@example.com";
    const secret = "synthetic-private-token";
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [{ ...detected.candidates[0]!, detail: `${detail} · token=${secret}` }],
          },
        },
      }),
    );
    const row = container.querySelector('[data-candidate-kind="codex-cli"]')!;

    expect(text(row)).toContain(detail);
    expect(text(row)).not.toContain(secret);
  });

  it("derives prepare rows from accepted choice ids and hides usable local candidates", () => {
    const onStartPrepare = vi.fn();
    const container = mount(props({ onStartPrepare }));

    const ollama = container.querySelector<HTMLButtonElement>(
      '[data-prepare-choice="ollama"] button',
    );
    const llamaCpp = container.querySelector<HTMLButtonElement>(
      '[data-prepare-choice="llama-cpp"] button',
    );
    expect(ollama?.textContent).toContain("Choose connection");
    expect(llamaCpp?.textContent).toContain("Set up model");
    expect(
      container.querySelector<HTMLButtonElement>('[data-prepare-choice="lmstudio"] button')
        ?.textContent,
    ).toContain("Connect server");
    const llamaCppRow = container.querySelector('[data-prepare-choice="llama-cpp"]');
    expect(llamaCppRow?.querySelector('[data-provider-icon="llamacpp"]')).not.toBeNull();
    expect(text(llamaCppRow!)).toContain("llama.cpp");
    expect(text(llamaCppRow!)).not.toContain("Gemma");
    expect(llamaCppRow?.classList.contains("model-setup__prepare-row--featured")).toBe(false);
    ollama?.click();
    expect(onStartPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: "ollama" }));

    const withUsableOllama = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [
              ...detected.candidates,
              {
                kind: "provider-auto:ollama",
                label: "Ollama",
                detail: "available locally",
                modelRef: "ollama/qwen3:8b",
                recommended: false,
              },
            ],
          },
        },
      }),
    );
    expect(withUsableOllama.querySelector('[data-prepare-choice="ollama"]')).toBeNull();
  });

  it("renders recommended install cards only when candidates and sign-ins are empty", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: { ...detected, candidates: [], authOptions: [] },
        },
      }),
    );

    expect(text(container)).toContain("Recommended installs");
    expect(text(container)).toContain("Ollama Run open models locally");
    const card = container.querySelector('[data-recommended-install="ollama"]');
    const icon = card?.querySelector<HTMLElement>('[data-provider-icon="ollama"]');
    const link = card?.querySelector<HTMLAnchorElement>("a");
    expect(icon).not.toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    expect(link?.href).toBe("https://ollama.com/download");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener");

    const withSignIn = mount(
      props({
        page: { phase: "ready", result: { ...detected, candidates: [] } },
      }),
    );
    expect(withSignIn.querySelector(".model-setup__empty")).toBeNull();
  });

  it("uses explicit brand identity without guessing from labels or opaque ids", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "custom-login",
                brandId: "claude",
                label: "Company account",
                icon: "https://cdn.example.com/custom.png",
              },
            ],
          },
        },
        manualProviderId: "custom-login",
        iconUrls: {},
      }),
    );

    expect(
      container.querySelector('.model-setup__manual [data-provider-icon="claude"]'),
    ).not.toBeNull();
    expect(container.querySelector(".model-setup__manual img")).toBeNull();
  });

  it("uses proxied artwork for unknown providers and invalidates broken blobs", () => {
    const iconUrl = "https://cdn.example.com/acme.png";
    const onIconError = vi.fn();
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "acme",
                label: "Acme",
                icon: iconUrl,
              },
            ],
          },
        },
        manualProviderId: "acme",
        iconUrls: { [iconUrl]: "blob:acme" },
        onIconError,
      }),
    );

    const image = container.querySelector<HTMLImageElement>(".model-setup__manual img");
    expect(image?.src).toBe("blob:acme");
    expect(image?.alt).toBe("Acme");
    image?.dispatchEvent(new Event("error"));
    expect(onIconError).toHaveBeenCalledWith(iconUrl);
    expect(container.innerHTML).not.toContain(iconUrl);
  });

  it("keeps saved replacement credentials selectable without repeating the current route", () => {
    const onActivateCandidate = vi.fn();
    const savedCandidate: SystemAgentSetupDetectResult["candidates"][number] = {
      kind: "saved-auth:openai:replacement",
      brandId: "openai",
      label: "Saved OpenAI credentials",
      detail: "Saved for retry after a failed setup test",
      modelRef: "openai/gpt-5",
      recommended: false,
      credentials: true,
    };
    const container = mount(
      props({
        onActivateCandidate,
        page: {
          phase: "ready",
          result: {
            ...detected,
            configuredModel: savedCandidate.modelRef,
            setupComplete: true,
            candidates: [
              {
                kind: "existing-model",
                brandId: "openai",
                label: "Current model",
                detail: "openai/gpt-5 — already configured",
                modelRef: savedCandidate.modelRef,
                recommended: false,
                credentials: true,
              },
              { ...savedCandidate, kind: "provider-auto:openai", label: "OpenAI" },
              savedCandidate,
              {
                kind: "claude-cli",
                brandId: "claude",
                label: "Claude Code",
                detail: "logged in",
                modelRef: "claude-cli/claude-opus-5",
                recommended: false,
                credentials: true,
              },
            ],
          },
        },
      }),
    );

    expect(container.querySelector('[data-candidate-kind="existing-model"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="provider-auto:openai"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="claude-cli"]')).not.toBeNull();
    expect(text(container)).toContain("Selected model OpenAI gpt-5");
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-candidate-kind="saved-auth:openai:replacement"] button',
    );
    expect(retry).not.toBeNull();
    expect(retry!.disabled).toBe(false);
    retry!.click();
    expect(onActivateCandidate).toHaveBeenCalledExactlyOnceWith(savedCandidate);
  });

  it("renders connection verification progress", () => {
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        verify: { phase: "checking" },
        actionsDisabled: true,
      }),
    );
    expect(text(container)).toContain("Checking — asking openai/gpt-5 for a quick reply…");
    expect(
      container.querySelector<HTMLButtonElement>(".model-setup__current button")?.disabled,
    ).toBe(true);
  });

  it("renders successful connection verification with the answering model", () => {
    const container = mount(
      props({
        page: { phase: "ready", result: { ...detected, configuredModel: "openai/gpt-5" } },
        verify: { phase: "ok", modelRef: "anthropic/claude-opus-4-8", latencyMs: 1234 },
      }),
    );
    expect(text(container)).toContain("Ready · 1234 ms");
    const current = container.querySelector(".model-setup__current");
    expect(current?.textContent).toContain("Anthropic");
    expect(current?.textContent).toContain("claude-opus-4-8");
    expect(current?.textContent).not.toContain("openai/gpt-5");
    expect(current?.querySelector('[data-provider-icon="claude"]')).not.toBeNull();
  });

  it("shows the current model without verification controls for non-admin and unsupported gateways", () => {
    const result = { ...detected, configuredModel: "openai/gpt-5" };
    const nonAdmin = mount(
      props({ page: { phase: "ready", result }, canAdmin: false, canVerify: false }),
    );
    expect(text(nonAdmin)).toContain("Selected model OpenAI gpt-5");
    expect(nonAdmin.querySelector(".model-setup__current button")).toBeNull();

    const unsupportedGateway = mount(props({ page: { phase: "ready", result }, canVerify: false }));
    expect(text(unsupportedGateway)).toContain("Selected model OpenAI gpt-5");
    expect(unsupportedGateway.querySelector(".model-setup__current button")).toBeNull();
  });

  it.each([true, false])("reports device-code fallback success: %s", async (copied) => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    vi.stubGlobal("navigator", copied ? {} : { clipboard: { writeText } });
    const execCommand = vi.fn().mockImplementation(() => {
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("ABCD-EFGH");
      return copied;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = wizardStep({
      id: "device",
      type: "note",
      ...(copied
        ? {
            title: "Authorize device",
            message: "Use this code",
            externalUrl: "https://example.com/device",
          }
        : {}),
      deviceCode: { code: "ABCD-EFGH", ...(copied ? { expiresInMinutes: 10 } : {}) },
    });

    if (copied) {
      const link = container.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/device"]',
      );
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noreferrer");
      expect(text(container)).toContain("ABCD-EFGH");
      expect(text(container)).toContain("Expires in 10 minutes");
    }
    const copy = container.querySelector<HTMLButtonElement>(".wizard-step__sign-in button");
    copy?.click();

    const feedback = copied ? "Copied!" : "Copy failed";
    await vi.waitFor(() => expect(copy?.textContent?.trim()).toBe(feedback));
    expect(copy?.getAttribute("aria-label")).toBeNull();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).toHaveBeenCalledTimes(copied ? 0 : 1);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it.each([
    { sensitive: false, expectedType: "text" },
    { sensitive: true, expectedType: "password" },
  ])(
    "labels a $expectedType input and associates validation errors until recovery",
    ({ sensitive, expectedType }) => {
      const container = document.body.appendChild(document.createElement("div"));
      const renderStep = (validationError: string | null) =>
        render(
          renderModelSetup(
            props({
              wizard: {
                phase: "step",
                authChoice: "provider-auth",
                step: {
                  id: "access-value",
                  type: "text",
                  message: "Provider access value",
                  sensitive,
                  placeholder: "Enter value",
                },
                busy: false,
                validationError,
              },
              wizardValue: "initial value",
            }),
          ),
          container,
        );
      renderStep(null);
      const input = container.querySelector<HTMLInputElement>("#model-setup-wizard-text-input");
      const label = container.querySelector<HTMLLabelElement>(
        'label[for="model-setup-wizard-text-input"]',
      );
      expect(label?.textContent).toBe("Provider access value");
      expect(input?.type).toBe(expectedType);
      expect(input?.labels).toContain(label);
      renderStep("That access value is not valid.");
      const errorId = input?.getAttribute("aria-describedby");
      expect(input?.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(errorId ?? "")?.textContent).toContain(
        "That access value is not valid.",
      );
      renderStep(null);
      expect(input?.hasAttribute("aria-invalid")).toBe(false);
      expect(input?.hasAttribute("aria-describedby")).toBe(false);
    },
  );

  it.each([{ canAdmin: false }, { gatewayTooOld: true }])(
    "keeps activation feedback behind setup access: %j",
    (access) => {
      const container = mount(
        props({
          ...access,
          activation: {
            phase: "failure",
            targetId: "manual:openai",
            status: "auth",
            error: "Credential rejected",
          },
        }),
      );
      expect(container.querySelector(".settings-section")).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(text(container)).not.toContain("Credential rejected");
    },
  );

  it.each([
    { entry: "discovered", targetId: activationTargetId("codex-cli", "openai/gpt-5") },
    { entry: "manual", targetId: "manual:openai" },
  ])(
    "keeps one activation status and failure visible for $entry targets",
    ({ entry, targetId }) => {
      const viewProps = props({
        activation: { phase: "testing", targetId },
        actionsDisabled: true,
        manualApiKey: "test-only-secret",
      });
      const container = mount(viewProps);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(text(container.querySelector('[role="status"]')!)).toContain("Testing");
      expect(text(container)).not.toContain("test-only-secret");
      const button = container.querySelector<HTMLButtonElement>(
        entry === "discovered"
          ? '[data-candidate-kind="codex-cli"] button'
          : ".model-setup__manual .btn.primary",
      )!;
      expect(button.disabled).toBe(true);
      expect(text(button)).toBe("Testing…");

      viewProps.activation = {
        phase: "failure",
        targetId,
        status: "timeout",
        error: "No reply received",
      };
      viewProps.actionsDisabled = false;
      render(renderModelSetup(viewProps), container);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(text(container.querySelector('[role="alert"]')!)).toContain("No reply received");
      expect(text(container.querySelector('[role="alert"]')!)).toContain(
        "Warm it or choose a faster model, then retry.",
      );
      expect(button.disabled).toBe(false);
      if (entry === "discovered") {
        expect(text(button)).toBe("Retry test");
        button.click();
        expect(viewProps.onActivateCandidate).toHaveBeenCalledWith(detected.candidates[0]);
      } else {
        expect(text(button)).toBe("Connect & verify");
        button.click();
        expect(viewProps.onManualConnect).toHaveBeenCalledOnce();
      }

      viewProps.page = { phase: "ready", result: { ...detected, candidates: [] } };
      viewProps.manualProviderId = "gemini-api-key";
      render(renderModelSetup(viewProps), container);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(text(container.querySelector('[role="alert"]')!)).toContain("No reply received");
      viewProps.page = { phase: "loading" };
      render(renderModelSetup(viewProps), container);
      expect(text(container.querySelector('[role="alert"]')!)).toContain("No reply received");
      viewProps.page = { phase: "ready", result: { ...detected, candidates: [] } };
      viewProps.activation = { phase: "testing", targetId };
      render(renderModelSetup(viewProps), container);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    },
  );

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

  it("keeps durable continuation without duplicating a fresh success action", () => {
    const onOpenChat = vi.fn();
    const container = mount({ ...firstRunProps(), onOpenChat });

    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue setup",
    );
    expect(continueButton).toBeDefined();
    continueButton?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();

    const freshSuccess = mount({
      ...firstRunProps(),
      activation: { phase: "success", modelRef: "openai/gpt-5" },
    });
    expect(
      [...freshSuccess.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Continue setup",
      ),
    ).toHaveLength(1);
    expect(freshSuccess.textContent).not.toContain("Open Chat");
  });
});
