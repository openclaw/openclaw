import { createSignal, flush } from "solid-js";
import { vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { ModelSetupViewProps as ViewProps } from "../view-types.ts";
import { ModelSetupView } from "../view.tsx";

const provider = (id: string, label: string) => ({ id, brandId: id, label });

const ollama = {
  ...provider("ollama", "Ollama"),
  icon: "https://cdn.simpleicons.org/ollama",
  website: "https://ollama.com/download",
};

export const detected: SystemAgentSetupDetectResult = {
  candidates: [
    {
      kind: "codex-cli",
      brandId: "openai",
      label: "Codex CLI",
      detail: "Signed in locally",
      modelRef: "openai/gpt-5",
      recommended: true,
      credentials: true,
    },
  ],
  manualProviders: [
    {
      ...provider("gemini-api-key", "Google AI Studio API key"),
      brandId: "google",
      groupLabel: "Google",
      hint: "Supported API-key access from aistudio.google.com/apikey",
    },
    provider("openai", "OpenAI"),
  ],
  authOptions: [
    { id: "openai-oauth", label: "OpenAI", kind: "oauth", featured: true },
    { id: "other-device", label: "Other provider", kind: "device-code", featured: false },
  ],
  prepareOptions: (
    [
      ["ollama", "Ollama", "Choose connection"],
      ["lmstudio", "LM Studio", "Connect server"],
      ["llama-cpp", "llama.cpp", "Set up model"],
    ] as const
  ).map(([id, label, actionLabel]) =>
    Object.assign(provider(id, label), { actionLabel, hint: "Local model" }),
  ),
  recommendedInstalls: [{ ...ollama, hint: "Run open models locally" }],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

export function props(overrides: Partial<ViewProps> = {}): ViewProps {
  return {
    detectionIdentity: () => undefined,
    page: { phase: "ready", result: detected },
    activation: { phase: "idle" },
    verify: { phase: "idle" },
    wizard: { phase: "idle" },
    wizardMode: "auth",
    wizardValue: undefined,
    canAdmin: true,
    canVerify: true,
    canPrepare: true,
    gatewayTooOld: false,
    refreshWarning: null,
    actionsDisabled: false,
    manualProviderId: "openai",
    manualApiKey: "",
    manualError: null,
    moreSignInOpen: false,
    firstRun: false,
    iconUrls: {},
    onDetect: vi.fn(),
    onVerify: vi.fn(),
    onActivateCandidate: vi.fn(),
    onStartAuth: vi.fn(),
    onStartPrepare: vi.fn(),
    onManualProviderChange: vi.fn(),
    onManualApiKeyChange: vi.fn(),
    onManualConnect: vi.fn(),
    onMoreSignInToggle: vi.fn(),
    onIconError: vi.fn(),
    onOpenChat: vi.fn(),
    onSuccessClose: vi.fn(),
    onWizardValueChange: vi.fn(),
    onWizardAnswer: vi.fn(),
    onWizardCancel: vi.fn(),
    onWizardClose: vi.fn(),
    ...overrides,
  };
}

const roots = new Map<HTMLElement, { update: (view: ViewProps) => void; dispose: () => void }>();

export function renderSetup(view: ViewProps, container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    root.update({ ...view });
  } else {
    const [current, setCurrent] = createSignal({ ...view });
    const { unmount: dispose } = mountSolid(() => <ModelSetupView {...current()} />, { container });
    roots.set(container, { update: setCurrent, dispose });
  }
  flush();
}

export function disposeViews(): void {
  for (const root of roots.values()) {
    root.dispose();
  }
  roots.clear();
}

export function mount(viewProps: ViewProps): HTMLDivElement {
  const container = document.body.appendChild(document.createElement("div"));
  renderSetup(viewProps, container);
  return container;
}

export function text(container: Element): string {
  return container.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}
