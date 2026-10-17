import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type {
  ChannelsPairingListResult,
  ChannelsPairingRequest,
  NostrProfile,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { resolveChannelPairingAuthSignature } from "../../lib/channels/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "../../lib/gateway-connection-lifecycle.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectChannels, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { importNostrProfile, parseValidationErrors, putNostrProfile } from "./nostr-profile-ops.ts";
import { createChannelPluginPresentation } from "./plugin-presentation-loader.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.tsx";
import { ChannelsView, resolveChannelOrder } from "./view.tsx";
import type { ChannelPairingPrompt, ChannelsProps } from "./view.types.ts";
import { runWhatsAppLogoutConfirmation } from "./whatsapp-logout.ts";
import { createChannelSetup } from "./wizard-setup.ts";

type NostrProfileFormState = ReturnType<typeof createNostrProfileFormState> | null;
const CHANNEL_PAIRING_POLL_INTERVAL_MS = 30_000;
const CHANNELS_DOCS_URL = "https://docs.openclaw.ai/channels";

type NostrOperation = {
  scope: GatewayConnectionScope;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  formAccountId: string | null;
  accountId: string;
  authCandidates: readonly string[];
};

function formatNostrProfileOperationError(error: unknown, prefix: string): string {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? t("channels.nostr.notices.timeout")
    : t("channels.nostr.notices.operationFailed", { prefix, error: formatUiError(error) });
}

function createChannelsPage(getContext: () => ApplicationContext) {
  const [selectedChannel, setSelectedChannel] = createSignal<string | null>(null);
  const [pairingChannelFilter, setPairingChannelFilter] = createSignal<string | null>(null);
  const [pairingAccountFilter, setPairingAccountFilter] = createSignal<string | null>(null);
  const [pairingNotice, setPairingNotice] = createSignal<string | null>(null);
  const [pairingScrollPending, setPairingScrollPending] = createSignal(false);
  // Profile and prompt identity admit asynchronous mutations before Solid flushes.
  const operations: {
    form: NostrProfileFormState;
    accountId: string | null;
    prompt: ChannelPairingPrompt | null;
  } = { form: null, accountId: null, prompt: null };
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
  let currentGateway: ApplicationContext["gateway"] | undefined;
  let currentClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  let pairingTimer: ReturnType<typeof setInterval> | null = null;
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
    getChannelIds: () => resolveChannelOrder(channelsProjection.read().channelsSnapshot),
    isConnected: () => active,
  });

  const wizardHost = createChannelSetup({
    getContext,
    clearSelection: () => setSelectedChannel(null),
  });

  let schemaLoadStarted = false;
  let channelsSource: ApplicationContext["channels"] | undefined;
  let gatewayPairingAuthSignature: string | null = null;
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });

  function handleGatewaySnapshot(source: ApplicationContext["gateway"]) {
    if (getContext().gateway !== source) {
      return;
    }
    const snapshot = source.snapshot;
    const initial = currentGateway === undefined;
    const identityChanged =
      !initial && (currentGateway !== source || currentClient !== snapshot.client);
    const transportChanged = connection.transition(snapshot);
    if (identityChanged && !transportChanged) {
      connection.invalidate();
    }
    currentGateway = source;
    currentClient = snapshot.client;
    const pairingAccess = hasOperatorPairingAccess(snapshot.hello?.auth ?? null);
    const pairingAuthSignature = resolveChannelPairingAuthSignature(snapshot);
    const pairingAuthChanged = !initial && gatewayPairingAuthSignature !== pairingAuthSignature;
    if (identityChanged || snapshot.phase !== "connected") {
      clearNostrForm();
    }
    if (identityChanged || transportChanged || snapshot.phase !== "connected") {
      pluginPresentation.reset();
    }
    if (identityChanged || pairingAuthChanged || snapshot.phase !== "connected" || !pairingAccess) {
      updateOperations({ prompt: null });
      setPairingFilter(null, null);
      setPairingNotice(null);
    }
    gatewayPairingAuthSignature = pairingAuthSignature;
    syncPairingPolling();
    if (snapshot.phase === "connected" && snapshot.client) {
      if (!initial) {
        ensureInitialData();
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

  const handleVisibilityChange = () => {
    if (syncPairingPolling()) {
      pollPairing();
    }
  };

  function pollPairing() {
    const snapshot = getContext().gateway.snapshot;
    if (
      active &&
      document.visibilityState !== "hidden" &&
      snapshot.phase === "connected" &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
    ) {
      void getContext().channels.refreshPairing();
    }
  }

  function syncPairingPolling() {
    const snapshot = getContext().gateway.snapshot;
    const enabled =
      active &&
      snapshot.phase === "connected" &&
      snapshot.client &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null) &&
      document.visibilityState !== "hidden";
    if (!enabled) {
      if (pairingTimer !== null) {
        clearInterval(pairingTimer);
        pairingTimer = null;
      }
    } else if (pairingTimer === null) {
      pairingTimer = setInterval(() => pollPairing(), CHANNEL_PAIRING_POLL_INTERVAL_MS);
      return true;
    }
    return false;
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

  async function confirmWhatsAppLogout() {
    const context = getContext();
    const channels = context.channels;
    const scope = connection.capture();
    if (!scope || channelsSource !== channels) {
      return;
    }
    await runWhatsAppLogoutConfirmation({
      channels,
      getWizardAccountId: () => wizardHost.whatsappAccountId(),
      isCurrent: () =>
        connection.isCurrent(scope) && getContext() === context && channelsSource === channels,
    });
  }

  function clearNostrForm() {
    updateOperations({ form: null, accountId: null });
  }

  function invalidateNostrForm() {
    connection.invalidate();
    clearNostrForm();
  }

  function beginNostrOperation(): NostrOperation | null {
    const gateway = currentGateway;
    const channels = getContext().channels;
    let scope = connection.capture();
    if (!gateway || !scope || channelsSource !== channels || getContext().gateway !== gateway) {
      return null;
    }
    connection.invalidate();
    scope = connection.capture();
    if (!scope) {
      return null;
    }
    const accounts = channels.state.channelsSnapshot?.channelAccounts?.nostr ?? [];
    return {
      scope,
      gateway,
      channels,
      formAccountId: operations.accountId,
      accountId: operations.accountId ?? accounts[0]?.accountId ?? "default",
      authCandidates: resolveControlUiAuthCandidates({
        hello: gateway.snapshot.hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      }),
    };
  }

  function currentNostrForm(operation: NostrOperation): NonNullable<NostrProfileFormState> | null {
    const form = operations.form;
    if (
      !form ||
      !connection.isCurrent(operation.scope) ||
      operations.accountId !== operation.formAccountId ||
      getContext().gateway !== operation.gateway ||
      getContext().channels !== operation.channels ||
      operation.gateway.snapshot.client !== operation.scope.client
    ) {
      return null;
    }
    return form;
  }

  function editNostrProfile(accountId: string, profile: NostrProfile | null) {
    connection.invalidate();
    updateOperations({ accountId, form: createNostrProfileFormState(profile ?? undefined) });
  }

  function editNostrForm(
    update: (form: NonNullable<NostrProfileFormState>) => NonNullable<NostrProfileFormState>,
  ) {
    const form = operations.form;
    if (form) {
      updateOperations({ form: update(form) });
    }
  }

  async function updateNostrProfile(action: "save" | "import") {
    const form = operations.form;
    if (!form || form.saving || form.importing) {
      return;
    }
    const operation = beginNostrOperation();
    if (!operation) {
      return;
    }
    const busyField = action === "save" ? "saving" : "importing";
    updateOperations({
      form: {
        ...form,
        [busyField]: true,
        error: null,
        success: null,
        ...(action === "save" ? { fieldErrors: {} } : {}),
      },
    });

    try {
      const request = {
        accountId: operation.accountId,
        authCandidates: operation.authCandidates,
        isCurrent: () => currentNostrForm(operation) !== null,
      };
      const result =
        action === "save"
          ? { action, ...(await putNostrProfile({ ...request, values: form.values })) }
          : { action, ...(await importNostrProfile(request)) };
      const currentForm = currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      const settledForm = { ...currentForm, [busyField]: false, error: null, success: null };
      if (!result.response.ok || result.data?.ok === false || !result.data) {
        updateOperations({
          form: {
            ...settledForm,
            error: result.errorMessage,
            ...(result.action === "save"
              ? { fieldErrors: parseValidationErrors(result.data?.details) }
              : {}),
          },
        });
        return;
      }

      if (result.action === "save") {
        if (!result.data.persisted) {
          updateOperations({
            form: {
              ...settledForm,
              error: t("channels.nostr.notices.publishFailed"),
            },
          });
          return;
        }
        updateOperations({
          form: {
            ...settledForm,
            success: t("channels.nostr.notices.published"),
            fieldErrors: {},
            original: { ...form.values },
          },
        });
      } else {
        const merged = result.data.merged ?? result.data.imported ?? null;
        const values = merged ? { ...currentForm.values, ...merged } : currentForm.values;
        updateOperations({
          form: {
            ...settledForm,
            values,
            success: result.data.saved
              ? t("channels.nostr.notices.importedFromRelays")
              : t("channels.nostr.notices.imported"),
            showAdvanced: Boolean(values.banner || values.website || values.nip05 || values.lud16),
          },
        });
      }
      if (result.action === "save" || result.data.saved) {
        await operation.channels.refresh(true);
      }
    } catch (err) {
      const currentForm = currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      updateOperations({
        form: {
          ...currentForm,
          [busyField]: false,
          error: formatNostrProfileOperationError(
            err,
            t(
              action === "save"
                ? "channels.nostr.notices.updateFailed"
                : "channels.nostr.notices.importFailed",
            ),
          ),
          success: null,
        },
      });
    }
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
    setPairingScrollPending(true);
  }

  function afterRender(pending: boolean) {
    if (!pending || !active) {
      return;
    }
    setPairingScrollPending(false);
    pairingRoot?.scrollIntoView({
      behavior: resolveScrollBehavior(),
      block: "start",
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
    const { snapshot } = gatewayProjection.read();
    const channels = channelsProjection.read();
    const config = configProjection.read().state;
    const context = getContext();
    const auth = snapshot.hello?.auth ?? null;
    const canManagePairing = hasOperatorPairingAccess(auth);
    const canAdmin = hasOperatorAdminAccess(auth);
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
      nostrProfileFormState: operations.form,
      nostrProfileAccountId: operations.accountId,
      selectedChannel: selectedChannel(),
      onShowDetail: setSelectedChannel,
      onCloseDetail: () => setSelectedChannel(null),
      onStartSetup: (channelId) => {
        if (canAdmin) {
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
      onWhatsAppLogout: () => void confirmWhatsAppLogout(),
      onShowAdvancedSettings: setShowAdvancedSettings,
      onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
      onConfigSave: () => void saveChannelConfig(),
      onConfigReload: () => void reloadChannelConfig(),
      onNostrProfileEdit: editNostrProfile,
      onNostrProfileCancel: invalidateNostrForm,
      onNostrProfileFieldChange: (field, value) =>
        editNostrForm((form) => ({
          ...form,
          values: { ...form.values, [field]: value },
          fieldErrors: { ...form.fieldErrors, [field]: "" },
        })),
      onNostrProfileSave: () => void updateNostrProfile("save"),
      onNostrProfileImport: () => void updateNostrProfile("import"),
      onNostrProfileToggleAdvanced: () =>
        editNostrForm((form) => ({ ...form, showAdvanced: !form.showAdvanced })),
    };
  }
  // Rebind Gateway, channel, config, and theme subscriptions together when their context changes.
  createEffect(getContext, (context) =>
    untrack(() => {
      // Subscription callbacks reconcile synchronous owner receipts; their reads do not subscribe.
      gatewayProjection.replaceSource(context.gateway);
      channelsProjection.replaceSource(context.channels);
      configProjection.replaceSource(context.runtimeConfig);
      settings.replaceSource(context.theme);
      const applyGateway = () => handleGatewaySnapshot(context.gateway);
      // Gateway receipts retire profile operations, pairing prompts, and polling before connection or access changes settle.
      const stopGateway = gatewayProjection.subscribe(applyGateway);
      applyGateway();
      if (channelsSource && channelsSource !== context.channels) {
        invalidateNostrForm();
      }
      channelsSource = context.channels;
      const applyChannels = () => {
        if (getContext().channels !== context.channels) {
          return;
        }
        reconcilePairingFilter(context.channels.state.pairingSnapshot);
        pluginPresentation.ensure(context.gateway.snapshot.client);
      };
      // Channel receipts reconcile pairing selections and start presentation loads as channel identities arrive.
      const stopChannels = channelsProjection.subscribe(applyChannels);
      applyChannels();
      schemaLoadStarted = false;
      const applyConfig = () => {
        if (getContext().runtimeConfig === context.runtimeConfig) {
          ensureInitialData();
        }
      };
      // Configuration completion receipts drive the initial channel and schema loading state machine.
      const stopConfig = configProjection.subscribe(applyConfig);
      applyConfig();
      return () => {
        stopGateway();
        stopChannels();
        stopConfig();
      };
    }),
  );
  // Scroll the pairing section only after its requested DOM has committed.
  createEffect(pairingScrollPending, afterRender);
  onSettled(() => listen(document, "visibilitychange", handleVisibilityChange));
  onCleanup(() => {
    active = false;
    if (pairingTimer !== null) {
      clearInterval(pairingTimer);
    }
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
