/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { activationTargetId } from "./state.ts";
import {
  detected,
  mount,
  props,
  text,
  renderSetup,
  disposeViews,
  type ModelSetupViewProps,
} from "./test-helpers/view.test-support.tsx";

function readyProps(
  result: Partial<SystemAgentSetupDetectResult>,
  overrides: Partial<ModelSetupViewProps> = {},
) {
  return props({ ...overrides, page: { phase: "ready", result: { ...detected, ...result } } });
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string) {
  return root.querySelector<E>(selector)!;
}

const actionButton = (root: ParentNode, selector: string) =>
  query<HTMLButtonElement>(root, selector);

function setup(
  overrides: Partial<ModelSetupViewProps> = {},
  result?: Partial<SystemAgentSetupDetectResult>,
) {
  const view = result ? readyProps(result, overrides) : props(overrides);
  const container = mount(view);
  return {
    view,
    container,
    get: <E extends Element = HTMLElement>(selector: string) => query<E>(container, selector),
    all: <E extends Element = HTMLElement>(selector: string) => [
      ...container.querySelectorAll<E>(selector),
    ],
    update: (changes: Partial<ModelSetupViewProps>) => {
      Object.assign(view, changes);
      renderSetup(view, container);
    },
  };
}

const candidate = (changes: Partial<SystemAgentSetupDetectResult["candidates"][number]>) => ({
  ...detected.candidates[0]!,
  ...changes,
});

function wizardProps(step: WizardStep) {
  return props({
    wizard: {
      phase: "step",
      authChoice: "provider-auth",
      step,
      busy: false,
      validationError: null,
    },
    wizardValue: step.initialValue,
  });
}

describe("renderModelSetup", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    disposeViews();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("shows detected authentication without credential values", () => {
    const detail = "logged in · ChatGPT account · alex@example.com";
    const secret = "synthetic-private-token";
    const container = mount(
      readyProps({
        candidates: [{ ...detected.candidates[0]!, detail: `${detail} · token=${secret}` }],
      }),
    );
    const row = container.querySelector('[data-candidate-kind="codex-cli"]')!;

    expect(text(row)).toContain(detail);
    expect(text(row)).not.toContain(secret);
  });

  it("derives prepare rows from accepted choice ids and hides usable local candidates", () => {
    const onStartPrepare = vi.fn();
    const container = mount(props({ onStartPrepare }));

    const ollama = actionButton(container, '[data-prepare-choice="ollama"] button');
    expect(ollama.textContent).toContain("Choose connection");
    const llamaCppRow = container.querySelector('[data-prepare-choice="llama-cpp"]');
    expect(llamaCppRow?.querySelector('[data-provider-icon="llamacpp"]')).not.toBeNull();
    ollama?.click();
    expect(onStartPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: "ollama" }));

    const withUsableOllama = mount(
      readyProps({
        candidates: [
          ...detected.candidates,
          candidate({
            kind: "provider-auto:ollama",
            modelRef: "ollama/qwen3:8b",
          }),
        ],
      }),
    );
    expect(withUsableOllama.querySelector('[data-prepare-choice="ollama"]')).toBeNull();
    const withSignIn = mount(readyProps({ candidates: [] }));
    expect(withSignIn.querySelector(".model-setup__empty")).toBeNull();
  });

  it.each([
    ["candidates", 0, '[data-candidate-kind="codex-cli"]'],
    ["authOptions", 0, '[data-auth-choice="openai-oauth"]'],
    ["authOptions", 1, '[data-auth-choice="other-device"]'],
    ["prepareOptions", 0, '[data-prepare-choice="ollama"]'],
    ["recommendedInstalls", 0, '[data-recommended-install="ollama"]'],
  ] as const)(
    "retains %s[%s] control and reads its new rescan data",
    (collection, index, selector) => {
      const result = structuredClone(detected);
      if (collection === "candidates") {
        result.candidates.push(candidate({ label: "Utility choice", modelTarget: "utility" }));
      } else if (collection === "recommendedInstalls") {
        result.candidates = [];
        result.authOptions = [];
      }
      const onChoose = vi.fn();
      const { all, update } = setup(
        {
          moreSignInOpen: true,
          onActivateCandidate: onChoose,
          onStartAuth: onChoose,
          onStartPrepare: onChoose,
        },
        result,
      );
      const rows = all(selector);
      const control = rows[0]!.querySelector<HTMLButtonElement | HTMLAnchorElement>("button, a")!;
      if (control instanceof HTMLAnchorElement) {
        expect(control).toMatchObject({
          href: "https://ollama.com/download",
          target: "_blank",
          rel: "noopener",
        });
        expect(rows[0]!.querySelector("img")).toBeNull();
      }
      control.focus();
      const rescanned = structuredClone(result);
      const updated = rescanned[collection]![index]!;
      updated.label = "Updated choice";
      if (collection === "recommendedInstalls") {
        rescanned.recommendedInstalls![0]!.website = "https://example.com/install";
      }
      update({ page: { phase: "ready", result: rescanned } });

      const refreshedRows = all(selector);
      expect(refreshedRows).toHaveLength(collection === "candidates" ? 2 : 1);
      rows.forEach((row, rowIndex) => expect(refreshedRows[rowIndex]).toBe(row));
      expect(refreshedRows[0]!.querySelector("button, a")).toBe(control);
      expect(text(refreshedRows[0]!)).toContain("Updated choice");
      expect(document.activeElement).toBe(control);
      if (control instanceof HTMLAnchorElement) {
        expect(control.href).toBe("https://example.com/install");
      } else {
        control.click();
        expect(onChoose).toHaveBeenCalledExactlyOnceWith(updated);
      }
    },
  );

  it.each(["claude", undefined])(
    "uses declared brand %s or proxied artwork, never remote URLs",
    (brandId) => {
      const iconUrl = "https://cdn.example.com/acme.png";
      const { view, get, container } = setup(
        { manualProviderId: "custom-login", iconUrls: { [iconUrl]: "blob:acme" } },
        {
          manualProviders: [
            { id: "custom-login", label: "Company account", icon: iconUrl, brandId },
          ],
        },
      );
      if (brandId) {
        expect(get('.model-setup__manual [data-provider-icon="claude"]')).not.toBeNull();
        expect(container.querySelector(".model-setup__manual img")).toBeNull();
      } else {
        const image = get<HTMLImageElement>(".model-setup__manual img");
        expect(image).toMatchObject({ src: "blob:acme", alt: "Company account" });
        image.dispatchEvent(new Event("error"));
        expect(view.onIconError).toHaveBeenCalledWith(iconUrl);
      }
      expect(container.innerHTML).not.toContain(iconUrl);
    },
  );

  it("keeps saved replacement credentials selectable without repeating the current route", () => {
    const savedCandidate = candidate({
      kind: "saved-auth:openai:replacement",
      label: "Saved OpenAI credentials",
    });
    const { view, container } = setup(
      {},
      {
        configuredModel: savedCandidate.modelRef,
        setupComplete: true,
        candidates: [
          { ...savedCandidate, kind: "existing-model" },
          { ...savedCandidate, kind: "provider-auto:openai", label: "OpenAI" },
          savedCandidate,
          {
            ...savedCandidate,
            kind: "claude-cli",
            brandId: "claude",
            modelRef: "claude-cli/claude-opus-5",
          },
        ],
      },
    );

    expect(container.querySelector('[data-candidate-kind="existing-model"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="provider-auto:openai"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="claude-cli"]')).not.toBeNull();
    const retry = actionButton(
      container,
      '[data-candidate-kind="saved-auth:openai:replacement"] button',
    );
    expect(retry.disabled).toBe(false);
    retry.click();
    expect(view.onActivateCandidate).toHaveBeenCalledExactlyOnceWith(savedCandidate);
  });

  it("disables verification while checking", () => {
    const view = readyProps(
      { configuredModel: "openai/gpt-5" },
      { verify: { phase: "checking" }, actionsDisabled: true },
    );
    const container = mount(view);
    expect(text(container)).toContain("Checking — asking openai/gpt-5 for a quick reply…");
    expect(actionButton(container, ".model-setup__current button").disabled).toBe(true);
    view.verify = { phase: "ok", modelRef: "openai/verified-model", latencyMs: 1234 };
    renderSetup(view, container);
    expect(text(container)).toContain("Ready · 1234 ms");
  });

  it("shows the current model without verification controls for non-admin and unsupported gateways", () => {
    for (const canAdmin of [false, true]) {
      const { get } = setup({ canAdmin, canVerify: false }, { configuredModel: "openai/gpt-5" });
      const current = get(".model-setup__current");
      expect(current.querySelector("strong")?.textContent).toBe("OpenAI");
      expect(current.querySelector("button")).toBeNull();
    }
  });

  it("copies the displayed device code and reports a failed fallback", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new DOMException("Clipboard access denied")),
      },
    });
    const execCommand = vi.fn(() => {
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("ABCD-EFGH");
      return false;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = mount(
      wizardProps({
        id: "device",
        type: "note",
        deviceCode: { code: "ABCD-EFGH" },
      }),
    );
    const copy = container.querySelector<HTMLButtonElement>(".wizard-sign-in__code button");
    copy?.click();
    await vi.waitFor(() => expect(copy?.textContent?.trim()).toBe("Copy failed"));
    expect(copy?.getAttribute("aria-label")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });

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
    [
      activationTargetId("codex-cli", "openai/gpt-5"),
      '[data-candidate-kind="codex-cli"] button',
      "Retry test",
    ],
    ["manual:openai", ".model-setup__manual .btn.primary", "Connect & verify"],
  ])("keeps one activation status and failure visible for %s", (targetId, selector, retryLabel) => {
    const { view, get, all, container, update } = setup({
      activation: { phase: "testing", targetId },
      actionsDisabled: true,
      manualApiKey: "test-only-secret",
    });
    const feedback = (status: number, alert: number) => {
      expect(all('[role="status"]')).toHaveLength(status);
      expect(all('[role="alert"]')).toHaveLength(alert);
    };
    feedback(1, 0);
    expect(text(container)).not.toContain("test-only-secret");
    const action = get<HTMLButtonElement>(selector);
    expect(action).toMatchObject({ disabled: true, textContent: "Testing…" });
    update({
      activation: { phase: "failure", targetId, status: "timeout", error: "No reply received" },
      actionsDisabled: false,
    });
    feedback(0, 1);
    expect(text(get('[role="alert"]'))).toContain("No reply received");
    expect(action).toMatchObject({ disabled: false, textContent: retryLabel });
    action.click();
    if (targetId === "manual:openai") {
      expect(view.onManualConnect).toHaveBeenCalledOnce();
    } else {
      expect(view.onActivateCandidate).toHaveBeenCalledWith(detected.candidates[0]);
    }
    const emptyPage = { phase: "ready" as const, result: { ...detected, candidates: [] } };
    for (const page of [emptyPage, { phase: "loading" as const }]) {
      update({ page, manualProviderId: "gemini-api-key" });
      expect(text(get('[role="alert"]'))).toContain("No reply received");
    }
    update({ page: emptyPage, activation: { phase: "testing", targetId } });
    feedback(1, 0);
  });

  it.each([false, true])(
    "filters credential choices while retaining setup-only methods: %s",
    (setupOnly) => {
      const setupOptions = (["install", "custom"] as const).map((kind) => ({
        id: kind,
        label: kind,
        kind,
        featured: false,
      }));
      const { view, container, get } = setup(
        {
          embedded: true,
          agentLabel: "Writer",
          credentialChoices: ["openai-oauth", "other-device", "openai", "gemini-api-key"],
          manualProviderId: "special-token",
          manualApiKey: "synthetic-token",
        },
        {
          configuredModel: "openai/gpt-5.6-luna",
          authOptions: [...(detected.authOptions ?? []), ...setupOptions],
          manualProviders: setupOnly
            ? [{ id: "special-token", brandId: "openai", label: "Special account token" }]
            : detected.manualProviders,
        },
      );
      expect(container.querySelector(".content-header")).toBeNull();
      expect(container.querySelector(".model-setup__current")).toBeNull();
      expect(text(container)).toContain("for Writer");
      expect(text(container)).toContain("not the global defaults");
      expect(container.querySelector('[data-auth-choice="openai-oauth"]')).toBeNull();
      expect(container.querySelector('[data-prepare-choice="ollama"]')).not.toBeNull();
      for (const option of setupOptions) {
        get<HTMLButtonElement>(`[data-auth-choice="${option.id}"] button`).click();
        expect(view.onStartAuth).toHaveBeenLastCalledWith(option);
      }
      if (setupOnly) {
        expect(container.querySelector('[data-manual-provider="special-token"]')).not.toBeNull();
        get<HTMLButtonElement>(".model-setup__manual button.primary").click();
        expect(view.onManualConnect).toHaveBeenCalledOnce();
      } else {
        expect(container.querySelector(".model-setup__manual")).toBeNull();
      }
    },
  );

  it("notifies the discovery owner only when its own modal is shown", () => {
    const onDiscoveryShown = vi.fn();
    const container = mount(props({ embedded: true, onDiscoveryShown }));
    const modal = container.querySelector("openclaw-modal-dialog")!;
    const content = modal.querySelector(".model-setup-discovery")!;

    content.dispatchEvent(new CustomEvent("overlay-after-show", { bubbles: true }));
    expect(onDiscoveryShown).not.toHaveBeenCalled();
    modal.dispatchEvent(new CustomEvent("overlay-after-show", { bubbles: true }));
    expect(onDiscoveryShown).toHaveBeenCalledOnce();
  });

  it.each(["wizard", "primary", "utility"] as const)(
    "leaves the %s dialog in control of its action",
    (mode) => {
      const { view, container, get, all } = setup({
        embedded: true,
        onClose: vi.fn(),
        onOpenSetupAssistant: vi.fn(),
        wizard:
          mode === "wizard"
            ? wizardProps({ id: "choice", type: "confirm", message: "Prepare local model?" }).wizard
            : { phase: "idle" },
        activation:
          mode === "wizard"
            ? { phase: "idle" }
            : {
                phase: "success",
                modelRef: mode === "utility" ? "local/setup" : "openai/gpt-5.6-luna",
                ...(mode === "utility" ? { modelTarget: "utility" } : {}),
              },
      });
      const dialogs = all("openclaw-modal-dialog");
      expect(dialogs).toHaveLength(1);
      if (mode === "wizard") {
        expect(container.querySelector(".model-setup__intro")).toBeNull();
        dialogs[0]!.dispatchEvent(
          new CustomEvent("modal-cancel", { bubbles: true, cancelable: true }),
        );
        expect(view.onWizardCancel).toHaveBeenCalledOnce();
        expect(view.onClose).not.toHaveBeenCalled();
      } else {
        const success = get(".model-setup-success");
        const done = success.querySelector<HTMLButtonElement>("button.primary")!;
        if (mode === "utility") {
          expect(text(success)).toContain("Setup & utility model ready");
          expect(text(success)).not.toContain("Active model");
          expect(text(success)).not.toContain("Return to Models");
          done.click();
          expect(view.onOpenSetupAssistant).toHaveBeenCalledOnce();
          expect(view.onOpenChat).not.toHaveBeenCalled();
        } else {
          expect(done.textContent).toContain("Return to Models");
          done.click();
          expect(view.onOpenChat).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("keeps utility actions distinct from agent primary selection during rescans", () => {
    const utility = candidate({
      kind: "provider-auto:local",
      label: "Local utility",
      modelRef: "local/setup",
      modelTarget: "utility",
    });
    const { view, get, all, update } = setup(
      { embedded: true },
      {
        configuredModel: "cloud/primary",
        candidates: [...detected.candidates, utility],
      },
    );
    const utilityButton = get<HTMLButtonElement>(
      '[data-candidate-kind="provider-auto:local"] button',
    );
    expect(utilityButton.textContent).toContain("Use as utility");
    expect(get('[data-candidate-kind="codex-cli"] button').textContent).toContain(
      "Test & use for this agent",
    );
    utilityButton.click();
    expect(view.onActivateCandidate).toHaveBeenCalledExactlyOnceWith(utility);
    update({ detecting: true });
    const buttons = all("[data-candidate-kind] button");
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => expect(button).toHaveProperty("disabled", true));
  });

  it("keeps durable continuation without duplicating a fresh success action", () => {
    const { view, container, all, update } = setup(
      { firstRun: true, manualProviderId: "", iconUrls: {} },
      {
        candidates: [],
        manualProviders: [],
        authOptions: [],
        prepareOptions: [],
        recommendedInstalls: [],
        configuredModel: "openai/gpt-5",
        setupComplete: true,
      },
    );
    const continueButtons = () =>
      all<HTMLButtonElement>("button").filter((button) => text(button) === "Continue setup");
    expect(continueButtons()).toHaveLength(1);
    continueButtons()[0]!.click();
    expect(view.onOpenChat).toHaveBeenCalledOnce();
    update({ activation: { phase: "success", modelRef: "openai/gpt-5" } });
    expect(continueButtons()).toHaveLength(1);
    expect(container.textContent).not.toContain("Open Chat");
  });
});
