import { afterEach, beforeEach, vi } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import {
  channelSnapshot,
  createChannelsViewProps,
  disposeChannelViews,
  renderChannelView,
} from "./view.test-support.ts";
import { ChannelsView } from "./view.tsx";
import type { ChannelWizardState } from "./wizard-runner.ts";

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
export function renderWizard(initial: ChannelWizardState, whatsappBusy = false) {
  let wizard = initial;
  const actions = {
    answer: vi.fn(),
    close: vi.fn(),
    setTextValue: vi.fn(),
    toggleMultiselect: vi.fn(),
    toggleSecretVisibility: vi.fn(),
  };
  const props = createChannelsViewProps(channelSnapshot(), null, {
    channels: { whatsappBusy },
    wizardHost: { ...actions, state: () => wizard },
  });
  const root = document.body.appendChild(document.createElement("div"));
  const update = (next = wizard, draft: Partial<typeof props.wizardHost.draft> = {}) => {
    wizard = next;
    Object.assign(props.wizardHost.draft, draft);
    renderChannelView(
      ChannelsView,
      {
        ...props,
        wizardHost: { ...props.wizardHost, draft: { ...props.wizardHost.draft } },
      },
      root,
    );
  };
  update();
  return { actions, update, container: root.querySelector<HTMLElement>(".channels-wizard")! };
}
export const wizardInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#channel-wizard-text-input");
