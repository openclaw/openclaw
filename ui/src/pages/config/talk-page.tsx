// Controller for the curated Talk settings page. Owns the talk.catalog read
// that feeds the provider/model/voice pickers; all writes go through the shared
// config form draft so the embedded schema editor below stays in sync.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import type { VoiceWakeEditorState } from "./talk-device.tsx";
import {
  isTalkGptLiveModel,
  resolveTalkRealtimeSelection,
  talkProviderRejectsTransport,
} from "./talk-schema.ts";
import {
  effectiveTalkValues,
  Talk,
  selectedTalkProviderOption,
  talkProviderConfigKeys,
  type TalkCatalogState,
} from "./talk.tsx";

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

function catalogConnection(gateway: ApplicationContext["gateway"]): CatalogConnection {
  const snapshot = gateway.snapshot;
  return {
    gatewayUrl: gateway.connection.gatewayUrl,
    client: snapshot.client,
    connected: snapshot.phase === "connected",
    voiceWake:
      isGatewayMethodAdvertised(snapshot, "voicewake.get") === true &&
      isGatewayMethodAdvertised(snapshot, "voicewake.set") === true,
  };
}

type VoiceWakeWrite = {
  connection: CatalogConnection;
  text: string;
  next: string | null;
};

type ModelDefaultResetIntent = {
  gatewayUrl: string;
  configRevision: string | null;
};

/** Transports whose sessions are client-owned (`talk.client.create`). */
const TALK_CLIENT_OWNED_TRANSPORTS = new Set(["webrtc", "provider-websocket"]);

function gptLiveRejectsTransport(model: string | null, transport: string): boolean {
  return isTalkGptLiveModel(model) && transport === "provider-websocket";
}

// Drafts and write ordering belong to the application Gateway, not a route
// element. Weak ownership retains them across navigation without durable storage.
const voiceWakeOwners = new WeakMap<ApplicationContext["gateway"], VoiceWakeSettingsOwner>();

class VoiceWakeSettingsOwner {
  private value: VoiceWakeEditorState = { kind: "unavailable" };
  private connection: CatalogConnection | null = null;
  private voiceWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private voiceWakeWrite: VoiceWakeWrite | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly gateway: ApplicationContext["gateway"]) {
    // This subscription shares the Gateway's lifetime, including route absences.
    gateway.subscribe(() => this.sync());
  }

  get state() {
    return this.value;
  }

  private update(nextState: VoiceWakeEditorState) {
    this.value = nextState;
    for (const notify of this.listeners) {
      notify();
    }
  }

  subscribe(notify: () => void) {
    this.listeners.add(notify);
    this.sync();
    const connection = this.connection;
    if (
      connection?.connected &&
      connection.voiceWake &&
      this.state.kind !== "loading" &&
      (this.state.kind !== "ready" || this.state.phase === "saved")
    ) {
      void this.loadVoiceWake(connection);
    }
    return () => {
      this.listeners.delete(notify);
    };
  }

  flush() {
    if (this.voiceWakeTimer !== undefined) {
      clearTimeout(this.voiceWakeTimer);
      this.voiceWakeTimer = undefined;
      void this.saveVoiceWake();
    }
  }

  retry() {
    if (this.state.kind === "ready") {
      void this.saveVoiceWake();
    } else if (this.connection) {
      void this.loadVoiceWake(this.connection);
    }
  }

  private sync() {
    const connection = catalogConnection(this.gateway);
    const { gatewayUrl, client, connected, voiceWake } = connection;
    if (
      this.connection?.gatewayUrl === gatewayUrl &&
      this.connection.client === client &&
      this.connection.connected === connected &&
      this.connection.voiceWake === voiceWake
    ) {
      return;
    }
    clearTimeout(this.voiceWakeTimer);
    this.voiceWakeTimer = undefined;
    if (this.voiceWakeWrite) {
      this.voiceWakeWrite.next = null;
      this.voiceWakeWrite = null;
    }
    // A reconnect changes request ownership, not draft ownership. A different
    // Gateway drops the draft so its trigger words can never cross owners.
    const draft =
      this.connection?.gatewayUrl === gatewayUrl &&
      this.state.kind === "ready" &&
      this.state.phase !== "saved"
        ? this.state
        : null;
    this.connection = connection;
    this.update(
      draft
        ? { ...draft, phase: "pending", error: t("configPage.deviceTalk.triggerWordsDisconnected") }
        : { kind: "unavailable" },
    );
    if (client && connected && voiceWake && !draft && this.listeners.size > 0) {
      void this.loadVoiceWake(connection);
    }
  }

  private async loadVoiceWake(connection: CatalogConnection) {
    if (!connection.client || !connection.voiceWake) {
      return;
    }
    this.update({ kind: "loading" });
    try {
      const result = await connection.client.request<{ triggers: string[] }>("voicewake.get", {});
      if (this.connection === connection) {
        this.update({
          kind: "ready",
          text: result.triggers.join("\n"),
          phase: "saved",
          error: null,
        });
      }
    } catch (error) {
      if (this.connection === connection) {
        this.update({
          kind: "error",
          error: t("configPage.deviceTalk.triggerWordsLoadError", { error: String(error) }),
        });
      }
    }
  }

  edit(text: string) {
    if (this.state.kind !== "ready") {
      return;
    }
    this.update({ kind: "ready", text, phase: "pending", error: null });
    const write = this.voiceWakeWrite;
    if (write?.connection === this.connection && write.next !== null) {
      write.next = text === write.text ? null : text;
    }
    clearTimeout(this.voiceWakeTimer);
    this.voiceWakeTimer = setTimeout(() => {
      this.voiceWakeTimer = undefined;
      void this.saveVoiceWake();
    }, 400);
  }

  private async saveVoiceWake() {
    const connection = this.connection;
    const currentState = this.state;
    if (currentState.kind !== "ready" || currentState.phase === "saved") {
      return;
    }
    if (!connection?.client || !connection.connected || !connection.voiceWake) {
      this.update({
        ...currentState,
        phase: "pending",
        error: t("configPage.deviceTalk.triggerWordsDisconnected"),
      });
      return;
    }
    if (this.voiceWakeWrite?.connection === connection) {
      this.voiceWakeWrite.next =
        currentState.text === this.voiceWakeWrite.text ? null : currentState.text;
      return;
    }
    const write: VoiceWakeWrite = { connection, text: currentState.text, next: currentState.text };
    this.voiceWakeWrite = write;
    // The editor remains writable. Coalesce elapsed debounces into one queued
    // write, and drain a navigation flush against the same captured Gateway.
    while (write.next !== null) {
      write.text = write.next;
      write.next = null;
      const draft = this.state;
      if (this.connection === connection && draft.kind === "ready" && draft.text === write.text) {
        this.update({ ...draft, phase: "saving", error: null });
      }
      try {
        const result = await connection.client.request<{ triggers: string[] }>("voicewake.set", {
          triggers: write.text.split("\n"),
        });
        // The Gateway owns normalization; only apply its acknowledgment when
        // the editable draft still matches the submitted text.
        if (
          this.connection === connection &&
          this.state.kind === "ready" &&
          this.state.text === write.text
        ) {
          this.update({
            kind: "ready",
            text: result.triggers.join("\n"),
            phase: "saved",
            error: null,
          });
        }
      } catch (error) {
        if (this.connection === connection && this.state.kind === "ready") {
          this.update({
            ...this.state,
            phase: "pending",
            error: t("configPage.deviceTalk.triggerWordsError", { error: String(error) }),
          });
        }
      }
    }
    if (this.voiceWakeWrite === write) {
      this.voiceWakeWrite = null;
    }
  }
}

function voiceWakeOwner(gateway: ApplicationContext["gateway"]): VoiceWakeSettingsOwner {
  let owner = voiceWakeOwners.get(gateway);
  if (!owner) {
    owner = new VoiceWakeSettingsOwner(gateway);
    voiceWakeOwners.set(gateway, owner);
  }
  return owner;
}

export type TalkSettingsPageProps = {
  configObject?: Record<string, unknown>;
  mutationDisabled?: boolean;
  buildEditor?: () => JSX.Element;
};

class TalkSettingsController {
  private readonly listeners = new Set<() => void>();
  private catalogValue: TalkCatalogState = { kind: "unavailable" };
  private resetIntentValue: ModelDefaultResetIntent | null = null;
  private connection: CatalogConnection | null = null;
  private catalogRequestId = 0;
  private disposed = false;
  /** `undefined` = baseline not yet observed; `null` = no public revision token. */
  private lastCatalogConfigRevision: string | null | undefined;
  private readonly stopGateway: () => void;
  private readonly stopConfig: () => void;

  constructor(
    private readonly context: ApplicationContext,
    private readonly props: TalkSettingsPageProps,
  ) {
    this.stopGateway = context.gateway.subscribe(() =>
      this.syncCatalog(catalogConnection(context.gateway)),
    );
    this.stopConfig = context.runtimeConfig.subscribe(() =>
      this.refreshCatalogOnConfigChange(context.runtimeConfig.state),
    );
    this.syncCatalog(catalogConnection(context.gateway));
    this.refreshCatalogOnConfigChange(context.runtimeConfig.state);
    window.addEventListener("focus", this.refreshOnFocus);
  }

  get catalog() {
    return this.catalogValue;
  }

  set catalog(value: TalkCatalogState) {
    this.catalogValue = value;
    this.notify();
  }

  get modelDefaultResetIntent() {
    return this.resetIntentValue;
  }

  set modelDefaultResetIntent(value: ModelDefaultResetIntent | null) {
    this.resetIntentValue = value;
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Provider credential readiness can change outside the config editor without
  // advancing the config hash, so window focus refreshes the catalog.
  private readonly refreshOnFocus = () => {
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  };

  dispose() {
    this.disposed = true;
    window.removeEventListener("focus", this.refreshOnFocus);
    this.stopGateway();
    this.stopConfig();
    this.listeners.clear();
    this.connection = null;
  }

  private syncCatalog(connection: CatalogConnection) {
    const { gatewayUrl, client, connected, voiceWake } = connection;
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
    this.connection = connection;
    if (!client || !connected) {
      this.catalog = { kind: "unavailable" };
      return;
    }
    this.catalog = { kind: "loading" };
    void this.loadCatalog(client, connection);
  }

  private async loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    // Initial load, config-hash refresh, and focus refresh can overlap on the
    // same connection; only the newest request may write the catalog, or a
    // slow older response would overwrite a fresher one.
    const requestId = ++this.catalogRequestId;
    try {
      const result = await client.request<TalkCatalogResult>("talk.catalog", {});
      const applied = this.applyCatalog(connection, requestId, {
        kind: "ready",
        ready: result.realtime.ready === true,
        activeProvider: result.realtime.activeProvider ?? null,
        providers: result.realtime.providers,
      });
      if (applied) {
        this.acknowledgeModelDefaultReset(connection);
      }
    } catch {
      // The catalog only powers the pickers; the page still renders the raw
      // configured values when it cannot be read.
      this.applyCatalog(connection, requestId, { kind: "unavailable" });
    }
  }

  private applyCatalog(
    connection: CatalogConnection,
    requestId: number,
    catalog: TalkCatalogState,
  ): boolean {
    if (this.disposed || this.connection !== connection || this.catalogRequestId !== requestId) {
      return false;
    }
    this.catalog = catalog;
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
  changeModel(model: string | null) {
    if (this.props.mutationDisabled) {
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

  changeVoice(voice: string | null) {
    if (this.props.mutationDisabled) {
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
    return resolveTalkRealtimeSelection(form ?? this.props.configObject ?? {});
  }

  /**
   * Model and voice picks are provider-coupled, so a provider switch clears
   * those top-level overrides. Transport survives when the target provider
   * advertises it; an unavailable catalog is not evidence of incompatibility.
   * Each provider's own entry survives and supplies its fallback values.
   */
  changeProvider(providerId: string | null) {
    if (this.props.mutationDisabled) {
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
      option?.transports !== undefined &&
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
}

export function TalkSettingsContent(props: TalkSettingsPageProps) {
  const context = useApplication();
  const controller = new TalkSettingsController(context, props);
  const catalog = projectSource(controller, {
    read: (owner) => ({
      catalog: owner.catalog,
      modelDefaultPending: owner.modelDefaultResetIntent !== null,
    }),
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality: "revision",
  });
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const voiceWake = voiceWakeOwner(context.gateway);
  const voiceWakeState = projectSource(voiceWake, {
    read: (owner) => owner.state,
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality: "revision",
  });
  const device = context.nativeDeviceSettings
    ? projectNativeDeviceSettings(context.nativeDeviceSettings)
    : undefined;
  onCleanup(() => {
    voiceWake.flush();
    controller.dispose();
  });
  return (
    <Talk
      nativeDeviceSettings={context.nativeDeviceSettings}
      nativeDeviceSnapshot={device?.read()}
      voiceWake={{
        get state() {
          return voiceWakeState.read();
        },
        onInput: (text) => voiceWake.edit(text),
        onRetry: () => voiceWake.retry(),
      }}
      selection={resolveTalkRealtimeSelection(props.configObject ?? {})}
      catalog={catalog.read().catalog}
      modelDefaultPending={catalog.read().modelDefaultPending}
      configBusy={
        props.mutationDisabled ||
        runtime.read().state.configLoading ||
        runtime.read().state.configSaving ||
        runtime.read().state.configApplying
      }
      onProviderChange={(providerId) => controller.changeProvider(providerId)}
      onModelChange={(model) => controller.changeModel(model)}
      onVoiceChange={(voice) => controller.changeVoice(voice)}
      editor={props.buildEditor?.()}
    />
  );
}

export const TalkSettingsPage = defineSolidBridge<TalkSettingsPageProps>(
  "openclaw-talk-settings",
  (props) => <TalkSettingsContent {...props} />,
  {
    properties: {
      configObject: { default: {}, attribute: false },
      mutationDisabled: { default: false, type: Boolean },
      buildEditor: { default: () => null, attribute: false },
    },
  },
);
