import { afterEach, beforeEach, vi } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { disposeChannelViews, renderChannelView } from "./view.test-support.ts";
import type { ChannelWizardState } from "./wizard-runner.ts";
import { ChannelWizard } from "./wizard-view.tsx";

type WizardProps = Parameters<typeof ChannelWizard>[0];

export function setupWizardTests() {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(async () => {
    await i18n.setLocale("en");
    disposeChannelViews();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

export function wizardStep(
  step: WizardStep,
  overrides: Partial<Extract<ChannelWizardState, { phase: "step" }>> = {},
): Extract<ChannelWizardState, { phase: "step" }> {
  return { phase: "step", channel: null, step, busy: true, validationError: null, ...overrides };
}

export function renderWizard(wizard: ChannelWizardState, overrides: Partial<WizardProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = {
    wizard,
    channelLabel: (channelId: string) => channelId,
    multiselectValues: [],
    onToggleMultiselect: vi.fn(),
    textValue: "",
    secretVisible: false,
    onTextInput: vi.fn(),
    onToggleSecretVisibility: vi.fn(),
    onAnswer: vi.fn(),
    onClose: vi.fn(),
    whatsappQrDataUrl: null,
    whatsappMessage: null,
    whatsappConnected: null,
    whatsappBusy: false,
    onWhatsAppStart: vi.fn(),
    onWhatsAppWait: vi.fn(),
    ...overrides,
  };
  const update = (patch: Partial<WizardProps> = {}) => {
    Object.assign(props, patch);
    renderChannelView(ChannelWizard, props, container);
  };
  update();
  return { container, ...props, update };
}

export const wizardInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#channel-wizard-text-input");
