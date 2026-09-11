import { consume } from "@lit/context";
// Controller for the curated Talk settings page. Owns the talk.catalog read
// that feeds the provider/model/voice pickers; all writes go through the shared
// config form draft so the embedded schema editor below stays in sync.
import type { DictationCatalogResult, TalkCatalogResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  isTalkGptLiveModel,
  resolveTalkRealtimeSelection,
  talkProviderRejectsTransport,
} from "./talk-schema.ts";
import {
  effectiveTalkValues,
  renderTalk,
  dictationProviderConfigKeys,
  selectedDictationProviderOption,
  selectedTalkProviderOption,
  talkProviderConfigKeys,
  type TalkCatalogState,
  type DictationCatalogState,
  type DictationSelection,
  type DictationProviderOption,
  type TalkRealtimeProviderOption,
} from "./talk.ts";
import { voiceWakeOwner } from "./voice-wake-owner.ts";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ConfigSnapshot = ApplicationContext["runtimeConfig"]["state"]["configSnapshot"];

function configRevisionToken(snapshot: ConfigSnapshot): string | null {
  return snapshot?.configRevisionHash ?? snapshot?.hash ?? null;
}

/**
 * One gateway connection phase; object identity is the request generation so a
 * catalog load that started under an older phase is dropped, never applied
 * (same shape as memory-page.ts).
 */
type CatalogConnection = {
  gatewayUrl: string;
  client: GatewayClient | null;
  connected: boolean;
  voiceWake: boolean;
};

type ModelDefaultResetIntent = {
  gatewayUrl: string;
  configRevision: string | null;
};

type TalkPageProps = {
  configObject: Record<string, unknown>;
  mutationDisabled: boolean;
  /** Builds the embedded schema editor over the full `talk` section. */
  buildEditor: () => TemplateResult;
};

function toProviderOption(
  provider: TalkCatalogResult["realtime"]["providers"][number],
): TalkRealtimeProviderOption {
  return {
    id: provider.id,
    label: provider.label,
    configured: provider.configured,
    aliases: provider.aliases ?? [],
    models: provider.models ?? [],
    voices: provider.voices ?? [],
    activeVoices: provider.activeVoices,
    activeVoiceSelectionPolicy: provider.activeVoiceSelectionPolicy,
    voicesByModel: provider.voicesByModel,
    transports: provider.transports ?? [],
    defaultModel: provider.defaultModel ?? null,
  };
}

function toDictationProviderOption(
  provider: DictationCatalogResult["providers"][number],
): DictationProviderOption {
  return {
    id: provider.id,
    label: provider.label,
    configured: provider.configured,
    aliases: provider.aliases ?? [],
    models: provider.models ?? [],
    defaultModel: provider.defaultModel ?? null,
  };
}

function resolveDictationSelection(configObject: Record<string, unknown>): DictationSelection {
  const dictation = asOptionalRecord(configObject.dictation) ?? {};
  const rawProviders = asOptionalRecord(dictation.providers);
  const providerEntries: Record<string, { endpoint?: string; model?: string }> = {};
  if (rawProviders) {
    for (const [providerId, rawEntry] of Object.entries(rawProviders)) {
      const entry = asOptionalRecord(rawEntry);
      if (!entry) {
        continue;
      }
      providerEntries[providerId] = {
        ...(typeof entry.endpoint === "string" ? { endpoint: entry.endpoint } : {}),
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
      };
    }
  }
  const provider = typeof dictation.provider === "string" ? dictation.provider : null;
  let model = typeof dictation.model === "string" ? dictation.model : null;
  let endpoint: string | null = null;
  const selectedEntry = provider
    ? providerEntries[provider]
    : Object.keys(providerEntries).length === 1
      ? Object.values(providerEntries)[0]
      : undefined;
  if (selectedEntry) {
    model ??= selectedEntry.model ?? null;
    endpoint ??= selectedEntry.endpoint ?? null;
  }
  return { provider, model, endpoint, providerEntries };
}

/** Transports whose sessions are client-owned (`talk.client.create`). */
const TALK_CLIENT_OWNED_TRANSPORTS = new Set(["webrtc", "provider-websocket"]);

function gptLiveRejectsTransport(model: string | null, transport: string): boolean {
  return isTalkGptLiveModel(model) && transport === "provider-websocket";
}

// Drafts and write ordering belong to the application Gateway, not a route

class TalkSettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property({ type: Boolean }) mutationDisabled = false;
  @property({ attribute: false }) buildEditor: TalkPageProps["buildEditor"] = () => html``;

  @state() private catalog: TalkCatalogState = { kind: "unavailable" };
  @state() private dictationCatalog: DictationCatalogState = { kind: "unavailable" };
  @state() private modelDefaultResetIntent: ModelDefaultResetIntent | null = null;

  private connection: CatalogConnection | null = null;
  private catalogRequestId = 0;
  /** `undefined` = baseline not yet observed; `null` = no public revision token. */
  private lastCatalogConfigRevision: string | null | undefined;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => (this.context?.gateway ? voiceWakeOwner(this.context.gateway) : undefined),
      (owner, notify) => owner.subscribe(notify),
    )
    .watch(
      () => this.context?.nativeDeviceSettings,
      (capability, notify) => capability.subscribe(notify),
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) =>
        this.syncCatalog(
          gateway.connection.gatewayUrl,
          gateway.snapshot.client,
          gateway.snapshot.phase === "connected",
          isGatewayMethodAdvertised(gateway.snapshot, "voicewake.get") === true &&
            isGatewayMethodAdvertised(gateway.snapshot, "voicewake.set") === true,
        ),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => this.refreshCatalogOnConfigChange(runtimeConfig.state),
    );

  // Provider credential readiness can change outside the config editor without
  // advancing the config hash, so window focus refreshes the catalog.
  private readonly refreshOnFocus = () => {
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("focus", this.refreshOnFocus);
  }

  override disconnectedCallback() {
    window.removeEventListener("focus", this.refreshOnFocus);
    voiceWakeOwner(this.context.gateway).flush();
    this.subscriptions.clear();
    this.connection = null;
    this.catalog = { kind: "unavailable" };
    super.disconnectedCallback();
  }

  private syncCatalog(
    gatewayUrl: string,
    client: GatewayClient | null,
    connected: boolean,
    voiceWake: boolean,
  ) {
    if (this.modelDefaultResetIntent && this.modelDefaultResetIntent.gatewayUrl !== gatewayUrl) {
      this.modelDefaultResetIntent = null;
    }
    // connecting -> connected keeps the same client object; keying only on the
    // client would leave a page mounted mid-handshake without a catalog.
    if (
      this.connection?.gatewayUrl === gatewayUrl &&
      this.connection.client === client &&
      this.connection.connected === connected &&
      this.connection.voiceWake === voiceWake
    ) {
      return;
    }
    const connection: CatalogConnection = {
      gatewayUrl,
      client,
      connected,
      voiceWake,
    };
    this.connection = connection;
    if (!client || !connected) {
      this.catalog = { kind: "unavailable" };
      this.dictationCatalog = { kind: "unavailable" };
      return;
    }
    this.catalog = { kind: "loading" };
    this.dictationCatalog = { kind: "loading" };
    void this.loadCatalog(client, connection);
  }

  private async loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    // Initial load, config-hash refresh, and focus refresh can overlap on the
    // same connection; only the newest request may write the catalog, or a
    // slow older response would overwrite a fresher one.
    const requestId = ++this.catalogRequestId;
    try {
      const [talkResult, dictationResult] = await Promise.allSettled([
        client.request<TalkCatalogResult>("talk.catalog", {}),
        client.request<DictationCatalogResult>("dictation.catalog", {}),
      ]);
      if (talkResult.status === "fulfilled") {
        const applied = this.applyCatalog(connection, requestId, {
          kind: "ready",
          ready: talkResult.value.realtime.ready === true,
          activeProvider: talkResult.value.realtime.activeProvider ?? null,
          providers: talkResult.value.realtime.providers.map(toProviderOption),
        });
        if (applied) {
          this.acknowledgeModelDefaultReset(connection);
        }
      } else {
        this.applyCatalog(connection, requestId, { kind: "unavailable" });
      }
      if (dictationResult.status === "fulfilled") {
        this.applyDictationCatalog(connection, requestId, {
          kind: "ready",
          ready: dictationResult.value.ready === true,
          activeProvider: dictationResult.value.activeProvider ?? null,
          providers: dictationResult.value.providers.map(toDictationProviderOption),
        });
      } else {
        this.applyDictationCatalog(connection, requestId, { kind: "unavailable" });
      }
    } catch {
      this.applyCatalog(connection, requestId, { kind: "unavailable" });
      this.applyDictationCatalog(connection, requestId, { kind: "unavailable" });
    }
  }

  private applyCatalog(
    connection: CatalogConnection,
    requestId: number,
    catalog: TalkCatalogState,
  ): boolean {
    if (
      !this.isConnected ||
      this.connection !== connection ||
      this.catalogRequestId !== requestId
    ) {
      return false;
    }
    this.catalog = catalog;
    return true;
  }

  private applyDictationCatalog(
    connection: CatalogConnection,
    requestId: number,
    catalog: DictationCatalogState,
  ): boolean {
    if (
      !this.isConnected ||
      this.connection !== connection ||
      this.catalogRequestId !== requestId
    ) {
      return false;
    }
    this.dictationCatalog = catalog;
    return true;
  }

  private acknowledgeModelDefaultReset(connection: CatalogConnection) {
    const intent = this.modelDefaultResetIntent;
    const configRevision = this.lastCatalogConfigRevision;
    // Without a public revision token, a ready catalog cannot prove the reset
    // was applied; retain provider-default metadata until an authoritative ack.
    if (configRevision == null) {
      return;
    }
    if (intent?.gatewayUrl === connection.gatewayUrl && intent.configRevision !== configRevision) {
      this.modelDefaultResetIntent = null;
    }
  }

  /**
   * Readiness can change on the same connection when a config write lands (the
   * gateway may hot-apply talk config without dropping the socket), so the
   * catalog re-reads whenever the public config revision advances. The revision
   * is the durable ack signal; transient saving flags can be skipped entirely
   * by a fast save.
   */
  private refreshCatalogOnConfigChange(configState: ApplicationContext["runtimeConfig"]["state"]) {
    const configRevision = configRevisionToken(configState.configSnapshot);
    if (this.lastCatalogConfigRevision === undefined) {
      this.lastCatalogConfigRevision = configRevision;
      return;
    }
    if (configRevision === null || configRevision === this.lastCatalogConfigRevision) {
      return;
    }
    this.lastCatalogConfigRevision = configRevision;
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  }

  /**
   * The pickers advertise "Provider default", so a null pick must clear every
   * key that could keep supplying the old value: the top-level override, the
   * legacy speakerVoiceId spelling, and the selected provider's own entry
   * (matched by configured spelling, canonical id, and aliases). Removing only
   * the top-level key would make Default a no-op over provider-level config.
   */
  private changeModel(model: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    if (model !== null) {
      this.modelDefaultResetIntent = null;
      runtimeConfig.patchForm(["talk", "realtime", "model"], model);
      const selection = this.liveSelection();
      const transport = selection.transport;
      const provider = selectedTalkProviderOption(this.catalog, selection);
      const rejectsTransport =
        transport !== null &&
        (gptLiveRejectsTransport(model, transport) ||
          talkProviderRejectsTransport(provider?.transports, transport));
      // Preserve configured transports unless the selected provider positively
      // advertises that it cannot serve them.
      if (isTalkGptLiveModel(model) && rejectsTransport) {
        runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
      } else if (
        provider?.id === "openai" &&
        isTalkGptLiveModel(model) &&
        transport === "gateway-relay" &&
        selection.consultRouting === "force-agent-consult"
      ) {
        runtimeConfig.removeFormValue(["talk", "realtime", "consultRouting"]);
      }
      return;
    }
    this.modelDefaultResetIntent = {
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      configRevision: configRevisionToken(runtimeConfig.state.configSnapshot),
    };
    runtimeConfig.removeFormValue(["talk", "realtime", "model"]);
    for (const key of this.selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "model"]);
    }
  }

  private changeVoice(voice: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    if (voice !== null) {
      runtimeConfig.patchForm(["talk", "realtime", "speakerVoice"], voice);
      return;
    }
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoice"]);
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoiceId"]);
    for (const key of this.selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "speakerVoice"]);
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "voice"]);
    }
  }

  private selectedProviderConfigKeys(): string[] {
    const selection = this.liveSelection();
    const option = selectedTalkProviderOption(this.catalog, selection);
    return talkProviderConfigKeys(selection, option);
  }

  /**
   * Mutation helpers must read the live form draft, not the configObject prop:
   * the form updates immutably and the prop only refreshes on the next render,
   * so a same-tick read through the prop sees pre-write values.
   */
  private liveSelection() {
    const form = this.context.runtimeConfig.state.configForm;
    const configObject = asOptionalRecord(form) ?? this.configObject;
    return resolveTalkRealtimeSelection(configObject);
  }

  private liveDictationSelection(): DictationSelection {
    const form = this.context.runtimeConfig.state.configForm;
    const configObject = asOptionalRecord(form) ?? this.configObject;
    return resolveDictationSelection(configObject);
  }

  private changeDictationProvider(providerId: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    const selection = this.liveDictationSelection();
    const option =
      providerId && this.dictationCatalog.kind === "ready"
        ? this.dictationCatalog.providers.find(
            (entry) => entry.id === providerId || entry.aliases.includes(providerId),
          )
        : undefined;
    const configuredKey =
      providerId &&
      Object.keys(selection.providerEntries).find(
        (key) =>
          key === providerId ||
          option?.aliases.includes(key) === true ||
          key.toLowerCase() === providerId.toLowerCase(),
      );
    const nextProvider = configuredKey ?? providerId;
    runtimeConfig.removeFormValue(["dictation", "model"]);
    if (providerId === null) {
      if (Object.keys(selection.providerEntries).length <= 1) {
        runtimeConfig.removeFormValue(["dictation", "provider"]);
      }
    } else {
      runtimeConfig.patchForm(["dictation", "provider"], nextProvider);
      if (!configuredKey && Object.keys(selection.providerEntries).length > 0) {
        runtimeConfig.patchForm(["dictation", "providers", providerId], {});
      }
    }
  }

  private changeDictationModel(model: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    if (model === null) {
      this.context.runtimeConfig.removeFormValue(["dictation", "model"]);
      // Reset to Default must also clear the selected provider's own model
      // override: otherwise both the renderer and the Gateway keep using
      // dictation.providers.<id>.model and the reset silently does nothing.
      // Only the selected provider's entry is cleared; every other provider
      // keeps its stored model (mirrors the endpoint reset below).
      const selection = this.liveDictationSelection();
      const option = selectedDictationProviderOption(this.dictationCatalog, selection);
      const providerId =
        dictationProviderConfigKeys(selection, option)[0] ?? selection.provider ?? option?.id;
      if (providerId) {
        this.context.runtimeConfig.removeFormValue(["dictation", "providers", providerId, "model"]);
      }
    } else {
      this.context.runtimeConfig.patchForm(["dictation", "model"], model);
    }
  }

  private changeDictationEndpoint(endpoint: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    const selection = this.liveDictationSelection();
    const option = selectedDictationProviderOption(this.dictationCatalog, selection);
    const providerId =
      dictationProviderConfigKeys(selection, option)[0] ?? selection.provider ?? option?.id;
    if (!providerId) {
      return;
    }
    if (endpoint === null) {
      this.context.runtimeConfig.removeFormValue([
        "dictation",
        "providers",
        providerId,
        "endpoint",
      ]);
    } else {
      this.context.runtimeConfig.patchForm(
        ["dictation", "providers", providerId, "endpoint"],
        endpoint,
      );
    }
  }

  /**
   * Model and voice picks are provider-coupled, so a provider switch clears
   * those top-level overrides. Transport survives when the target provider
   * advertises it; an unavailable catalog is not evidence of incompatibility.
   * Each provider's own entry survives and supplies its fallback values.
   */
  private changeProvider(providerId: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    this.modelDefaultResetIntent = null;
    const runtimeConfig = this.context.runtimeConfig;
    const selection = this.liveSelection();
    for (const key of ["model", "speakerVoice", "speakerVoiceId"]) {
      runtimeConfig.removeFormValue(["talk", "realtime", key]);
    }
    if (providerId === null) {
      // Auto keeps the current transport: it was valid for the configuration
      // auto-selection will re-derive from (clearing it would strand a
      // relay-only provider on the client-owned default).
      runtimeConfig.removeFormValue(["talk", "realtime", "provider"]);
      return;
    }
    const configuredTransport = selection.transport;
    const option =
      this.catalog.kind === "ready"
        ? this.catalog.providers.find((provider) => provider.id === providerId)
        : undefined;
    const targetModel =
      effectiveTalkValues(
        { ...selection, provider: providerId, model: null, speakerVoice: null },
        option,
      ).model ?? option?.defaultModel;
    const rejectsTransport =
      configuredTransport !== null &&
      (gptLiveRejectsTransport(targetModel ?? null, configuredTransport) ||
        talkProviderRejectsTransport(option?.transports, configuredTransport));
    if (rejectsTransport) {
      runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
    }
    runtimeConfig.patchForm(["talk", "realtime", "provider"], providerId);
    // A relay-only provider (no client-owned transport) needs the transport
    // written explicitly when the current selection cannot carry across.
    const relayOnly =
      option !== undefined &&
      option.transports.length > 0 &&
      !option.transports.some((candidate) => TALK_CLIENT_OWNED_TRANSPORTS.has(candidate));
    let resultingTransport = rejectsTransport ? null : configuredTransport;
    if (relayOnly && configuredTransport !== "gateway-relay") {
      runtimeConfig.patchForm(["talk", "realtime", "transport"], "gateway-relay");
      resultingTransport = "gateway-relay";
    }
    if (
      option?.id === "openai" &&
      isTalkGptLiveModel(targetModel ?? null) &&
      resultingTransport === "gateway-relay" &&
      selection.consultRouting === "force-agent-consult"
    ) {
      runtimeConfig.removeFormValue(["talk", "realtime", "consultRouting"]);
    }
  }

  override render() {
    const runtimeState = this.context.runtimeConfig.state;
    const voiceWake = voiceWakeOwner(this.context.gateway);
    return renderTalk({
      nativeDeviceSettings: this.context.nativeDeviceSettings,
      voiceWake: {
        state: voiceWake.state,
        onInput: (text) => voiceWake.edit(text),
        onRetry: () => voiceWake.retry(),
      },
      selection: resolveTalkRealtimeSelection(this.configObject),
      catalog: this.catalog,
      dictationSelection: resolveDictationSelection(this.configObject),
      dictationCatalog: this.dictationCatalog,
      modelDefaultPending: this.modelDefaultResetIntent !== null,
      configBusy:
        this.mutationDisabled ||
        runtimeState.configLoading ||
        runtimeState.configSaving ||
        runtimeState.configApplying,
      onProviderChange: (providerId) => this.changeProvider(providerId),
      onModelChange: (model) => this.changeModel(model),
      onVoiceChange: (voice) => this.changeVoice(voice),
      onDictationProviderChange: (providerId) => this.changeDictationProvider(providerId),
      onDictationModelChange: (model) => this.changeDictationModel(model),
      onDictationEndpointChange: (endpoint) => this.changeDictationEndpoint(endpoint),
      editor: this.buildEditor(),
    });
  }
}

if (!customElements.get("openclaw-talk-settings")) {
  customElements.define("openclaw-talk-settings", TalkSettingsPage);
}

export function renderTalkPage(props: TalkPageProps) {
  return html`
    <openclaw-talk-settings
      .configObject=${props.configObject}
      .mutationDisabled=${props.mutationDisabled}
      .buildEditor=${props.buildEditor}
    ></openclaw-talk-settings>
  `;
}
