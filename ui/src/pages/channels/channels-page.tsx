import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
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
import { useApplication } from "../../lib/reactive/context.ts";
import { projectChannels, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { importNostrProfile, parseValidationErrors, putNostrProfile } from "./nostr-profile-ops.ts";
import { ChannelPluginPresentationController } from "./plugin-presentation-controller.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.tsx";
import { ChannelsView, resolveChannelOrder } from "./view.tsx";
import type { ChannelPairingPrompt, ChannelsProps } from "./view.types.ts";
import { runWhatsAppLogoutConfirmation } from "./whatsapp-logout.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

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

/** Owns synchronous presentation state; Solid only observes its revision. */
class ChannelsPageController {
  private nostrProfileFormState: NostrProfileFormState = null;
  private nostrProfileAccountId: string | null = null;
  private selectedChannel: string | null = null;
  private pairingChannelFilter: string | null = null;
  private pairingAccountFilter: string | null = null;
  private pairingPrompt: ChannelPairingPrompt | null = null;
  private pairingNotice: string | null = null;
  private active = true;
  private readonly cleanups: Array<() => void> = [];
  private currentGateway?: ApplicationContext["gateway"];
  private currentClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private pairingTimer: ReturnType<typeof setInterval> | null = null;
  private pairingScrollPending = false;

  constructor(
    private readonly getContext: () => ApplicationContext,
    private readonly host: HTMLElement,
    private readonly notify: () => void,
  ) {
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private get context() {
    return this.getContext();
  }
  private requestUpdate() {
    if (this.active) {
      this.notify();
    }
  }

  private readonly pluginPresentation = new ChannelPluginPresentationController({
    getContext: () => this.context,
    getChannelIds: () => resolveChannelOrder(this.context.channels.state.channelsSnapshot),
    isConnected: () => this.active,
    requestUpdate: () => this.requestUpdate(),
  });

  private readonly wizardHost = new ChannelWizardHost({
    getContext: () => this.context,
    requestUpdate: () => this.requestUpdate(),
    clearSelection: () => (this.selectedChannel = null),
  });

  private schemaLoadStarted = false;
  private channelsSource?: ApplicationContext["channels"];
  private gatewayPairingAuthSignature: string | null = null;
  private readonly gateway = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });

  bindContext(context: ApplicationContext) {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    const gateway = projectGateway(context.gateway);
    const channels = projectChannels(context.channels);
    const config = projectRuntimeConfig(context.runtimeConfig);
    const applyGateway = () => this.handleGatewaySnapshot(context.gateway);
    this.cleanups.push(gateway.subscribe(applyGateway), () => gateway.dispose());
    applyGateway();
    if (this.channelsSource && this.channelsSource !== context.channels) {
      this.invalidateNostrForm();
    }
    this.channelsSource = context.channels;
    const applyChannels = () => {
      if (this.context.channels !== context.channels) {
        return;
      }
      this.reconcilePairingFilter(context.channels.state.pairingSnapshot);
      this.pluginPresentation.ensure(this.context.gateway.snapshot.client);
      this.requestUpdate();
    };
    this.cleanups.push(channels.subscribe(applyChannels), () => channels.dispose());
    applyChannels();
    this.schemaLoadStarted = false;
    const applyConfig = () => {
      if (this.context.runtimeConfig !== context.runtimeConfig) {
        return;
      }
      this.requestUpdate();
      this.ensureInitialData();
    };
    this.cleanups.push(config.subscribe(applyConfig), () => config.dispose());
    applyConfig();
    if (context.theme) {
      const theme = projectTheme(context.theme);
      this.cleanups.push(
        theme.preferences.subscribe(() => this.requestUpdate()),
        () => theme.dispose(),
      );
    }
  }

  private handleGatewaySnapshot(source: ApplicationContext["gateway"]) {
    if (this.context.gateway !== source) {
      return;
    }
    const snapshot = source.snapshot;
    const initial = this.currentGateway === undefined;
    const identityChanged =
      !initial && (this.currentGateway !== source || this.currentClient !== snapshot.client);
    const transportChanged = this.gateway.transition(snapshot);
    if (identityChanged && !transportChanged) {
      this.gateway.invalidate();
    }
    this.currentGateway = source;
    this.currentClient = snapshot.client;
    const pairingAccess = hasOperatorPairingAccess(snapshot.hello?.auth ?? null);
    const pairingAuthSignature = resolveChannelPairingAuthSignature(snapshot);
    const pairingAuthChanged =
      !initial && this.gatewayPairingAuthSignature !== pairingAuthSignature;
    if (identityChanged || snapshot.phase !== "connected") {
      this.clearNostrForm();
    }
    if (identityChanged || transportChanged || snapshot.phase !== "connected") {
      this.pluginPresentation.reset();
    }
    if (identityChanged || pairingAuthChanged || snapshot.phase !== "connected" || !pairingAccess) {
      this.pairingPrompt = null;
      this.setPairingFilter(null, null);
      this.pairingNotice = null;
    }
    this.gatewayPairingAuthSignature = pairingAuthSignature;
    this.syncPairingPolling();
    if (snapshot.phase === "connected" && snapshot.client) {
      if (!initial) {
        this.ensureInitialData();
      }
      if (
        !initial &&
        (identityChanged || transportChanged || pairingAuthChanged) &&
        pairingAccess
      ) {
        void this.context.channels.refreshPairing();
      }
    } else {
      this.schemaLoadStarted = false;
    }
    this.requestUpdate();
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context.gateway.snapshot;
    const client = gateway.client;
    if (gateway.phase !== "connected" || !client) {
      return;
    }

    this.pluginPresentation.ensure(client);

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
    if (!config.configSchema && !config.configSchemaLoading && !this.schemaLoadStarted) {
      this.schemaLoadStarted = true;
      void context.runtimeConfig.ensureSchemaLoaded();
    }
  }

  private readonly handleVisibilityChange = () => {
    if (this.syncPairingPolling()) {
      this.pollPairing();
    }
  };

  private pollPairing() {
    const snapshot = this.context.gateway.snapshot;
    if (
      this.active &&
      document.visibilityState !== "hidden" &&
      snapshot.phase === "connected" &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
    ) {
      void this.context.channels.refreshPairing();
    }
  }

  private syncPairingPolling() {
    const snapshot = this.context.gateway.snapshot;
    const enabled =
      this.active &&
      snapshot.phase === "connected" &&
      snapshot.client &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null) &&
      document.visibilityState !== "hidden";
    if (!enabled) {
      if (this.pairingTimer !== null) {
        clearInterval(this.pairingTimer);
        this.pairingTimer = null;
      }
    } else if (this.pairingTimer === null) {
      this.pairingTimer = setInterval(() => this.pollPairing(), CHANNEL_PAIRING_POLL_INTERVAL_MS);
      return true;
    }
    return false;
  }

  dispose() {
    this.active = false;
    this.wizardHost.cancelOnDisconnect();
    this.syncPairingPolling();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.pluginPresentation.reset();
    this.gateway.dispose();
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
  }

  private setShowAdvancedSettings(enabled: boolean) {
    patchSettings({ showAdvancedSettings: enabled });
    this.context.theme.refresh();
  }

  private async saveChannelConfig() {
    if (await this.context.runtimeConfig.save()) {
      await this.context.channels.refresh(true);
    }
  }

  private async reloadChannelConfig() {
    const context = this.context;
    await context.runtimeConfig.discardDraft({ reloadOnly: true });
    await context.channels.refresh(true);
  }

  private async confirmWhatsAppLogout() {
    const context = this.context;
    const channels = context.channels;
    const scope = this.gateway.capture();
    if (!scope || this.channelsSource !== channels) {
      return;
    }
    await runWhatsAppLogoutConfirmation({
      channels,
      getWizardAccountId: () => this.wizardHost.whatsappAccountId,
      isCurrent: () =>
        this.gateway.isCurrent(scope) &&
        this.context === context &&
        this.channelsSource === channels,
    });
  }

  private clearNostrForm() {
    this.nostrProfileFormState = null;
    this.nostrProfileAccountId = null;
    this.requestUpdate();
  }

  private invalidateNostrForm() {
    this.gateway.invalidate();
    this.clearNostrForm();
  }

  private beginNostrOperation(): NostrOperation | null {
    const gateway = this.currentGateway;
    const channels = this.context.channels;
    let scope = this.gateway.capture();
    if (
      !gateway ||
      !scope ||
      this.channelsSource !== channels ||
      this.context.gateway !== gateway
    ) {
      return null;
    }
    this.gateway.invalidate();
    scope = this.gateway.capture();
    if (!scope) {
      return null;
    }
    const accounts = channels.state.channelsSnapshot?.channelAccounts?.nostr ?? [];
    return {
      scope,
      gateway,
      channels,
      formAccountId: this.nostrProfileAccountId,
      accountId: this.nostrProfileAccountId ?? accounts[0]?.accountId ?? "default",
      authCandidates: resolveControlUiAuthCandidates({
        hello: gateway.snapshot.hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      }),
    };
  }

  private currentNostrForm(operation: NostrOperation): NonNullable<NostrProfileFormState> | null {
    const form = this.nostrProfileFormState;
    if (
      !form ||
      !this.gateway.isCurrent(operation.scope) ||
      this.nostrProfileAccountId !== operation.formAccountId ||
      this.context.gateway !== operation.gateway ||
      this.context.channels !== operation.channels ||
      operation.gateway.snapshot.client !== operation.scope.client
    ) {
      return null;
    }
    return form;
  }

  private editNostrProfile(accountId: string, profile: NostrProfile | null) {
    this.gateway.invalidate();
    this.nostrProfileAccountId = accountId;
    this.nostrProfileFormState = createNostrProfileFormState(profile ?? undefined);
    this.requestUpdate();
  }

  private editNostrForm(
    update: (form: NonNullable<NostrProfileFormState>) => NonNullable<NostrProfileFormState>,
  ) {
    const form = this.nostrProfileFormState;
    if (form) {
      this.nostrProfileFormState = update(form);
      this.requestUpdate();
    }
  }

  private async updateNostrProfile(action: "save" | "import") {
    const form = this.nostrProfileFormState;
    if (!form || form.saving || form.importing) {
      return;
    }
    const operation = this.beginNostrOperation();
    if (!operation) {
      return;
    }
    const busyField = action === "save" ? "saving" : "importing";
    this.nostrProfileFormState = {
      ...form,
      [busyField]: true,
      error: null,
      success: null,
      ...(action === "save" ? { fieldErrors: {} } : {}),
    };

    this.requestUpdate();
    try {
      const request = {
        accountId: operation.accountId,
        authCandidates: operation.authCandidates,
        isCurrent: () => this.currentNostrForm(operation) !== null,
      };
      const result =
        action === "save"
          ? { action, ...(await putNostrProfile({ ...request, values: form.values })) }
          : { action, ...(await importNostrProfile(request)) };
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      const settledForm = { ...currentForm, [busyField]: false, error: null, success: null };
      if (!result.response.ok || result.data?.ok === false || !result.data) {
        this.nostrProfileFormState = {
          ...settledForm,
          error: result.errorMessage,
          ...(result.action === "save"
            ? { fieldErrors: parseValidationErrors(result.data?.details) }
            : {}),
        };
        return;
      }

      if (result.action === "save") {
        if (!result.data.persisted) {
          this.nostrProfileFormState = {
            ...settledForm,
            error: t("channels.nostr.notices.publishFailed"),
          };
          return;
        }
        this.nostrProfileFormState = {
          ...settledForm,
          success: t("channels.nostr.notices.published"),
          fieldErrors: {},
          original: { ...form.values },
        };
      } else {
        const merged = result.data.merged ?? result.data.imported ?? null;
        const values = merged ? { ...currentForm.values, ...merged } : currentForm.values;
        this.nostrProfileFormState = {
          ...settledForm,
          values,
          success: result.data.saved
            ? t("channels.nostr.notices.importedFromRelays")
            : t("channels.nostr.notices.imported"),
          showAdvanced: Boolean(values.banner || values.website || values.nip05 || values.lud16),
        };
      }
      if (result.action === "save" || result.data.saved) {
        await operation.channels.refresh(true);
      }
    } catch (err) {
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      this.nostrProfileFormState = {
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
      };
    } finally {
      this.requestUpdate();
    }
  }

  private reconcilePairingFilter(snapshot: ChannelsPairingListResult | null) {
    if (!snapshot || !this.pairingChannelFilter) {
      return;
    }
    const channelAccounts = snapshot.accounts.filter(
      (account) => account.channel === this.pairingChannelFilter,
    );
    if (channelAccounts.length === 0) {
      this.setPairingFilter(null, null);
      return;
    }
    if (
      this.pairingAccountFilter &&
      !channelAccounts.some((account) => account.accountId === this.pairingAccountFilter)
    ) {
      this.pairingAccountFilter = null;
    }
  }

  private setPairingFilter(channel: string | null, accountId: string | null) {
    this.pairingChannelFilter = channel;
    this.pairingAccountFilter = channel ? accountId : null;
    this.requestUpdate();
  }

  private reviewPairingAccount(channel: string, accountId: string) {
    this.selectedChannel = null;
    this.setPairingFilter(channel, accountId);
    this.pairingScrollPending = true;
  }

  afterRender() {
    if (!this.pairingScrollPending || !this.active) {
      return;
    }
    this.pairingScrollPending = false;
    this.host.querySelector("#channels-pairing-requests")?.scrollIntoView({
      behavior: resolveScrollBehavior(),
      block: "start",
    });
  }

  private openPairingPrompt(kind: ChannelPairingPrompt["kind"], request: ChannelsPairingRequest) {
    if (this.context.channels.state.pairingBusyRequestId) {
      return;
    }
    this.pairingNotice = null;
    this.pairingPrompt = {
      kind,
      request,
      notify: false,
      bootstrapCommandOwner: false,
    };
    this.requestUpdate();
  }

  private patchPairingPrompt(
    patch: Partial<Pick<ChannelPairingPrompt, "notify" | "bootstrapCommandOwner">>,
  ) {
    if (!this.pairingPrompt) {
      return;
    }
    this.pairingPrompt = { ...this.pairingPrompt, ...patch };
    this.requestUpdate();
  }

  private async confirmPairingPrompt() {
    const prompt = this.pairingPrompt;
    if (!prompt) {
      return;
    }
    const target = {
      channel: prompt.request.channel,
      accountId: prompt.request.accountId,
      requestId: prompt.request.requestId,
    };
    if (prompt.kind === "dismiss") {
      const dismissed = await this.context.channels.dismissPairing(target);
      if (dismissed && this.pairingPrompt === prompt) {
        this.pairingPrompt = null;
        this.pairingNotice = t("channels.pairing.dismissedNotice");
        this.requestUpdate();
      }
      return;
    }

    const result = await this.context.channels.approvePairing({
      ...target,
      notify: prompt.notify,
      bootstrapCommandOwner: prompt.bootstrapCommandOwner,
    });
    if (!result || this.pairingPrompt !== prompt) {
      return;
    }
    this.pairingPrompt = null;
    this.pairingNotice = t(
      result.commandOwnerBootstrap === "unavailable"
        ? result.notification === "failed"
          ? "channels.pairing.approvedFollowupsFailedNotice"
          : "channels.pairing.approvedOwnerFailedNotice"
        : result.notification === "failed"
          ? "channels.pairing.approvedNotificationFailedNotice"
          : result.commandOwnerBootstrap === "configured"
            ? "channels.pairing.approvedOwnerNotice"
            : "channels.pairing.approvedNotice",
    );
    this.requestUpdate();
  }

  get viewProps(): ChannelsProps {
    const context = this.context;
    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    const auth = context.gateway.snapshot.hello?.auth ?? null;
    const canManagePairing = hasOperatorPairingAccess(auth);
    const canAdmin = hasOperatorAdminAccess(auth);
    return {
      channels,
      config,
      presentation: this.pluginPresentation,
      wizardHost: this.wizardHost,
      pairingChannelFilter: this.pairingChannelFilter,
      pairingAccountFilter: this.pairingAccountFilter,
      pairingPrompt: this.pairingPrompt,
      pairingNotice: this.pairingNotice,
      canManagePairing,
      canAdmin,
      showAdvancedSettings: loadSettings().showAdvancedSettings === true,
      nostrProfileFormState: this.nostrProfileFormState,
      nostrProfileAccountId: this.nostrProfileAccountId,
      selectedChannel: this.selectedChannel,
      onShowDetail: (channelId) => {
        this.selectedChannel = channelId;
        this.requestUpdate();
      },
      onCloseDetail: () => {
        this.selectedChannel = null;
        this.requestUpdate();
      },
      onStartSetup: (channelId) => {
        if (canAdmin) {
          this.wizardHost.startSetup(channelId);
        }
      },
      onRefresh: (probe) => void context.channels.refresh(probe),
      onPairingRefresh: () => void context.channels.refreshPairing(),
      onPairingFilterChange: (channel, accountId) => this.setPairingFilter(channel, accountId),
      onPairingReviewAccount: (channel, accountId) => this.reviewPairingAccount(channel, accountId),
      onPairingApprove: (request) => this.openPairingPrompt("approve", request),
      onPairingDismiss: (request) => this.openPairingPrompt("dismiss", request),
      onPairingPromptChange: (patch) => this.patchPairingPrompt(patch),
      onPairingPromptCancel: () => {
        this.pairingPrompt = null;
        this.requestUpdate();
      },
      onPairingPromptConfirm: () => void this.confirmPairingPrompt(),
      onWhatsAppStart: (force) =>
        void context.channels.startWhatsApp(force, this.wizardHost.whatsappAccountId),
      onWhatsAppWait: () => void context.channels.waitWhatsApp(this.wizardHost.whatsappAccountId),
      onWhatsAppLogout: () => void this.confirmWhatsAppLogout(),
      onShowAdvancedSettings: (enabled) => this.setShowAdvancedSettings(enabled),
      onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
      onConfigSave: () => void this.saveChannelConfig(),
      onConfigReload: () => void this.reloadChannelConfig(),
      onNostrProfileEdit: (accountId, profile) => this.editNostrProfile(accountId, profile),
      onNostrProfileCancel: () => this.invalidateNostrForm(),
      onNostrProfileFieldChange: (field, value) =>
        this.editNostrForm((form) => ({
          ...form,
          values: { ...form.values, [field]: value },
          fieldErrors: { ...form.fieldErrors, [field]: "" },
        })),
      onNostrProfileSave: () => void this.updateNostrProfile("save"),
      onNostrProfileImport: () => void this.updateNostrProfile("import"),
      onNostrProfileToggleAdvanced: () =>
        this.editNostrForm((form) => ({ ...form, showAdvanced: !form.showAdvanced })),
    };
  }
}

export function ChannelsPage(props: { host: HTMLElement; context?: ApplicationContext }) {
  const application = untrack(() => props.context) ? undefined : useApplication();
  const host = untrack(() => props.host);
  const context = () => props.context ?? application!;
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const controller = new ChannelsPageController(
    () => untrack(context),
    host,
    () => setRevision((value) => value + 1),
  );
  createEffect(context, (value) => controller.bindContext(value));
  onCleanup(() => controller.dispose());
  createEffect(revision, () => controller.afterRender());
  const viewProps = createMemo(() => {
    revision();
    return controller.viewProps;
  });
  return (
    <>
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
    </>
  );
}

// Module re-evaluation can retain the shared custom-element registry.
if (!customElements.get("openclaw-channels-page")) {
  defineSolidBridge("openclaw-channels-page", (_props, host) => <ChannelsPage host={host} />, {
    properties: {},
  });
}
