import { createMemo, createSignal, onSettled } from "solid-js";
import type { ChannelsPairingListResult, ChannelsPairingRequest } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { resolveChannelPairingAuthSignature } from "../../lib/channels/index.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectChannels, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectMutableSource, projectSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { createChannelMutations } from "./mutation-presentation.ts";
import { createChannelPluginPresentation } from "./plugin-presentation-loader.ts";
import { ChannelsView, resolveChannelOrder } from "./view.tsx";
import type { ChannelPairingPrompt, ChannelsProps } from "./view.types.ts";
import { createChannelSetup } from "./wizard-setup.ts";

const CHANNEL_PAIRING_POLL_INTERVAL_MS = 30_000;
const CHANNELS_DOCS_URL = "https://docs.openclaw.ai/channels";

function createChannelsPage(context: ApplicationContext) {
  const [selectedChannel, setSelectedChannel] = createSignal<string | null>(null);
  const [pairingChannelFilter, setPairingChannelFilter] = createSignal<string | null>(null);
  const [pairingAccountFilter, setPairingAccountFilter] = createSignal<string | null>(null);
  const [pairingNotice, setPairingNotice] = createSignal<string | null>(null);
  // Prompt identity admits asynchronous mutations before Solid flushes.
  const operations: {
    prompt: ChannelPairingPrompt | null;
  } = { prompt: null };
  let publishOperations = () => {};
  const operationState = projectMutableSource(operations, (source) => source);
  publishOperations = operationState.publish;
  function updateOperations(patch: Partial<typeof operations>) {
    Object.assign(operations, patch);
    publishOperations();
  }
  let active = true;
  const pairingPoll = useVisiblePoll(CHANNEL_PAIRING_POLL_INTERVAL_MS, pollPairing);
  let pairingRoot: HTMLElement | undefined;
  const gatewayProjection = projectGateway(context.gateway);
  const channelsProjection = projectChannels(context.channels);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const settings = projectSource(context.theme, {
    read: () => loadSettings().showAdvancedSettings === true,
    // The projection owns theme observation for the persisted advanced-settings preference.
    subscribe: (theme, notify) => theme?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });

  const pluginPresentation = createChannelPluginPresentation({
    getContext: () => context,
    getProps: () => ({ ...viewProps(), mutationBusy: mutations.busy() }),
    getConnection: () => connection,
    getChannelIds: () => resolveChannelOrder(channelsProjection.read().channelsSnapshot),
    isConnected: () => active && context.gateway.snapshot.phase === "connected",
  });

  const wizardHost = createChannelSetup({
    getContext: () => context,
    clearSelection: () => setSelectedChannel(null),
    presentWizard: (pending) => mutations.run("wizard", pending),
    retire: () => {
      mutations.retire("wizard");
      mutations.retire("whatsapp");
    },
    startWhatsApp,
  });

  let schemaLoadStarted = false;
  let gatewayPairingAuthSignature: string | null = null;
  let canManagePairing = false;
  let canAdmin = false;
  const connection = new GatewayPageBinding(() => publishOperations(), {
    getGateway: () => context.gateway,
    onSnapshot: handleGatewaySnapshot,
  });
  const mutations = createChannelMutations({
    readEpoch: () => {
      gatewayProjection.read();
      return connection.epoch;
    },
    currentEpoch: () => connection.epoch,
    isActive: () => active,
  });

  function handleGatewaySnapshot(change: GatewayPageChange) {
    const { snapshot, initial, identityChanged } = change;
    const transportChanged = change.clientChanged || change.connectionChanged;
    if (identityChanged || transportChanged) {
      mutations.retire();
    }
    const connected = snapshot.phase === "connected";
    const pairingAccess = connected
      ? hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
      : canManagePairing;
    const adminAccess = connected ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null) : canAdmin;
    if (!adminAccess) {
      mutations.retire("config");
      mutations.retire("whatsapp");
      mutations.retire("wizard");
    }
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
      mutations.retire("pairing");
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
        void context.channels.refresh(false);
      }
      if (
        !initial &&
        (identityChanged || transportChanged || pairingAuthChanged) &&
        pairingAccess
      ) {
        void context.channels.refreshPairing();
      }
    } else {
      schemaLoadStarted = false;
    }
  }

  function ensureInitialData() {
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
    const snapshot = context.gateway.snapshot;
    if (
      active &&
      snapshot.phase === "connected" &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
    ) {
      void context.channels.refreshPairing();
    }
  }

  function setShowAdvancedSettings(enabled: boolean) {
    patchSettings({ showAdvancedSettings: enabled });
    context.theme.refresh();
  }

  async function saveChannelConfig() {
    if (await context.runtimeConfig.save()) {
      await context.channels.refresh(true);
    }
  }

  async function reloadChannelConfig() {
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
    if (context.channels.state.pairingBusyRequestId) {
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
      const dismissed = await context.channels.dismissPairing(target);
      if (dismissed && operations.prompt === prompt) {
        updateOperations({ prompt: null });
        setPairingNotice(t("channels.pairing.dismissedNotice"));
      }
      return;
    }

    const result = await context.channels.approvePairing({
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

  function presentWhatsApp(pending: Promise<void>) {
    void mutations.run("whatsapp", pending).then(() => {
      // Plugin views receive imperative snapshots, including the settled saving flag.
      onSettled(() => pluginPresentation.details.sync());
    });
    return pending;
  }

  function startWhatsApp(force: boolean, accountId = wizardHost.whatsappAccountId()) {
    return presentWhatsApp(context.channels.startWhatsApp(force, accountId));
  }

  function viewProps(): ChannelsProps {
    operationState.read();
    gatewayProjection.read();
    const channels = channelsProjection.read();
    const config = configProjection.read().state;
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
      onShowDetail: (channel) => {
        mutations.retire("config");
        mutations.retire("whatsapp");
        setSelectedChannel(channel);
      },
      onCloseDetail: () => {
        mutations.retire("config");
        mutations.retire("whatsapp");
        setSelectedChannel(null);
      },
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
      onPairingPromptCancel: () => {
        mutations.retire("pairing");
        updateOperations({ prompt: null });
      },
      onPairingPromptConfirm: () => void mutations.run("pairing", confirmPairingPrompt()),
      onWhatsAppStart: startWhatsApp,
      onWhatsAppWait: () =>
        presentWhatsApp(context.channels.waitWhatsApp(wizardHost.whatsappAccountId())),
      onWhatsAppLogout: (accountId) => presentWhatsApp(context.channels.logoutWhatsApp(accountId)),
      onShowAdvancedSettings: setShowAdvancedSettings,
      onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
      onConfigSave: () => void mutations.run("config", saveChannelConfig()),
      onConfigReload: () => void reloadChannelConfig(),
    };
  }
  // The application owns these services for this mounted page's lifetime.
  onSettled(() => {
    // Gateway receipts retire plugin operations and pairing prompts synchronously.
    connection.connect();
    const applyChannels = () => {
      pluginPresentation.details.sync();
      reconcilePairingFilter(context.channels.state.pairingSnapshot);
      pluginPresentation.ensure(context.gateway.snapshot.client);
    };
    // Channel receipts reconcile pairing selections and start presentation loads as channel identities arrive.
    const stopChannels = channelsProjection.subscribe(applyChannels);
    applyChannels();
    const applyConfig = () => {
      pluginPresentation.details.sync();
      ensureInitialData();
    };
    // Configuration completion receipts drive the initial channel and schema loading state machine.
    const stopConfig = configProjection.subscribe(applyConfig);
    applyConfig();
    let location = context.router.getState().location;
    // Navigation intent releases presentation before Solid parks the departing page.
    const stopNavigation = context.router.subscribe((state) => {
      if (state.location !== location) {
        location = state.location;
        mutations.retire();
      }
    });
    return () => {
      active = false;
      mutations.retire();
      stopNavigation();
      stopChannels();
      stopConfig();
      connection.dispose();
    };
  });
  return { viewProps, mutations };
}

export function ChannelsPage() {
  const page = createChannelsPage(useApplication());
  const viewProps = createMemo(page.viewProps);
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
        <ChannelsView {...viewProps()} mutationBusy={page.mutations.busy()} />
      </SettingsWorkspace>
    </openclaw-channels-page>
  );
}
