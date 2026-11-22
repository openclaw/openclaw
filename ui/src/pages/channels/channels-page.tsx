import { action, createMemo, createOptimisticStore, createSignal, onSettled } from "solid-js";
import type { ChannelsPairingListResult, ChannelsPairingRequest } from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { showConfirmChoiceDialog } from "../../components/confirm-dialog.ts";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import {
  createChannelCapability,
  resolveChannelConfigValue,
  resolveChannelPairingAuthSignature,
  type ChannelConfigEdit,
} from "../../lib/channels/index.ts";
import {
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  resolveEditableSnapshotConfig,
} from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageBinding, type GatewayPageChange } from "../../lib/gateway-page-binding.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectChannels, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import { projectMutableSource, projectSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { showToast } from "../../lib/toast.ts";
import {
  buildChannelConfigPatch,
  dropConflictingChannelConfigEdits,
  editChannelField,
  findChannelConfigConflicts,
  keptChannelEdits,
  rebaseChannelConfigEdits,
} from "./channel-config-draft.ts";
import { createChannelPluginPresentation } from "./plugin-presentation-loader.ts";
import { ChannelsView, resolveChannelLabel, resolveChannelOrder } from "./view.tsx";
import type { ChannelPairingPrompt, ChannelSaveFeedback, ChannelsProps } from "./view.types.ts";
import { createChannelSetup } from "./wizard-setup.ts";

registerRouteSubtitlesEnglish();

const CHANNEL_PAIRING_POLL_INTERVAL_MS = 30_000;
const CHANNELS_DOCS_URL = "https://docs.openclaw.ai/channels";

export function ChannelsPage() {
  const context = useApplication();
  const channelCapability = context.acquireChannels(createChannelCapability);
  channelCapability.syncConfigEditsScope(gatewayPresentationScope(context.gateway).key);
  const [selectedChannel, setSelectedChannel] = createSignal<string | null>(
    channelCapability.takeConfigReview(),
  );
  const [savingChannel, setSavingChannel] = createSignal<string | null>(null);
  const [savedChannel, setSavedChannel] = createSignal<string | null>(null);
  const [saveFeedback, setSaveFeedback] = createSignal<ChannelSaveFeedback | null>(null);
  let interruptedSave: { channelId: string; edits: readonly ChannelConfigEdit[] } | null = null;
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
  const channelsProjection = projectChannels(channelCapability);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const settings = projectSource(context.theme, {
    read: () => loadSettings().showAdvancedSettings === true,
    // The projection owns theme observation for the persisted advanced-settings preference.
    subscribe: (theme, notify) => theme?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });

  const pluginPresentation = createChannelPluginPresentation({
    getContext: () => context,
    getProps: () => ({ ...viewProps(), mutationBusy: presentation().busy }),
    getConnection: () => connection,
    getChannelIds: () => resolveChannelOrder(channelsProjection.read().channelsSnapshot),
    isConnected: () => active && context.gateway.snapshot.phase === "connected",
  });

  const wizardHost = createChannelSetup({
    getContext: () => context,
    channels: channelCapability,
    clearSelection: () => clearChannelDetail(),
    presentWizard: (pending) => runMutation("wizard", pending),
    retire: () => {
      retireMutation("wizard");
      retireMutation("whatsapp");
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
  // Presents admitted work without changing its owner's write or settlement policy.
  const epoch = createMemo(() => {
    gatewayProjection.read();
    return connection.epoch;
  });
  const presentation = createMemo(() => {
    const currentEpoch = epoch();
    const [busy, setBusy] = createOptimisticStore({
      config: false,
      pairing: false,
      whatsapp: false,
      wizard: false,
    });
    return { epoch: currentEpoch, busy, setBusy };
  });
  const lifetimes = {
    config: Promise.withResolvers<void>(),
    pairing: Promise.withResolvers<void>(),
    whatsapp: Promise.withResolvers<void>(),
    wizard: Promise.withResolvers<void>(),
  };
  const isCurrent = (view: ReturnType<typeof presentation>) =>
    active && view.epoch === connection.epoch;
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    kind: ChannelMutation,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    try {
      if (isCurrent(view)) {
        view.setBusy((busy) => {
          busy[kind] = true;
        });
      }
      // Leaving the presentation never cancels an already admitted write.
      yield Promise.race([pending, retired]);
    } catch (error) {
      if (isCurrent(view)) {
        showToast({ severity: "error", message: formatUiError(error) });
      }
    }
  });

  function retireMutation(kind?: ChannelMutation) {
    for (const key of kind ? [kind] : (["config", "pairing", "whatsapp", "wizard"] as const)) {
      lifetimes[key].resolve();
      lifetimes[key] = Promise.withResolvers<void>();
    }
  }

  async function runMutation(kind: ChannelMutation, pending: Promise<unknown>) {
    const view = presentation();
    const retired = lifetimes[kind].promise;
    // Let owner publication and any newly opened modal mount before joining the action.
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    return present(view, kind, pending, retired);
  }

  function handleGatewaySnapshot(change: GatewayPageChange) {
    const { snapshot, initial, identityChanged } = change;
    channelCapability.syncConfigEditsScope(gatewayPresentationScope(context.gateway).key);
    const transportChanged = change.clientChanged || change.connectionChanged;
    if (identityChanged || transportChanged) {
      retireMutation();
    }
    const connected = snapshot.phase === "connected";
    const pairingAccess = connected
      ? hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
      : canManagePairing;
    const adminAccess = connected ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null) : canAdmin;
    if (!adminAccess) {
      retireMutation("config");
      retireMutation("whatsapp");
      retireMutation("wizard");
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
      retireMutation("pairing");
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
      void confirmInterruptedSave();
      if (!initial && (identityChanged || transportChanged)) {
        void channelCapability.refresh(false);
      }
      if (
        !initial &&
        (identityChanged || transportChanged || pairingAuthChanged) &&
        pairingAccess
      ) {
        void channelCapability.refreshPairing();
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

    const channels = channelCapability.state;
    const config = context.runtimeConfig.state;
    if (!channels.channelsSnapshot && !channels.channelsLoading) {
      void channelCapability.refresh(false);
    }
    if (
      hasOperatorPairingAccess(gateway.hello?.auth ?? null) &&
      !channels.pairingSnapshot &&
      !channels.pairingLoading
    ) {
      void channelCapability.refreshPairing();
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
      void channelCapability.refreshPairing();
    }
  }

  function setShowAdvancedSettings(enabled: boolean) {
    patchSettings({ showAdvancedSettings: enabled });
    context.theme.refresh();
  }

  function hasUnsavedConfig(channelId: string) {
    return Boolean(channelCapability.state.configEdits[channelId]);
  }

  /** The one place these edits reach the config. Returns whether nothing is left unsaved. */
  async function saveChannelConfig(channelId: string, retry = true): Promise<boolean> {
    const edits = channelCapability.state.configEdits[channelId];
    if (!edits) {
      return true;
    }
    const bases = channelCapability.state.configEditBases[channelId] ?? [];
    const config = context.runtimeConfig.state;
    const client = config.client;
    const configEpoch = currentConfigConnectionEpoch(config);
    let conflicts: Array<Array<string | number>> = [];
    let sent = false;
    interruptedSave = null;
    setSaveFeedback(null);
    setSavingChannel(channelId);
    const patched = await context.runtimeConfig
      .patchFromSnapshot((snapshot) => {
        conflicts = findChannelConfigConflicts(bases, snapshot);
        if (conflicts.length > 0) {
          // Lists go out whole and removed keys as deletions, so writing over a field that
          // changed elsewhere would silently drop that change. Nothing is written.
          return { options: { raw: {}, note: "", canDispatch: () => false } };
        }
        const built = buildChannelConfigPatch({
          base: resolveChannelConfigValue(snapshot, channelId),
          channelId,
          // A reference that arrived while editing is never written over, nor a secret emptied.
          edits: keptChannelEdits(config, channelId, snapshot, edits),
          schema: config.configSchema,
        });
        return {
          options: {
            raw: built?.patch ?? {},
            replacePaths: built?.replacePaths,
            note: `channels: update ${channelId}`,
            canDispatch: () => {
              sent = true;
              return true;
            },
          },
        };
      })
      .finally(() => setSavingChannel(null));
    if (patched) {
      await finishChannelSave(channelId, edits);
      return true;
    }
    if (conflicts.length > 0) {
      setSaveFeedback({ channelId, kind: "conflict", paths: conflicts });
      return false;
    }
    if (client && !isCurrentConfigConnection(config, client, configEpoch)) {
      // A dropped connection settles the request without an answer; only a fresh read says
      // whether the write landed.
      if (sent) {
        interruptedSave = { channelId, edits };
        setSaveFeedback({ channelId, kind: "interrupted" });
        void confirmInterruptedSave();
      } else {
        setSaveFeedback({ channelId, kind: "notSaved" });
      }
      return false;
    }
    if (retry && config.configAutoSaveStatus === "conflict" && !config.configFormDirty) {
      // The file moved on before this page heard of it. Re-read it; Save goes ahead only if
      // none of the edited fields changed.
      await context.runtimeConfig.discardDraft({ reloadOnly: true });
      return saveChannelConfig(channelId, false);
    }
    if (sent && config.lastError) {
      setSaveFeedback({ channelId, kind: "error", message: config.lastError });
    }
    return false;
  }

  async function finishChannelSave(channelId: string, edits: readonly ChannelConfigEdit[]) {
    if (channelCapability.state.configEdits[channelId] === edits) {
      channelCapability.discardConfigEdits(channelId);
      setSavedChannel(channelId);
    }
    await channelCapability.refresh(true);
  }

  /** Once reconnected, a fresh read decides how an interrupted Save ended. */
  async function confirmInterruptedSave() {
    const pending = interruptedSave;
    if (!pending || !active || context.gateway.snapshot.phase !== "connected") {
      return;
    }
    interruptedSave = null;
    const { channelId, edits } = pending;
    const config = context.runtimeConfig.state;
    const previous = config.configSnapshot;
    await context.runtimeConfig.refresh();
    if (config.configSnapshot === previous || !config.connected) {
      // The read failed; the next reconnect tries again.
      interruptedSave ??= pending;
      return;
    }
    const saved = resolveEditableSnapshotConfig(config.configSnapshot);
    // Edited or discarded meanwhile: a later Save or Discard reports instead.
    if (!active || !saved || channelCapability.state.configEdits[channelId] !== edits) {
      return;
    }
    const landed =
      buildChannelConfigPatch({
        base: resolveChannelConfigValue(saved, channelId),
        channelId,
        edits: keptChannelEdits(config, channelId, saved, edits),
        schema: config.configSchema,
      }) === null;
    setSaveFeedback(landed ? null : { channelId, kind: "notSaved" });
    if (landed) {
      await finishChannelSave(channelId, edits);
    }
  }

  /** Overwrite keeps the edits to fields changed elsewhere; Reload takes the newer values. */
  function resolveConfigConflict(channelId: string, choice: "keep" | "latest") {
    const edits = channelCapability.state.configEdits[channelId] ?? [];
    const bases = channelCapability.state.configEditBases[channelId] ?? [];
    const saved = resolveEditableSnapshotConfig(context.runtimeConfig.state.configSnapshot);
    if (!saved) {
      return;
    }
    if (choice === "keep") {
      channelCapability.replaceConfigEdits(
        channelId,
        edits,
        rebaseChannelConfigEdits(bases, saved),
      );
    } else {
      const kept = dropConflictingChannelConfigEdits(
        edits,
        bases,
        findChannelConfigConflicts(bases, saved),
      );
      channelCapability.replaceConfigEdits(channelId, kept.edits, kept.bases);
    }
    setSaveFeedback(null);
    if (channelCapability.state.configEdits[channelId]) {
      void runMutation("config", saveChannelConfig(channelId));
    }
  }

  async function discardChannelConfig(channelId: string) {
    channelCapability.discardConfigEdits(channelId);
    if (interruptedSave?.channelId === channelId) {
      interruptedSave = null;
    }
    setSavedChannel(null);
    setSaveFeedback(null);
    // Config changes elsewhere already refresh the form; a re-read is only left to clear what a
    // rejected Save reported. Other pages' unsaved edits in the shared draft would not survive it.
    const config = context.runtimeConfig.state;
    if (config.lastError && !config.configFormDirty) {
      await context.runtimeConfig.discardDraft({ reloadOnly: true });
    }
  }

  /** Resolves true once the channel has nothing unsaved; false keeps the user editing. */
  async function resolveUnsavedConfig(channelId: string) {
    const channel = resolveChannelLabel(viewProps(), channelId);
    const choice = await showConfirmChoiceDialog({
      title: t("channels.config.unsavedTitle", { channel }),
      message: t("channels.config.unsavedMessage", { channel }),
      confirmLabel: t("common.save"),
      alternativeLabel: t("channels.config.discard"),
      cancelLabel: t("channels.config.keepEditing"),
    });
    if (choice === "alternative") {
      await discardChannelConfig(channelId);
      return true;
    }
    return choice === "confirm" ? saveChannelConfig(channelId) : false;
  }

  function clearChannelDetail() {
    retireMutation("config");
    retireMutation("whatsapp");
    setSavedChannel(null);
    setSaveFeedback(null);
    setSelectedChannel(null);
  }

  async function closeChannelDetail() {
    const channelId = selectedChannel();
    if (channelId && hasUnsavedConfig(channelId) && !(await resolveUnsavedConfig(channelId))) {
      return;
    }
    clearChannelDetail();
  }

  /** Setup reloads the config when it finishes, so unsaved edits get the same choice as closing. */
  async function startChannelSetup(channelId: string | null) {
    const open = selectedChannel();
    const edited = Object.keys(channelCapability.state.configEdits).toSorted(
      (left, right) => Number(right === open) - Number(left === open),
    );
    for (const id of edited) {
      if (hasUnsavedConfig(id) && !(await resolveUnsavedConfig(id))) {
        return;
      }
    }
    if (active && canAdmin && context.gateway.snapshot.phase === "connected") {
      wizardHost.startSetup(channelId);
    }
  }

  function noteUnsavedConfigOnLeave() {
    const channelIds = Object.keys(channelCapability.state.configEdits);
    if (channelIds.length === 0) {
      return;
    }
    const props = viewProps();
    const labels = channelIds.map((channelId) => resolveChannelLabel(props, channelId));
    const [only] = channelIds.length === 1 ? channelIds : [];
    showToast({
      severity: "error",
      actionPrimary: true,
      message:
        only !== undefined
          ? t("channels.config.unsavedOnLeave", { channel: resolveChannelLabel(props, only) })
          : t("channels.config.unsavedOnLeaveMany", {
              channels: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(labels),
            }),
      actionLabel: t("channels.config.review"),
      onAction: () => {
        // One channel reopens with its edits; several return to the list, where each row says so.
        if (only !== undefined) {
          channelCapability.requestConfigReview(only);
        }
        void context.router.navigate("channels", context);
      },
      durationMs: 12_000,
    });
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
    if (channelCapability.state.pairingBusy) {
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
      const dismissed = await channelCapability.dismissPairing(target);
      if (dismissed && operations.prompt === prompt) {
        updateOperations({ prompt: null });
        setPairingNotice(t("channels.pairing.dismissedNotice"));
      }
      return;
    }

    const result = await channelCapability.approvePairing({
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
    void runMutation("whatsapp", pending).then(() => {
      // Plugin views receive imperative snapshots, including the settled saving flag.
      onSettled(() => pluginPresentation.details.sync());
    });
    return pending;
  }

  function startWhatsApp(force: boolean, accountId = wizardHost.whatsappAccountId()) {
    return presentWhatsApp(channelCapability.startWhatsApp(force, accountId));
  }

  function viewProps(): ChannelsProps {
    operationState.read();
    gatewayProjection.read();
    const channels = channelsProjection.read();
    const config = configProjection.read().state;
    return {
      channels,
      config,
      configEdits: channels.configEdits,
      savingChannel: savingChannel(),
      savedChannel: savedChannel(),
      saveFeedback: saveFeedback(),
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
        retireMutation("config");
        retireMutation("whatsapp");
        setSelectedChannel(channel);
      },
      onCloseDetail: () => void closeChannelDetail(),
      onStartSetup: (channelId) => void startChannelSetup(channelId),
      onRefresh: (probe) => void channelCapability.refresh(probe),
      onPairingRefresh: () => void channelCapability.refreshPairing(),
      onPairingFilterChange: setPairingFilter,
      onPairingReviewAccount: reviewPairingAccount,
      onPairingApprove: (request) => openPairingPrompt("approve", request),
      onPairingDismiss: (request) => openPairingPrompt("dismiss", request),
      onPairingPromptChange: patchPairingPrompt,
      onPairingPromptCancel: () => {
        retireMutation("pairing");
        updateOperations({ prompt: null });
      },
      onPairingPromptConfirm: () => void runMutation("pairing", confirmPairingPrompt()),
      onWhatsAppStart: startWhatsApp,
      onWhatsAppWait: () =>
        presentWhatsApp(channelCapability.waitWhatsApp(wizardHost.whatsappAccountId())),
      onWhatsAppLogout: (accountId) => presentWhatsApp(channelCapability.logoutWhatsApp(accountId)),
      onShowAdvancedSettings: setShowAdvancedSettings,
      onConfigPatch: (channelId, path, value) => {
        setSavedChannel(null);
        editChannelField(channelCapability, context.runtimeConfig.state, channelId, {
          path,
          value,
        });
      },
      onConfigSave: (channelId) => void runMutation("config", saveChannelConfig(channelId)),
      onConfigDiscard: (channelId) => void discardChannelConfig(channelId),
      onConfigConflict: resolveConfigConflict,
    };
  }
  // The application owns these services for this mounted page's lifetime.
  onSettled(() => {
    // Gateway receipts retire plugin operations and pairing prompts synchronously.
    connection.connect();
    void context.runtimeConfig.ensureLoaded().catch(() => undefined);
    const applyChannels = () => {
      const review = channelCapability.takeConfigReview();
      if (review) {
        setSelectedChannel(review);
      }
      pluginPresentation.details.sync();
      reconcilePairingFilter(channelCapability.state.pairingSnapshot);
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
        retireMutation();
      }
    });
    return () => {
      noteUnsavedConfigOnLeave();
      active = false;
      retireMutation();
      stopNavigation();
      stopChannels();
      stopConfig();
      connection.dispose();
    };
  });
  const presentedProps = createMemo(viewProps);
  return (
    <openclaw-channels-page>
      <SettingsPageHeader
        title={t("tabs.channels")}
        subtitle={
          <>
            <LearnMoreLink url={CHANNELS_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <ChannelsView {...presentedProps()} mutationBusy={presentation().busy} />
      </SettingsWorkspace>
    </openclaw-channels-page>
  );
}

type ChannelMutation = keyof NonNullable<ChannelsProps["mutationBusy"]>;
