import { afterEach, beforeEach, vi } from "vitest";
import type { ChannelsPairingListResult, WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
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
  afterEach(() => {
    disposeChannelViews();
    document.body.replaceChildren();
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
    whatsappQrDataUrl: null as string | null,
    whatsappMessage: null as string | null,
    whatsappConnected: null as boolean | null,
    whatsappBusy: false,
    whatsappStatus: undefined as Record<string, unknown> | undefined,
    whatsappConfig: undefined as Record<string, unknown> | undefined,
    pairing: null as ChannelsPairingListResult | null,
    onWhatsAppStart: vi.fn(),
    onWhatsAppWait: vi.fn(),
    onWhatsAppAllow: vi.fn(async () => true),
    onOpenWhatsAppChat: vi.fn(),
    onRefresh: vi.fn(),
    onPairingRefresh: vi.fn(),
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
        channels: props.whatsappStatus ? { whatsapp: props.whatsappStatus } : {},
        channelAccounts: {},
        channelDefaultAccountId: {},
      },
      props.pairing,
      {
        ...(props.whatsappConfig
          ? {
              config: { configSnapshot: sourceConfigSnapshot(props.whatsappConfig) },
            }
          : {}),
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
          allowWhatsApp: props.onWhatsAppAllow,
          openWhatsAppChat: props.onOpenWhatsAppChat,
        },
        onWhatsAppStart: props.onWhatsAppStart,
        onWhatsAppWait: props.onWhatsAppWait,
        onRefresh: props.onRefresh,
        onPairingRefresh: props.onPairingRefresh,
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
