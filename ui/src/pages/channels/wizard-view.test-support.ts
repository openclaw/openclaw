import { afterEach, beforeEach, vi } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createChannelsViewProps,
  disposeChannelViews,
  renderChannelView,
} from "./view.test-support.ts";
import { ChannelsView } from "./view.tsx";
import type { ChannelWizardState } from "./wizard-runner.ts";

type WizardProps = ReturnType<typeof createWizardFixture>;

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

function createWizardFixture(wizard: ChannelWizardState) {
  const multiselectValues: unknown[] = [];
  return {
    wizard,
    channelLabel: (channelId: string) => channelId,
    multiselectValues,
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
  };
}

export function renderWizard(wizard: ChannelWizardState, overrides: Partial<WizardProps> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const props = { ...createWizardFixture(wizard), ...overrides };
  const update = (patch: Partial<WizardProps> = {}) => {
    Object.assign(props, patch);
    const channel = props.wizard.phase === "idle" ? null : props.wizard.channel;
    const view = createChannelsViewProps(
      {
        ts: 1,
        channelOrder: [],
        channelLabels: channel ? { [channel]: props.channelLabel(channel) } : {},
        channels: {},
        channelAccounts: {},
        channelDefaultAccountId: {},
      },
      null,
      {
        channels: {
          whatsappLoginQrDataUrl: props.whatsappQrDataUrl,
          whatsappLoginMessage: props.whatsappMessage,
          whatsappLoginConnected: props.whatsappConnected,
          whatsappBusy: props.whatsappBusy,
        },
        wizardHost: {
          state: () => props.wizard,
          draft: {
            multiselect: props.multiselectValues,
            textValue: props.textValue,
            secretVisible: props.secretVisible,
          },
          toggleMultiselect: props.onToggleMultiselect,
          setTextValue: props.onTextInput,
          toggleSecretVisibility: props.onToggleSecretVisibility,
          answer: props.onAnswer,
          close: props.onClose,
        },
        onWhatsAppStart: props.onWhatsAppStart,
        onWhatsAppWait: props.onWhatsAppWait,
      },
    );
    renderChannelView(ChannelsView, view, root);
  };
  update();
  const container = root.querySelector<HTMLElement>(".channels-wizard")!;
  return { container, ...props, update };
}

export const wizardInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#channel-wizard-text-input");
