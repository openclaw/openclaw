import type {
  ChannelsPairingListResult,
  ChannelsStatusSnapshot,
  ConfigUiHints,
} from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import type { ChannelsProps } from "./view.types.ts";
import type { ChannelWizardState } from "./wizard-controller.ts";

export type ChannelsViewTestProps = ChannelsProps & {
  connected: boolean;
  loading: boolean;
  snapshot: ChannelsStatusSnapshot | null;
  pluginCatalog: PluginListResult | null;
  pluginIconUrls: Readonly<Record<string, string>>;
  lastError: string | null;
  lastSuccessAt: number | null;
  pairingLoading: boolean;
  pairingSnapshot: ChannelsPairingListResult | null;
  pairingError: string | null;
  pairingLastSuccessAt: number | null;
  pairingBusyRequestId: string | null;
  whatsappMessage: string | null;
  whatsappQrDataUrl: string | null;
  whatsappConnected: boolean | null;
  whatsappBusy: boolean;
  configSchema: unknown;
  configSchemaLoading: boolean;
  configForm: Record<string, unknown> | null;
  configUiHints: ConfigUiHints;
  configSaving: boolean;
  configError: string | null;
  configFormDirty: boolean;
  wizard: ChannelWizardState;
  wizardMultiselect: readonly unknown[];
  wizardTextValue: string;
  wizardSecretVisible: boolean;
  setupBlockedByDirtyConfig: boolean;
};

export type ChannelsViewTestOverrides = Partial<ChannelsViewTestProps>;

export function createChannelsViewProps(
  snapshot: ChannelsStatusSnapshot | null,
  pairingSnapshot: ChannelsPairingListResult | null,
  overrides: ChannelsViewTestOverrides = {},
): ChannelsViewTestProps {
  const legacy = {
    connected: true,
    loading: false,
    snapshot,
    pluginCatalog: null,
    pluginIconUrls: {},
    lastError: null,
    lastSuccessAt: null,
    pairingLoading: false,
    pairingSnapshot,
    pairingError: null,
    pairingLastSuccessAt: null,
    pairingBusyRequestId: null,
    pairingChannelFilter: null,
    pairingAccountFilter: null,
    pairingPrompt: null,
    pairingNotice: null,
    canManagePairing: true,
    canAdmin: true,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: false,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configError: null,
    configFormDirty: false,
    showAdvancedSettings: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    selectedChannel: null,
    wizard: { phase: "idle" },
    wizardMultiselect: [],
    wizardTextValue: "",
    wizardSecretVisible: false,
    setupBlockedByDirtyConfig: false,
    onShowDetail: () => {},
    onCloseDetail: () => {},
    onStartSetup: () => {},
    onWizardAnswer: () => {},
    onWizardToggleMultiselect: () => {},
    onWizardTextInput: () => {},
    onWizardToggleSecretVisibility: () => {},
    onWizardClose: () => {},
    onRefresh: () => {},
    onPairingRefresh: () => {},
    onPairingFilterChange: () => {},
    onPairingReviewAccount: () => {},
    onPairingApprove: () => {},
    onPairingDismiss: () => {},
    onPairingPromptChange: () => {},
    onPairingPromptCancel: () => {},
    onPairingPromptConfirm: () => {},
    onWhatsAppStart: () => {},
    onWhatsAppWait: () => {},
    onWhatsAppLogout: () => {},
    onShowAdvancedSettings: () => {},
    onConfigPatch: () => {},
    onConfigSave: () => {},
    onConfigReload: () => {},
    onNostrProfileEdit: () => {},
    onNostrProfileCancel: () => {},
    onNostrProfileFieldChange: () => {},
    onNostrProfileSave: () => {},
    onNostrProfileImport: () => {},
    onNostrProfileToggleAdvanced: () => {},
    ...overrides,
  };
  const channels: ChannelsState = {
    client: null,
    connected: legacy.connected,
    channelsLoading: legacy.loading,
    channelsLoadingProbe: null,
    channelsRefreshSeq: 0,
    channelsSnapshot: legacy.snapshot,
    channelsError: legacy.lastError,
    channelsLastSuccess: legacy.lastSuccessAt,
    pairingLoading: legacy.pairingLoading,
    pairingRefreshSeq: 0,
    pairingSnapshot: legacy.pairingSnapshot,
    pairingError: legacy.pairingError,
    pairingLastSuccess: legacy.pairingLastSuccessAt,
    pairingBusyRequestId: legacy.pairingBusyRequestId,
    whatsappLoginMessage: legacy.whatsappMessage,
    whatsappLoginQrDataUrl: legacy.whatsappQrDataUrl,
    whatsappLoginSessionKey: null,
    whatsappLoginConnected: legacy.whatsappConnected,
    whatsappBusy: legacy.whatsappBusy,
    ...overrides.channels,
  };
  const config = {
    ...createInitialConfigState(),
    configSchema: legacy.configSchema,
    configSchemaLoading: legacy.configSchemaLoading,
    configForm: legacy.configForm,
    configUiHints: legacy.configUiHints,
    configSaving: legacy.configSaving,
    lastError: legacy.configError,
    configFormDirty: legacy.configFormDirty,
    ...overrides.config,
  };
  const presentation = Object.assign(
    {
      pluginCatalog: legacy.pluginCatalog,
      pluginIconUrls: legacy.pluginIconUrls,
    },
    overrides.presentation,
  ) as ChannelsProps["presentation"];
  const wizardHost = Object.assign(
    {
      state: legacy.wizard,
      multiselect: legacy.wizardMultiselect,
      textValue: legacy.wizardTextValue,
      secretVisible: legacy.wizardSecretVisible,
      blockedByDirtyConfig: legacy.setupBlockedByDirtyConfig,
      toggleMultiselect: legacy.onWizardToggleMultiselect,
      setTextValue: legacy.onWizardTextInput,
      toggleSecretVisibility: legacy.onWizardToggleSecretVisibility,
      answer: legacy.onWizardAnswer,
      close: legacy.onWizardClose,
    },
    overrides.wizardHost,
  ) as unknown as ChannelsProps["wizardHost"];
  const result = { ...legacy, channels, config, presentation, wizardHost } as ChannelsViewTestProps;
  const alias = (
    key: keyof ChannelsViewTestProps,
    read: () => unknown,
    write: (value: unknown) => void,
  ) =>
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      get: read,
      set: write,
    });
  alias(
    "connected",
    () => channels.connected,
    (value) => (channels.connected = Boolean(value)),
  );
  alias(
    "loading",
    () => channels.channelsLoading,
    (value) => (channels.channelsLoading = Boolean(value)),
  );
  alias(
    "snapshot",
    () => channels.channelsSnapshot,
    (value) => (channels.channelsSnapshot = value as ChannelsStatusSnapshot | null),
  );
  alias(
    "lastError",
    () => channels.channelsError,
    (value) => (channels.channelsError = value as string | null),
  );
  alias(
    "lastSuccessAt",
    () => channels.channelsLastSuccess,
    (value) => (channels.channelsLastSuccess = value as number | null),
  );
  alias(
    "pairingLoading",
    () => channels.pairingLoading,
    (value) => (channels.pairingLoading = Boolean(value)),
  );
  alias(
    "pairingSnapshot",
    () => channels.pairingSnapshot,
    (value) => (channels.pairingSnapshot = value as ChannelsPairingListResult | null),
  );
  alias(
    "pairingError",
    () => channels.pairingError,
    (value) => (channels.pairingError = value as string | null),
  );
  alias(
    "pairingLastSuccessAt",
    () => channels.pairingLastSuccess,
    (value) => (channels.pairingLastSuccess = value as number | null),
  );
  alias(
    "pairingBusyRequestId",
    () => channels.pairingBusyRequestId,
    (value) => (channels.pairingBusyRequestId = value as string | null),
  );
  alias(
    "whatsappMessage",
    () => channels.whatsappLoginMessage,
    (value) => (channels.whatsappLoginMessage = value as string | null),
  );
  alias(
    "whatsappQrDataUrl",
    () => channels.whatsappLoginQrDataUrl,
    (value) => (channels.whatsappLoginQrDataUrl = value as string | null),
  );
  alias(
    "whatsappConnected",
    () => channels.whatsappLoginConnected,
    (value) => (channels.whatsappLoginConnected = value as boolean | null),
  );
  alias(
    "whatsappBusy",
    () => channels.whatsappBusy,
    (value) => (channels.whatsappBusy = Boolean(value)),
  );
  alias(
    "configSchema",
    () => config.configSchema,
    (value) => (config.configSchema = value),
  );
  alias(
    "configSchemaLoading",
    () => config.configSchemaLoading,
    (value) => (config.configSchemaLoading = Boolean(value)),
  );
  alias(
    "configForm",
    () => config.configForm,
    (value) => (config.configForm = value as Record<string, unknown> | null),
  );
  alias(
    "configUiHints",
    () => config.configUiHints,
    (value) => (config.configUiHints = value as ConfigUiHints),
  );
  alias(
    "configSaving",
    () => config.configSaving,
    (value) => (config.configSaving = Boolean(value)),
  );
  alias(
    "configError",
    () => config.lastError,
    (value) => (config.lastError = value as string | null),
  );
  alias(
    "configFormDirty",
    () => config.configFormDirty,
    (value) => (config.configFormDirty = Boolean(value)),
  );
  alias(
    "pluginCatalog",
    () => presentation.pluginCatalog,
    (value) =>
      ((presentation as unknown as { pluginCatalog: PluginListResult | null }).pluginCatalog =
        value as PluginListResult | null),
  );
  alias(
    "pluginIconUrls",
    () => presentation.pluginIconUrls,
    (value) =>
      ((
        presentation as unknown as { pluginIconUrls: Readonly<Record<string, string>> }
      ).pluginIconUrls = value as Readonly<Record<string, string>>),
  );
  alias(
    "wizard",
    () => wizardHost.state,
    (value) =>
      ((wizardHost as unknown as { state: ChannelWizardState }).state =
        value as ChannelWizardState),
  );
  alias(
    "wizardMultiselect",
    () => wizardHost.multiselect,
    (value) => (wizardHost.multiselect = value as unknown[]),
  );
  alias(
    "wizardTextValue",
    () => wizardHost.textValue,
    (value) => (wizardHost.textValue = String(value)),
  );
  alias(
    "wizardSecretVisible",
    () => wizardHost.secretVisible,
    (value) => (wizardHost.secretVisible = Boolean(value)),
  );
  alias(
    "setupBlockedByDirtyConfig",
    () => wizardHost.blockedByDirtyConfig,
    (value) => (wizardHost.blockedByDirtyConfig = Boolean(value)),
  );
  return result;
}
