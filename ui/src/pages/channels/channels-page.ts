import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { NostrProfile } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.ts";
import { renderChannels } from "./view.ts";
import { ChannelWizardController } from "./wizard-controller.ts";

type NostrProfileFormState = ReturnType<typeof createNostrProfileFormState> | null;

type NostrOperation = {
  generation: number;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  client: GatewayBrowserClient;
  formAccountId: string | null;
  accountId: string;
  headers: Record<string, string>;
};

function parseValidationErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = message;
    }
  }
  return errors;
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

class ChannelsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state()
  private nostrProfileFormState: NostrProfileFormState = null;

  @state()
  private nostrProfileAccountId: string | null = null;

  @state()
  private selectedChannel: string | null = null;

  @state()
  private wizardMultiselect: unknown[] = [];

  private wizardMultiselectStepId: string | null = null;

  private readonly wizardController = new ChannelWizardController(
    () => this.context?.gateway.snapshot.client ?? null,
    () => {
      // Pending multiselect toggles survive busy re-renders but reset per step.
      const wizard = this.wizardController.state;
      const stepId = wizard.phase === "step" ? wizard.step.id : null;
      if (stepId !== this.wizardMultiselectStepId) {
        this.wizardMultiselectStepId = stepId;
        const initial =
          wizard.phase === "step" && Array.isArray(wizard.step.initialValue)
            ? [...wizard.step.initialValue]
            : [];
        this.wizardMultiselect = initial;
      }
      if (wizard.phase === "done" && this.lastWizardPhase !== "done") {
        void this.handleWizardCompleted(wizard.channel);
      }
      this.lastWizardPhase = wizard.phase;
      this.requestUpdate();
    },
  );

  private lastWizardPhase = "idle";

  private async handleWizardCompleted(channel: string | null) {
    const context = this.context;
    if (!context) {
      return;
    }
    // The wizard rewrote openclaw.json on the gateway; resync the local draft.
    await context.runtimeConfig.refresh({ discardPendingChanges: true });
    await context.channels.refresh(true);
    if (channel === "whatsapp") {
      // Jump straight into QR pairing; the wizard modal renders the QR phase.
      await context.channels.startWhatsApp(false);
    }
  }

  private startSetup(channel: string | null) {
    this.selectedChannel = null;
    void this.wizardController.start(channel);
  }

  private closeWizard() {
    const wasActive = this.wizardController.state.phase !== "idle";
    void this.wizardController.cancel();
    if (wasActive) {
      void this.context?.channels.refresh(true);
    }
  }

  private toggleWizardMultiselect(value: unknown) {
    this.wizardMultiselect = this.wizardMultiselect.includes(value)
      ? this.wizardMultiselect.filter((entry) => entry !== value)
      : [...this.wizardMultiselect, value];
  }

  private schemaLoadStarted = false;
  private gatewaySource?: ApplicationContext["gateway"];
  private channelsSource?: ApplicationContext["channels"];
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private hasGatewaySnapshot = false;
  private nostrOperationGeneration = 0;

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.channels,
      (channels) => {
        const sourceChanged = this.channelsSource !== undefined && this.channelsSource !== channels;
        this.channelsSource = channels;
        if (sourceChanged) {
          this.invalidateNostrForm();
        }
        const handleChange = () => {
          if (this.channelsSource === channels) {
            this.requestUpdate();
          }
        };
        handleChange();
        return channels.subscribe(handleChange);
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.schemaLoadStarted = false;
        const handleChange = () => {
          if (this.context.runtimeConfig !== runtimeConfig) {
            return;
          }
          this.requestUpdate();
          this.ensureInitialData();
        };
        handleChange();
        const unsubscribe = runtimeConfig.subscribe(handleChange);
        return () => {
          unsubscribe();
          this.schemaLoadStarted = false;
        };
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        this.gatewaySource = gateway;
        this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
        return gateway.subscribe((snapshot) => {
          if (this.gatewaySource !== gateway) {
            return;
          }
          this.applyGatewaySnapshot(snapshot, false);
        });
      },
    );

  private applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    sourceChanged: boolean,
  ) {
    const clientChanged = this.hasGatewaySnapshot && this.gatewayClient !== snapshot.client;
    const connectionChanged =
      this.hasGatewaySnapshot && this.gatewayConnected !== snapshot.connected;
    if (!this.hasGatewaySnapshot || sourceChanged || clientChanged || connectionChanged) {
      this.nostrOperationGeneration += 1;
    }
    if (sourceChanged || clientChanged || !snapshot.connected) {
      this.clearNostrForm();
    }
    this.hasGatewaySnapshot = true;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (snapshot.connected && snapshot.client) {
      this.ensureInitialData();
    } else {
      this.schemaLoadStarted = false;
    }
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context.gateway.snapshot;
    const client = gateway.client;
    if (!gateway.connected || !client) {
      return;
    }

    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    if (!channels.channelsSnapshot && !channels.channelsLoading) {
      void context.channels.refresh(false);
    }
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
    if (!config.configSchema && !config.configSchemaLoading && !this.schemaLoadStarted) {
      this.schemaLoadStarted = true;
      void context.runtimeConfig.ensureSchemaLoaded();
    }
  }

  override disconnectedCallback() {
    // Cancel (not just reset): the gateway keeps a running WizardSession and
    // rejects future wizard.start calls until it is cancelled or purged.
    void this.wizardController.cancel();
    this.selectedChannel = null;
    this.gatewaySource = undefined;
    this.channelsSource = undefined;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.hasGatewaySnapshot = false;
    this.invalidateNostrForm();
    this.subscriptions.clear();
    this.schemaLoadStarted = false;
    super.disconnectedCallback();
  }

  private async saveChannelConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    const saved = await context.runtimeConfig.save();
    const saveError = context.runtimeConfig.state.lastError;
    if (!saved) {
      await context.runtimeConfig.refresh();
      if (saveError && !context.runtimeConfig.state.lastError) {
        context.runtimeConfig.state.lastError = saveError;
      }
      this.requestUpdate();
      return;
    }
    await context.channels.refresh(true);
  }

  private async reloadChannelConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    await context.runtimeConfig.refresh({ discardPendingChanges: true });
    await context.channels.refresh(true);
  }

  private resolveNostrAccountId(): string {
    const accounts = this.context?.channels.state.channelsSnapshot?.channelAccounts?.nostr ?? [];
    return this.nostrProfileAccountId ?? accounts[0]?.accountId ?? "default";
  }

  private buildGatewayHttpHeaders(gateway: ApplicationContext["gateway"]): Record<string, string> {
    const authorization = resolveControlUiAuthHeader({
      hello: gateway.snapshot.hello,
      settings: { token: gateway.connection.token },
      password: gateway.connection.password,
    });
    return authorization ? { Authorization: authorization } : {};
  }

  private clearNostrForm() {
    this.nostrProfileFormState = null;
    this.nostrProfileAccountId = null;
  }

  private invalidateNostrForm() {
    this.nostrOperationGeneration += 1;
    this.clearNostrForm();
  }

  private beginNostrOperation(): NostrOperation | null {
    const gateway = this.context.gateway;
    const channels = this.context.channels;
    const client = gateway.snapshot.client;
    if (
      !this.isConnected ||
      this.gatewaySource !== gateway ||
      this.channelsSource !== channels ||
      !gateway.snapshot.connected ||
      !client
    ) {
      return null;
    }
    const generation = this.nostrOperationGeneration + 1;
    this.nostrOperationGeneration = generation;
    return {
      generation,
      gateway,
      channels,
      client,
      formAccountId: this.nostrProfileAccountId,
      accountId: this.resolveNostrAccountId(),
      headers: this.buildGatewayHttpHeaders(gateway),
    };
  }

  private currentNostrForm(operation: NostrOperation): NonNullable<NostrProfileFormState> | null {
    const form = this.nostrProfileFormState;
    if (
      !form ||
      !this.isConnected ||
      this.nostrOperationGeneration !== operation.generation ||
      this.nostrProfileAccountId !== operation.formAccountId ||
      this.context.gateway !== operation.gateway ||
      this.context.channels !== operation.channels ||
      operation.gateway.snapshot.client !== operation.client ||
      !operation.gateway.snapshot.connected
    ) {
      return null;
    }
    return form;
  }

  private editNostrProfile(accountId: string, profile: NostrProfile | null) {
    this.nostrOperationGeneration += 1;
    this.nostrProfileAccountId = accountId;
    this.nostrProfileFormState = createNostrProfileFormState(profile ?? undefined);
  }

  private cancelNostrProfile() {
    this.invalidateNostrForm();
  }

  private changeNostrProfileField(field: keyof NostrProfile, value: string) {
    const form = this.nostrProfileFormState;
    if (!form) {
      return;
    }
    this.nostrProfileFormState = {
      ...form,
      values: { ...form.values, [field]: value },
      fieldErrors: { ...form.fieldErrors, [field]: "" },
    };
  }

  private toggleNostrProfileAdvanced() {
    const form = this.nostrProfileFormState;
    if (!form) {
      return;
    }
    this.nostrProfileFormState = { ...form, showAdvanced: !form.showAdvanced };
  }

  private async saveNostrProfile() {
    const form = this.nostrProfileFormState;
    if (!form || form.saving || form.importing) {
      return;
    }
    const operation = this.beginNostrOperation();
    if (!operation) {
      return;
    }
    const pendingForm = {
      ...form,
      saving: true,
      error: null,
      success: null,
      fieldErrors: {},
    };
    this.nostrProfileFormState = pendingForm;

    try {
      const response = await fetch(buildNostrProfileUrl(operation.accountId), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...operation.headers,
        },
        body: JSON.stringify(form.values),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        details?: unknown;
        persisted?: boolean;
      } | null;

      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      if (!response.ok || data?.ok === false || !data) {
        this.nostrProfileFormState = {
          ...currentForm,
          saving: false,
          error: data?.error ?? `Profile update failed (${response.status})`,
          success: null,
          fieldErrors: parseValidationErrors(data?.details),
        };
        return;
      }

      if (!data.persisted) {
        this.nostrProfileFormState = {
          ...currentForm,
          saving: false,
          error: "Profile publish failed on all relays.",
          success: null,
        };
        return;
      }

      this.nostrProfileFormState = {
        ...currentForm,
        saving: false,
        error: null,
        success: "Profile published to relays.",
        fieldErrors: {},
        original: { ...form.values },
      };
      await operation.channels.refresh(true);
    } catch (err) {
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      this.nostrProfileFormState = {
        ...currentForm,
        saving: false,
        error: `Profile update failed: ${String(err)}`,
        success: null,
      };
    }
  }

  private async importNostrProfile() {
    const form = this.nostrProfileFormState;
    if (!form || form.importing || form.saving) {
      return;
    }
    const operation = this.beginNostrOperation();
    if (!operation) {
      return;
    }
    this.nostrProfileFormState = {
      ...form,
      importing: true,
      error: null,
      success: null,
    };

    try {
      const response = await fetch(buildNostrProfileUrl(operation.accountId, "/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...operation.headers,
        },
        body: JSON.stringify({ autoMerge: true }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        imported?: NostrProfile;
        merged?: NostrProfile;
        saved?: boolean;
      } | null;

      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      if (!response.ok || data?.ok === false || !data) {
        this.nostrProfileFormState = {
          ...currentForm,
          importing: false,
          error: data?.error ?? `Profile import failed (${response.status})`,
          success: null,
        };
        return;
      }

      const merged = data.merged ?? data.imported ?? null;
      const values = merged ? { ...currentForm.values, ...merged } : currentForm.values;
      this.nostrProfileFormState = {
        ...currentForm,
        importing: false,
        values,
        error: null,
        success: data.saved
          ? "Profile imported from relays. Review and publish."
          : "Profile imported. Review and publish.",
        showAdvanced: Boolean(values.banner || values.website || values.nip05 || values.lud16),
      };

      if (data.saved) {
        await operation.channels.refresh(true);
      }
    } catch (err) {
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      this.nostrProfileFormState = {
        ...currentForm,
        importing: false,
        error: `Profile import failed: ${String(err)}`,
        success: null,
      };
    }
  }

  override render() {
    const context = this.context;
    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("channels")}</div>
          <div class="page-sub">${subtitleForRoute("channels")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderChannels({
          connected: channels.connected,
          loading: channels.channelsLoading,
          snapshot: channels.channelsSnapshot,
          lastError: channels.channelsError,
          lastSuccessAt: channels.channelsLastSuccess,
          whatsappMessage: channels.whatsappLoginMessage,
          whatsappQrDataUrl: channels.whatsappLoginQrDataUrl,
          whatsappConnected: channels.whatsappLoginConnected,
          whatsappBusy: channels.whatsappBusy,
          configSchema: config.configSchema,
          configSchemaLoading: config.configSchemaLoading,
          configForm: config.configForm,
          configUiHints: config.configUiHints,
          configSaving: config.configSaving,
          configFormDirty: config.configFormDirty,
          nostrProfileFormState: this.nostrProfileFormState,
          nostrProfileAccountId: this.nostrProfileAccountId,
          selectedChannel: this.selectedChannel,
          wizard: this.wizardController.state,
          wizardMultiselect: this.wizardMultiselect,
          onShowDetail: (channelId) => {
            this.selectedChannel = channelId;
          },
          onCloseDetail: () => {
            this.selectedChannel = null;
          },
          onStartSetup: (channelId) => this.startSetup(channelId),
          onWizardAnswer: (value) => void this.wizardController.answer(value),
          onWizardToggleMultiselect: (value) => this.toggleWizardMultiselect(value),
          onWizardClose: () => this.closeWizard(),
          onRefresh: (probe) => void context.channels.refresh(probe),
          onWhatsAppStart: (force) => void context.channels.startWhatsApp(force),
          onWhatsAppWait: () => void context.channels.waitWhatsApp(),
          onWhatsAppLogout: () => void context.channels.logoutWhatsApp(),
          onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
          onConfigSave: () => void this.saveChannelConfig(),
          onConfigReload: () => void this.reloadChannelConfig(),
          onNostrProfileEdit: (accountId, profile) => this.editNostrProfile(accountId, profile),
          onNostrProfileCancel: () => this.cancelNostrProfile(),
          onNostrProfileFieldChange: (field, value) => this.changeNostrProfileField(field, value),
          onNostrProfileSave: () => void this.saveNostrProfile(),
          onNostrProfileImport: () => void this.importNostrProfile(),
          onNostrProfileToggleAdvanced: () => this.toggleNostrProfileAdvanced(),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-channels-page")) {
  customElements.define("openclaw-channels-page", ChannelsPage);
}
