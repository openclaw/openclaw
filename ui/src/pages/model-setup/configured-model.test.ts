/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ConfiguredModel } from "./configured-model.tsx";
import type { ModelSetupVerifyState } from "./state.ts";

const disposals: (() => void)[] = [];

function mount(
  result: SystemAgentSetupDetectResult,
  verify: ModelSetupVerifyState = {
    phase: "failed",
    status: "unavailable",
    error: "connect ECONNREFUSED",
  },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const onVerify = vi.fn();
  const [currentVerify, setVerify] = createSignal(verify);
  disposals.push(
    mountSolid(
      () =>
        ConfiguredModel({
          result,
          get verify() {
            return currentVerify();
          },
          canVerify: true,
          actionsDisabled: false,
          onVerify,
        }),
      { container },
    ).unmount,
  );
  return { container, onVerify, setVerify };
}

function text(container: Element): string {
  return container.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

describe("ConfiguredModel", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const dispose of disposals.splice(0)) {
      dispose();
    }
    document.body.replaceChildren();
  });

  it.each([
    {
      brandId: "ollama",
      detail: "qwen3:8b at http://127.0.0.1:11434",
      kind: "provider-auto:ollama",
      label: "Ollama",
      modelRef: "ollama/qwen3:8b",
    },
    {
      brandId: "llama-cpp",
      detail: "Ready locally",
      kind: "provider-auto:llama-cpp",
      label: "llama.cpp",
      modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
    },
  ] as const)("shows a quiet recovery state for $brandId", (fixture) => {
    const result: SystemAgentSetupDetectResult = {
      candidates: [
        {
          kind: fixture.kind,
          brandId: fixture.brandId,
          label: fixture.label,
          detail: fixture.detail,
          modelRef: fixture.modelRef,
          recommended: false,
          credentials: true,
        },
      ],
      manualProviders: [],
      prepareOptions: [],
      workspace: "/tmp/workspace",
      configuredModel: fixture.modelRef,
      setupComplete: true,
    };
    const { container, onVerify } = mount(result);

    expect(container.querySelector(".settings-section__header h2")?.textContent).toBe(
      "Selected model",
    );
    expect(container.querySelector(".model-setup__current-copy strong")?.textContent).toBe(
      fixture.label,
    );
    expect(text(container)).toContain(fixture.detail);
    expect(text(container)).toContain("connect ECONNREFUSED");
    expect(text(container)).not.toContain("isn’t responding");
    expect(text(container)).not.toContain("Change connection");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent?.trim()).toBe("Try again");

    button?.click();
    expect(onVerify).toHaveBeenCalledOnce();
  });

  it("explains a setup timeout without claiming the provider is unreachable", () => {
    const result: SystemAgentSetupDetectResult = {
      candidates: [],
      manualProviders: [],
      prepareOptions: [],
      workspace: "/tmp/workspace",
      configuredModel: "ollama/gemma4:latest",
      setupComplete: true,
    };
    const { container } = mount(result, {
      phase: "failed",
      status: "timeout",
      error: "LLM request timed out.",
    });

    expect(text(container)).toContain("Timed out. LLM request timed out.");
    expect(text(container)).toContain(
      "The model did not finish the setup test in time. Warm it or choose a faster model, then retry.",
    );
    expect(text(container)).not.toContain("isn’t responding");
    expect(text(container)).not.toContain("service is running and reachable");
  });

  it("updates the provider and model to the successful verification result", () => {
    const { container, setVerify } = mount(
      {
        candidates: [],
        manualProviders: [],
        prepareOptions: [],
        workspace: "/tmp/workspace",
        configuredModel: "ollama/initial-model",
        setupComplete: true,
      },
      { phase: "checking" },
    );
    expect(text(container)).toContain("ollama/initial-model");
    expect(container.querySelector('[data-provider-icon="ollama"]')).not.toBeNull();

    setVerify({ phase: "ok", modelRef: "openai/verified-model", latencyMs: 12 });
    flush();

    expect(
      container.querySelector(".model-setup__current")?.getAttribute("data-verify-phase"),
    ).toBe("ok");
    expect(text(container)).toContain("OpenAI");
    expect(text(container)).toContain("verified-model");
    expect(text(container)).not.toContain("initial-model");
    expect(container.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(container.querySelector("button")?.textContent?.trim()).toBe("Check again");
  });
});
