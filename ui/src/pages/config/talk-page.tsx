// State for the curated Talk settings page. Owns the talk.catalog read
// that feeds the provider/model/voice pickers; all writes go through the shared
// config form draft so the embedded schema editor below stays in sync.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
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
    connected:
      snapshot.phase === "connected" && hasOperatorReadAccess(snapshot.hello?.auth ?? null),
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
    // Retire queued voice-wake writes synchronously, including while this route is absent.
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

function createTalkSettings(context: ApplicationContext, props: TalkSettingsPageProps) {
  // Connection setup can publish the initial loading state inside the page owner.
  const [catalog, setCatalog] = createSignal<TalkCatalogState>(
    { kind: "unavailable" },
    { ownedWrite: true },
  );
  const [modelDefaultResetIntent, setModelDefaultResetIntent] =
    createSignal<ModelDefaultResetIntent | null>(null);
  let connectionValue: CatalogConnection | null = null;
  /** `undefined` = baseline not yet observed; `null` = no public revision token. */
  let lastCatalogConfigRevision: string | null | undefined;

  // Provider credential readiness can change outside the config editor without
  // advancing the config hash, so window focus refreshes the catalog.
  const refreshOnFocus = () => {
    const connection = connectionValue;
    if (connection?.client && connection.connected) {
      void loadCatalog(connection.client, connection);
    }
  };

  function syncCatalog(connection: CatalogConnection) {
    const { gatewayUrl, client, connected, voiceWake } = connection;
    // Connection events inspect pending intent without subscribing the caller.
    const intent = untrack(modelDefaultResetIntent);
    if (intent && intent.gatewayUrl !== gatewayUrl) {
      setModelDefaultResetIntent(null);
    }
    // connecting -> connected keeps the same client object; keying only on the
    // client would leave a page mounted mid-handshake without a catalog.
    if (
      connectionValue?.gatewayUrl === gatewayUrl &&
      connectionValue.client === client &&
      connectionValue.connected === connected &&
      connectionValue.voiceWake === voiceWake
    ) {
      return;
    }
    connectionValue = connection;
    if (!client || !connected) {
      setCatalog({ kind: "unavailable" });
      return;
    }
    setCatalog({ kind: "loading" });
    void loadCatalog(client, connection);
  }

  async function loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    try {
      const result = await client.request<TalkCatalogResult>("talk.catalog", {});
      if (connectionValue !== connection) {
        return;
      }
      // Same-connection catalog refreshes are best effort; focus/config changes refresh again.
      setCatalog({
        kind: "ready",
        ready: result.realtime.ready === true,
        activeProvider: result.realtime.activeProvider ?? null,
        providers: result.realtime.providers,
      });
      acknowledgeModelDefaultReset(connection);
    } catch {
      // The catalog only powers the pickers; the page still renders the raw
      // configured values when it cannot be read.
      if (connectionValue === connection) {
        setCatalog({ kind: "unavailable" });
      }
    }
  }

  function acknowledgeModelDefaultReset(connection: CatalogConnection) {
    // An async catalog receipt acknowledges the current intent once.
    const intent = untrack(modelDefaultResetIntent);
    const configRevision = lastCatalogConfigRevision;
    // Without a public revision token, a ready catalog cannot prove the reset
    // was applied; retain provider-default metadata until an authoritative ack.
    if (configRevision == null) {
      return;
    }
    if (intent?.gatewayUrl === connection.gatewayUrl && intent.configRevision !== configRevision) {
      setModelDefaultResetIntent(null);
    }
  }

  /**
   * Readiness can change on the same connection when a config write lands (the
   * gateway may hot-apply talk config without dropping the socket), so the
   * catalog re-reads whenever the public config revision advances. The revision
   * is the durable ack signal; transient saving flags can be skipped entirely
   * by a fast save.
   */
  function refreshCatalogOnConfigChange(configState: ApplicationContext["runtimeConfig"]["state"]) {
    const configRevision = configRevisionToken(configState.configSnapshot);
    if (lastCatalogConfigRevision === undefined) {
      lastCatalogConfigRevision = configRevision;
      return;
    }
    if (configRevision === null || configRevision === lastCatalogConfigRevision) {
      return;
    }
    lastCatalogConfigRevision = configRevision;
    const connection = connectionValue;
    if (connection?.client && connection.connected) {
      void loadCatalog(connection.client, connection);
    }
  }

  /**
   * The pickers advertise "Provider default", so a null pick must clear every
   * key that could keep supplying the old value: the top-level override, the
   * legacy speakerVoiceId spelling, and the selected provider's own entry
   * (matched by configured spelling, canonical id, and aliases). Removing only
   * the top-level key would make Default a no-op over provider-level config.
   */
  function changeModel(model: string | null) {
    if (props.mutationDisabled) {
      return;
    }
    const runtimeConfig = context.runtimeConfig;
    if (model !== null) {
      setModelDefaultResetIntent(null);
      runtimeConfig.patchForm(["talk", "realtime", "model"], model);
      const selection = liveSelection();
      const transport = selection.transport;
      const provider = selectedTalkProviderOption(catalog(), selection);
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
    setModelDefaultResetIntent({
      gatewayUrl: context.gateway.connection.gatewayUrl,
      configRevision: configRevisionToken(runtimeConfig.state.configSnapshot),
    });
    runtimeConfig.removeFormValue(["talk", "realtime", "model"]);
    for (const key of selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "model"]);
    }
  }

  function changeVoice(voice: string | null) {
    if (props.mutationDisabled) {
      return;
    }
    const runtimeConfig = context.runtimeConfig;
    if (voice !== null) {
      runtimeConfig.patchForm(["talk", "realtime", "speakerVoice"], voice);
      return;
    }
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoice"]);
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoiceId"]);
    for (const key of selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "speakerVoice"]);
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "voice"]);
    }
  }

  function selectedProviderConfigKeys(): string[] {
    const selection = liveSelection();
    const option = selectedTalkProviderOption(catalog(), selection);
    return talkProviderConfigKeys(selection, option);
  }

  /**
   * Mutation helpers must read the live form draft, not the configObject prop:
   * the form updates immutably and the prop only refreshes on the next render,
   * so a same-tick read through the prop sees pre-write values.
   */
  function liveSelection() {
    const form = context.runtimeConfig.state.configForm;
    return resolveTalkRealtimeSelection(form ?? props.configObject ?? {});
  }

  /**
   * Model and voice picks are provider-coupled, so a provider switch clears
   * those top-level overrides. Transport survives when the target provider
   * advertises it; an unavailable catalog is not evidence of incompatibility.
   * Each provider's own entry survives and supplies its fallback values.
   */
  function changeProvider(providerId: string | null) {
    if (props.mutationDisabled) {
      return;
    }
    setModelDefaultResetIntent(null);
    const runtimeConfig = context.runtimeConfig;
    const selection = liveSelection();
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
    const currentCatalog = catalog();
    const option =
      currentCatalog.kind === "ready"
        ? currentCatalog.providers.find((provider) => provider.id === providerId)
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
  const stops = [
    // Retire catalog reads on every connection transition, even within one render.
    context.gateway.subscribe(() => syncCatalog(catalogConnection(context.gateway))),
    // Config receipts acknowledge model resets and admit a fresh catalog read.
    context.runtimeConfig.subscribe(() =>
      refreshCatalogOnConfigChange(context.runtimeConfig.state),
    ),
    listen(window, "focus", refreshOnFocus),
  ];
  syncCatalog(catalogConnection(context.gateway));
  refreshCatalogOnConfigChange(context.runtimeConfig.state);
  onCleanup(() => {
    stops.forEach((stop) => stop());
    connectionValue = null;
  });
  return { catalog, modelDefaultResetIntent, changeModel, changeVoice, changeProvider };
}

export function TalkSettingsPage(props: TalkSettingsPageProps) {
  const context = useApplication();
  const settings = createTalkSettings(context, props);
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const voiceWake = voiceWakeOwner(context.gateway);
  const voiceWakeState = projectOwner(voiceWake, (owner) => owner.state);
  const device = context.nativeDeviceSettings
    ? projectNativeDeviceSettings(context.nativeDeviceSettings)
    : undefined;
  onCleanup(() => {
    voiceWake.flush();
  });
  return (
    <openclaw-talk-settings>
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
        catalog={settings.catalog()}
        modelDefaultPending={settings.modelDefaultResetIntent() !== null}
        configBusy={
          props.mutationDisabled ||
          runtime.read().state.configLoading ||
          runtime.read().state.configSaving ||
          runtime.read().state.configApplying
        }
        onProviderChange={(providerId) => settings.changeProvider(providerId)}
        onModelChange={(model) => settings.changeModel(model)}
        onVoiceChange={(voice) => settings.changeVoice(voice)}
        editor={props.buildEditor?.()}
      />
    </openclaw-talk-settings>
  );
}
