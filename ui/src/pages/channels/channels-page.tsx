import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type { ChannelsPairingListResult, ChannelsPairingRequest } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { resolveChannelPairingAuthSignature } from "../../lib/channels/index.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectChannels, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { createChannelPluginPresentation } from "./plugin-presentation-loader.ts";
import { ChannelsView, resolveChannelOrder } from "./view.tsx";
import type { ChannelPairingPrompt, ChannelsProps } from "./view.types.ts";
import { createChannelSetup } from "./wizard-setup.ts";

const CHANNEL_PAIRING_POLL_INTERVAL_MS = 30_000;
const CHANNELS_DOCS_URL = "https://docs.openclaw.ai/channels";

function createChannelsPage(getContext: () => ApplicationContext) {
  const [selectedChannel, setSelectedChannel] = createSignal<string | null>(null);
  const [pairingChannelFilter, setPairingChannelFilter] = createSignal<string | null>(null);
  const [pairingAccountFilter, setPairingAccountFilter] = createSignal<string | null>(null);
  const [pairingNotice, setPairingNotice] = createSignal<string | null>(null);
  // Prompt identity admits asynchronous mutations before Solid flushes.
  const operations: {
    prompt: ChannelPairingPrompt | null;
  } = { prompt: null };
  let publishOperations = () => {};
  const operationState = projectSource(operations, {
    read: (source) => source,
    subscribe: (_source, notify) => {
      publishOperations = notify;
      return () => {
        publishOperations = () => {};
      };
    },
    equality: "revision",
  });
  function updateOperations(patch: Partial<typeof operations>) {
    Object.assign(operations, patch);
    publishOperations();
  }
  let active = true;
  const pairingPoll = useVisiblePoll(CHANNEL_PAIRING_POLL_INTERVAL_MS, pollPairing);
  let pairingRoot: HTMLElement | undefined;
  // Projection identities belong to this mounted page; replacement only swaps their sources.
  const initialContext = untrack(getContext);
  const gatewayProjection = projectGateway(initialContext.gateway);
  const channelsProjection = projectChannels(initialContext.channels);
  const configProjection = projectRuntimeConfig(initialContext.runtimeConfig);
  const settings = projectSource(initialContext.theme, {
    read: () => loadSettings().showAdvancedSettings === true,
    // The projection owns theme observation for the persisted advanced-settings preference.
    subscribe: (theme, notify) => theme?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });

  const pluginPresentation = createChannelPluginPresentation({
    getContext,
    getProps: viewProps,
    getConnection: () => connection,
    getChannelIds: () => resolveChannelOrder(channelsProjection.read().channelsSnapshot),
    isConnected: () => active && getContext().gateway.snapshot.phase === "connected",
  });

  const wizardHost = createChannelSetup({
    getContext,
    clearSelection: () => setSelectedChannel(null),
  });

  let schemaLoadStarted = false;
  let channelsSource: ApplicationContext["channels"] | undefined;
  let gatewayPairingAuthSignature: string | null = null;
  let canManagePairing = false;
  let canAdmin = false;
  const connection = new GatewayPageBinding(() => publishOperations(), {
    getGateway: () => getContext().gateway,
    onSnapshot: handleGatewaySnapshot,
  });

  function handleGatewaySnapshot(change: GatewayPageChange) {
    const { snapshot, initial, identityChanged } = change;
    const transportChanged = change.clientChanged || change.connectionChanged;
    const connected = snapshot.phase === "connected";
    const pairingAccess = connected
      ? hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
      : canManagePairing;
    const adminAccess = connected ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null) : canAdmin;
    const pairingAuthSignature = connected
      ? resolveChannelPairingAuthSignature(snapshot)
      : gatewayPairingAuthSignature;
    const pairingAuthChanged = !initial && gatewayPairingAuthSignature !== pairingAuthSignature;
    if (identityChanged) {
      pluginPresentation.reset();
    } else if (transportChanged) {
      pluginPresentation.invalidateRequests();
    }
    if (identityChanged || pairingAuthChanged || (connected && !pairingAccess)) {
      updateOperations({ prompt: null });
      setPairingFilter(null, null);
      setPairingNotice(null);
    }
    gatewayPairingAuthSignature = pairingAuthSignature;
    canManagePairing = !identityChanged || connected ? pairingAccess : false;
    canAdmin = !identityChanged || connected ? adminAccess : false;
    pluginPresentation.details.sync();
    if (snapshot.phase === "connected" && snapshot.client && pairingAccess) {
      pairingPoll.start();
    } else {
      pairingPoll.stop();
    }
    if (snapshot.phase === "connected" && snapshot.client) {
      if (!initial) {
        ensureInitialData();
      }
      if (!initial && (identityChanged || transportChanged)) {
        void getContext().channels.refresh(false);
      }
      if (
        !initial &&
        (identityChanged || transportChanged || pairingAuthChanged) &&
        pairingAccess
      ) {
        void getContext().channels.refreshPairing();
      }
    } else {
      schemaLoadStarted = false;
    }
  }

  function ensureInitialData() {
    const context = getContext();
    const gateway = context.gateway.snapshot;
    const client = gateway.client;
    if (gateway.phase !== "connected" || !client) {
      return;
    }

    pluginPresentation.ensure(client);

    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    if (!channels.channelsSnapshot && !channels.channelsLoading) {
      void context.channels.refresh(false);
    }
    if (
      hasOperatorPairingAccess(gateway.hello?.auth ?? null) &&
      !channels.pairingSnapshot &&
      !channels.pairingLoading
    ) {
      void context.channels.refreshPairing();
    }
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
    if (!config.configSchema && !config.configSchemaLoading && !schemaLoadStarted) {
      schemaLoadStarted = true;
      void context.runtimeConfig.ensureSchemaLoaded();
    }
  }

  function pollPairing() {
    const snapshot = getContext().gateway.snapshot;
    if (
      active &&
      snapshot.phase === "connected" &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
    ) {
      void getContext().channels.refreshPairing();
    }
  }

  function setShowAdvancedSettings(enabled: boolean) {
    patchSettings({ showAdvancedSettings: enabled });
    getContext().theme.refresh();
  }

  async function saveChannelConfig() {
    if (await getContext().runtimeConfig.save()) {
      await getContext().channels.refresh(true);
    }
  }

  async function reloadChannelConfig() {
    const context = getContext();
    await context.runtimeConfig.discardDraft({ reloadOnly: true });
    await context.channels.refresh(true);
  }

  function reconcilePairingFilter(snapshot: ChannelsPairingListResult | null) {
    if (!snapshot || !pairingChannelFilter()) {
      return;
    }
    const channelAccounts = snapshot.accounts.filter(
      (account) => account.channel === pairingChannelFilter(),
    );
    if (channelAccounts.length === 0) {
      setPairingFilter(null, null);
      return;
    }
    if (
      pairingAccountFilter() &&
      !channelAccounts.some((account) => account.accountId === pairingAccountFilter())
    ) {
      setPairingAccountFilter(null);
    }
  }

  function setPairingFilter(channel: string | null, accountId: string | null) {
    setPairingChannelFilter(channel);
    setPairingAccountFilter(channel ? accountId : null);
  }

  function reviewPairingAccount(channel: string, accountId: string) {
    setSelectedChannel(null);
    setPairingFilter(channel, accountId);
    onSettled(() => {
      if (active) {
        pairingRoot?.scrollIntoView({
          behavior: resolveScrollBehavior(),
          block: "start",
        });
      }
    });
  }

  function openPairingPrompt(kind: ChannelPairingPrompt["kind"], request: ChannelsPairingRequest) {
    if (getContext().channels.state.pairingBusyRequestId) {
      return;
    }
    setPairingNotice(null);
    updateOperations({
      prompt: {
        kind,
        request,
        notify: false,
        bootstrapCommandOwner: false,
      },
    });
  }

  function patchPairingPrompt(
    patch: Partial<Pick<ChannelPairingPrompt, "notify" | "bootstrapCommandOwner">>,
  ) {
    if (!operations.prompt) {
      return;
    }
    updateOperations({ prompt: { ...operations.prompt, ...patch } });
  }

  async function confirmPairingPrompt() {
    const prompt = operations.prompt;
    if (!prompt) {
      return;
    }
    const target = {
      channel: prompt.request.channel,
      accountId: prompt.request.accountId,
      requestId: prompt.request.requestId,
    };
    if (prompt.kind === "dismiss") {
      const dismissed = await getContext().channels.dismissPairing(target);
      if (dismissed && operations.prompt === prompt) {
        updateOperations({ prompt: null });
        setPairingNotice(t("channels.pairing.dismissedNotice"));
      }
      return;
    }

    const result = await getContext().channels.approvePairing({
      ...target,
      notify: prompt.notify,
      bootstrapCommandOwner: prompt.bootstrapCommandOwner,
    });
    if (!result || operations.prompt !== prompt) {
      return;
    }
    updateOperations({ prompt: null });
    setPairingNotice(
      t(
        result.commandOwnerBootstrap === "unavailable"
          ? result.notification === "failed"
            ? "channels.pairing.approvedFollowupsFailedNotice"
            : "channels.pairing.approvedOwnerFailedNotice"
          : result.notification === "failed"
            ? "channels.pairing.approvedNotificationFailedNotice"
            : result.commandOwnerBootstrap === "configured"
              ? "channels.pairing.approvedOwnerNotice"
              : "channels.pairing.approvedNotice",
      ),
    );
  }

  function viewProps(): ChannelsProps {
    operationState.read();
    gatewayProjection.read();
    const channels = channelsProjection.read();
    const config = configProjection.read().state;
    const context = getContext();
    return {
      channels,
      config,
      presentation: pluginPresentation,
      wizardHost,
      pairingChannelFilter: pairingChannelFilter(),
      pairingAccountFilter: pairingAccountFilter(),
      pairingPrompt: operations.prompt,
      pairingNotice: pairingNotice(),
      canManagePairing,
      canAdmin,
      showAdvancedSettings: settings.read(),
      onPairingRoot: (element) => {
        pairingRoot = element;
      },
      selectedChannel: selectedChannel(),
      onShowDetail: setSelectedChannel,
      onCloseDetail: () => setSelectedChannel(null),
      onStartSetup: (channelId) => {
        if (canAdmin && context.gateway.snapshot.phase === "connected") {
          wizardHost.startSetup(channelId);
        }
      },
      onRefresh: (probe) => void context.channels.refresh(probe),
      onPairingRefresh: () => void context.channels.refreshPairing(),
      onPairingFilterChange: setPairingFilter,
      onPairingReviewAccount: reviewPairingAccount,
      onPairingApprove: (request) => openPairingPrompt("approve", request),
      onPairingDismiss: (request) => openPairingPrompt("dismiss", request),
      onPairingPromptChange: patchPairingPrompt,
      onPairingPromptCancel: () => updateOperations({ prompt: null }),
      onPairingPromptConfirm: () => void confirmPairingPrompt(),
      onWhatsAppStart: (force) =>
        void context.channels.startWhatsApp(force, wizardHost.whatsappAccountId()),
      onWhatsAppWait: () => void context.channels.waitWhatsApp(wizardHost.whatsappAccountId()),
      onShowAdvancedSettings: setShowAdvancedSettings,
      onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
      onConfigSave: () => void saveChannelConfig(),
      onConfigReload: () => void reloadChannelConfig(),
    };
  }
  // Rebind Gateway, channel, config, and theme subscriptions together when their context changes.
  createEffect(getContext, (context) => {
    // Subscription callbacks reconcile synchronous owner receipts; their reads do not subscribe.
    gatewayProjection.replaceSource(context.gateway);
    channelsProjection.replaceSource(context.channels);
    configProjection.replaceSource(context.runtimeConfig);
    settings.replaceSource(context.theme);
    // Gateway receipts retire plugin operations and pairing prompts synchronously.
    connection.refresh();
    if (channelsSource && channelsSource !== context.channels) {
      connection.invalidate();
      pluginPresentation.details.reset();
    }
    channelsSource = context.channels;
    const applyChannels = () => {
      if (getContext().channels !== context.channels) {
        return;
      }
      pluginPresentation.details.sync();
      reconcilePairingFilter(context.channels.state.pairingSnapshot);
      pluginPresentation.ensure(context.gateway.snapshot.client);
    };
    // Channel receipts reconcile pairing selections and start presentation loads as channel identities arrive.
    const stopChannels = channelsProjection.subscribe(applyChannels);
    applyChannels();
    schemaLoadStarted = false;
    const applyConfig = () => {
      if (getContext().runtimeConfig === context.runtimeConfig) {
        pluginPresentation.details.sync();
        ensureInitialData();
      }
    };
    // Configuration completion receipts drive the initial channel and schema loading state machine.
    const stopConfig = configProjection.subscribe(applyConfig);
    applyConfig();
    return () => {
      stopChannels();
      stopConfig();
    };
  });
  onCleanup(() => {
    active = false;
    connection.dispose();
  });
  return viewProps;
}

export function ChannelsPage(props: { context?: ApplicationContext }) {
  const application = useOptionalApplication();
  const viewProps = createMemo(createChannelsPage(() => props.context ?? application!));
  return (
    <openclaw-channels-page>
      <SettingsPageHeader
        title={t("tabs.channels")}
        subtitle={
          <>
            {t("subtitles.channels")} <LearnMoreLink url={CHANNELS_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <ChannelsView {...viewProps()} />
      </SettingsWorkspace>
    </openclaw-channels-page>
  );
}
