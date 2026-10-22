// State for the curated Talk settings page. Owns the talk.catalog read
// that feeds the provider/model/voice pickers; all writes go through the shared
// config form draft so the embedded schema editor below stays in sync.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectMutableSource, projectOwner } from "../../lib/reactive/projection.ts";
import type { VoiceWakeEditorState } from "./talk-device.tsx";
import {
  resolveTalkModelFamilySettings,
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
};

function catalogConnection(gateway: ApplicationContext["gateway"]): CatalogConnection {
  const snapshot = gateway.snapshot;
  return {
    gatewayUrl: gateway.connection.gatewayUrl,
    client: snapshot.client,
    connected:
      snapshot.phase === "connected" && hasOperatorReadAccess(snapshot.hello?.auth ?? null),
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

// Drafts and write ordering belong to the application Gateway, not a route
// element. Weak ownership retains them across navigation without durable storage.
const voiceWakeOwners = new WeakMap<ApplicationContext["gateway"], VoiceWakeSettingsOwner>();

class VoiceWakeSettingsOwner {
  private value: VoiceWakeEditorState = { kind: "unavailable" };
  private connection: CatalogConnection | null = null;
  private voiceWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private voiceWakeWrite: VoiceWakeWrite | null = null;
  private voiceWakeRead: { promise: Promise<void>; pending: boolean } | null = null;
  private voiceWakeCompletion: (Deferred & { pending: boolean }) | null = null;
  private render?: () => void;

  constructor(private readonly gateway: ApplicationContext["gateway"]) {
    // Retire queued voice-wake writes synchronously, including while this route is absent.
    gateway.subscribe(() => this.sync());
  }

  get state() {
    return this.value;
  }

  get readReceipt() {
    return this.voiceWakeRead;
  }

  get writeReceipt() {
    return this.voiceWakeCompletion;
  }

  private beginWrite() {
    if (!this.voiceWakeCompletion?.pending) {
      this.voiceWakeCompletion = { ...createDeferredCore(), pending: true };
      // Navigation can leave the owner draining writes without a mounted presenter.
      void this.voiceWakeCompletion.promise.catch(() => {});
    }
    return this.voiceWakeCompletion.promise;
  }

  private settleWrite(error?: Error) {
    const completion = this.voiceWakeCompletion;
    if (!completion?.pending) {
      return;
    }
    completion.pending = false;
    if (error) {
      completion.reject(error);
    } else {
      completion.resolve();
    }
  }

  private update(nextState: VoiceWakeEditorState) {
    this.value = nextState;
    this.render?.();
  }

  subscribe(notify: () => void) {
    this.render = notify;
    this.sync();
    const connection = this.connection;
    if (
      connection?.connected &&
      !this.voiceWakeRead?.pending &&
      (this.state.kind !== "ready" || this.state.phase === "saved")
    ) {
      this.loadVoiceWake(connection);
    }
    return () => {
      this.render = undefined;
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
      const completion = this.beginWrite();
      void this.saveVoiceWake();
      return completion;
    } else if (this.connection) {
      this.loadVoiceWake(this.connection);
    }
    return undefined;
  }

  private sync() {
    const connection = catalogConnection(this.gateway);
    const { gatewayUrl, client, connected } = connection;
    if (
      this.connection?.gatewayUrl === gatewayUrl &&
      this.connection.client === client &&
      this.connection.connected === connected
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
    this.voiceWakeRead = null;
    this.settleWrite(
      draft ? new Error(t("configPage.deviceTalk.triggerWordsDisconnected")) : undefined,
    );
    if (!draft) {
      this.voiceWakeCompletion = null;
    }
    this.update(draft ? { ...draft, phase: "pending" } : { kind: "unavailable" });
    if (client && connected && !draft && this.render) {
      this.loadVoiceWake(connection);
    }
  }

  private loadVoiceWake(connection: CatalogConnection) {
    const client = connection.client;
    if (!client || !connection.connected) {
      return;
    }
    this.value = { kind: "unavailable" };
    const read = { promise: this.readVoiceWake(client, connection), pending: true };
    this.voiceWakeRead = read;
    this.render?.();
    // The Gateway owner retains this receipt while no route is mounted; the mounted
    // async memo observes the same rejection through its error boundary.
    void read.promise.then(
      () => {
        read.pending = false;
      },
      () => {
        read.pending = false;
      },
    );
  }

  private async readVoiceWake(client: GatewayClient, connection: CatalogConnection): Promise<void> {
    try {
      const result = await client.request<{ triggers: string[] }>("voicewake.get", {});
      if (this.connection === connection) {
        this.voiceWakeRead = null;
        this.update({
          kind: "ready",
          text: result.triggers.join("\n"),
          phase: "saved",
        });
      }
    } catch (error) {
      if (this.connection !== connection) {
        return;
      }
      throw new Error(t("configPage.deviceTalk.triggerWordsLoadError", { error: String(error) }), {
        cause: error,
      });
    }
  }

  edit(text: string) {
    if (this.state.kind !== "ready") {
      return undefined;
    }
    const completion = this.beginWrite();
    this.update({ kind: "ready", text, phase: "pending" });
    const write = this.voiceWakeWrite;
    if (write?.connection === this.connection && write.next !== null) {
      write.next = text === write.text ? null : text;
    }
    clearTimeout(this.voiceWakeTimer);
    this.voiceWakeTimer = setTimeout(() => {
      this.voiceWakeTimer = undefined;
      void this.saveVoiceWake();
    }, 400);
    return completion;
  }

  private async saveVoiceWake() {
    const connection = this.connection;
    const currentState = this.state;
    if (currentState.kind !== "ready" || currentState.phase === "saved") {
      return;
    }
    if (!connection?.client || !connection.connected) {
      this.settleWrite(new Error(t("configPage.deviceTalk.triggerWordsDisconnected")));
      this.update({ ...currentState, phase: "pending" });
      return;
    }
    if (this.voiceWakeWrite?.connection === connection) {
      this.voiceWakeWrite.next =
        currentState.text === this.voiceWakeWrite.text ? null : currentState.text;
      return;
    }
    const write: VoiceWakeWrite = { connection, text: currentState.text, next: currentState.text };
    this.voiceWakeWrite = write;
    let writeError: Error | undefined;
    // The editor remains writable. Coalesce elapsed debounces into one queued
    // write, and drain a navigation flush against the same captured Gateway.
    while (write.next !== null) {
      write.text = write.next;
      write.next = null;
      const draft = this.state;
      if (this.connection === connection && draft.kind === "ready" && draft.text === write.text) {
        this.update({ ...draft, phase: "saving" });
      }
      try {
        const result = await connection.client.request<{ triggers: string[] }>("voicewake.set", {
          triggers: write.text.split("\n"),
        });
        writeError = undefined;
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
          });
        }
      } catch (error) {
        writeError = new Error(
          t("configPage.deviceTalk.triggerWordsError", { error: String(error) }),
          { cause: error },
        );
        if (this.connection === connection && this.state.kind === "ready") {
          this.update({ ...this.state, phase: "pending" });
        }
      }
    }
    if (this.voiceWakeWrite === write) {
      this.voiceWakeWrite = null;
      // A newer draft whose debounce has not elapsed still owns this completion.
      if (
        this.state.kind === "ready" &&
        (this.state.phase === "saved" || this.state.text === write.text)
      ) {
        this.settleWrite(writeError);
      }
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
  presentationRetired: () => Promise<void>;
  configObject?: Record<string, unknown>;
  mutationDisabled?: boolean;
  buildEditor?: () => JSX.Element;
};

function createTalkSettings(context: ApplicationContext, props: TalkSettingsPageProps) {
  const initial: TalkCatalogState = { kind: "unavailable" };
  // Accepted facts drive synchronous mutation policy; the issued read drives rendering.
  const catalogState: {
    value: TalkCatalogState;
    read: TalkCatalogState | Promise<TalkCatalogState>;
    connection: CatalogConnection | null;
  } = { value: initial, read: initial, connection: null };
  const catalogSource = projectMutableSource(catalogState, (state) => state);
  const catalog = createMemo(async () => catalogSource.read().read);
  const catalogScope = createMemo(() => catalogSource.read().connection);
  const [modelDefaultResetIntent, setModelDefaultResetIntent] =
    createSignal<ModelDefaultResetIntent | null>(null);
  /** `undefined` = baseline not yet observed; `null` = no public revision token. */
  let lastCatalogConfigRevision: string | null | undefined;

  // Provider credential readiness can change outside the config editor without
  // advancing the config hash, so window focus refreshes the catalog.
  const refreshOnFocus = () => {
    const connection = catalogState.connection;
    if (connection?.client && connection.connected) {
      loadCatalog(connection.client, connection);
    }
  };

  function syncCatalog(connection: CatalogConnection) {
    const { gatewayUrl, client, connected } = connection;
    const intent = modelDefaultResetIntent();
    if (intent && intent.gatewayUrl !== gatewayUrl) {
      setModelDefaultResetIntent(null);
    }
    // connecting -> connected keeps the same client object; keying only on the
    // client would leave a page mounted mid-handshake without a catalog.
    if (
      catalogState.connection?.gatewayUrl === gatewayUrl &&
      catalogState.connection.client === client &&
      catalogState.connection.connected === connected
    ) {
      return;
    }
    catalogState.connection = connection;
    catalogState.value = { kind: client && connected ? "loading" : "unavailable" };
    if (!client || !connected) {
      catalogState.read = catalogState.value;
      catalogSource.publish();
      return;
    }
    loadCatalog(client, connection);
  }

  function loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    const read = (async (): Promise<TalkCatalogState> => {
      const result = await client.request<TalkCatalogResult>("talk.catalog", {});
      return {
        kind: "ready",
        ready: result.realtime.ready === true,
        activeProvider: result.realtime.activeProvider ?? null,
        providers: result.realtime.providers,
      };
    })();
    catalogState.read = read;
    catalogSource.publish();
    void read.then(
      (value) => {
        if (catalogState.connection !== connection) {
          return;
        }
        // Same-connection completions remain best effort, including overlapping focus reads.
        catalogState.value = value;
        catalogState.read = value;
        catalogSource.publish();
        acknowledgeModelDefaultReset(connection);
      },
      () => {
        if (catalogState.connection !== connection) {
          return;
        }
        catalogState.value = { kind: "unavailable" };
        catalogState.read = read;
        // Errored renders raw configured values; mutation policy has no provider facts.
        catalogSource.publish();
      },
    );
  }

  function acknowledgeModelDefaultReset(connection: CatalogConnection) {
    // An async catalog receipt acknowledges the current intent once.
    const intent = modelDefaultResetIntent();
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
    const connection = catalogState.connection;
    if (connection?.client && connection.connected) {
      loadCatalog(connection.client, connection);
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
      const provider = selectedTalkProviderOption(catalogState.value, selection);
      const family = resolveTalkModelFamilySettings(provider, model);
      const rejectsTransport =
        transport !== null &&
        (family?.unsupportedTransports.some((candidate) => candidate === transport) ||
          talkProviderRejectsTransport(provider?.transports, transport));
      // Preserve configured transports unless the selected provider positively
      // advertises that it cannot serve them.
      if (family && rejectsTransport) {
        runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
      } else if (
        family?.gatewayRelayHandlesAgentConsult &&
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
    const option = selectedTalkProviderOption(catalogState.value, selection);
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
    const currentCatalog = catalogState.value;
    const option =
      currentCatalog.kind === "ready"
        ? currentCatalog.providers.find((provider) => provider.id === providerId)
        : undefined;
    const targetModel =
      effectiveTalkValues(
        { ...selection, provider: providerId, model: null, speakerVoice: null },
        option,
      ).model ?? option?.defaultModel;
    const family = resolveTalkModelFamilySettings(option, targetModel ?? null);
    const rejectsTransport =
      configuredTransport !== null &&
      (family?.unsupportedTransports.some((candidate) => candidate === configuredTransport) ||
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
      family?.gatewayRelayHandlesAgentConsult &&
      resultingTransport === "gateway-relay" &&
      selection.consultRouting === "force-agent-consult"
    ) {
      runtimeConfig.removeFormValue(["talk", "realtime", "consultRouting"]);
    }
  }
  onSettled(() => {
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
    return () => {
      catalogState.connection = null;
      stops.forEach((stop) => stop());
    };
  });
  return {
    catalog,
    catalogScope,
    modelDefaultResetIntent,
    changeModel,
    changeVoice,
    changeProvider,
  };
}

export function TalkSettingsPage(props: TalkSettingsPageProps) {
  const context = useApplication();
  const settings = createTalkSettings(context, props);
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const voiceWake = voiceWakeOwner(context.gateway);
  const voiceWakeState = projectOwner(voiceWake, (owner) => owner);
  // Only a new read receipt starts async work; draft and write updates stay synchronous.
  const voiceWakeRequest = createMemo(() => voiceWakeState.read().readReceipt);
  const voiceWakeRead = createMemo(async () => voiceWakeRequest()?.promise);
  const voiceWakeReceipt = createMemo(() => voiceWakeState.read().writeReceipt);
  const voiceWakeResult = createMemo(async () => voiceWakeReceipt()?.promise);
  const [voiceWakeSaving, setVoiceWakeSaving] = createOptimistic(false);
  const presentVoiceWakeWrite = action(function* (completion: Promise<void>) {
    setVoiceWakeSaving(true);
    // The receipt's async read owns errors; this action owns only the saving affordance.
    yield completion.catch(() => {});
  });
  let presentedVoiceWakeWrite: Promise<void> | undefined;
  const presentWrite = (start: () => Promise<void> | undefined) => {
    const completion = start();
    if (completion && completion !== presentedVoiceWakeWrite) {
      presentedVoiceWakeWrite = completion;
      // Publish the owner's draft before joining its transition.
      void Promise.resolve()
        .then(() => presentVoiceWakeWrite(completion))
        .catch(() => {});
    }
  };
  const device = context.nativeDeviceSettings
    ? projectNativeDeviceSettings(context.nativeDeviceSettings)
    : undefined;
  onSettled(() => {
    presentWrite(() => voiceWake.writeReceipt?.promise);
    return () => voiceWake.flush();
  });
  return (
    <openclaw-talk-settings>
      <Talk
        presentationRetired={props.presentationRetired}
        nativeDeviceSettings={context.nativeDeviceSettings}
        nativeDeviceSnapshot={device?.read()}
        voiceWake={{
          readState: () => {
            voiceWakeRead();
            return voiceWakeState.read().state;
          },
          get scope() {
            return voiceWakeRequest();
          },
          saving: voiceWakeSaving(),
          readWriteResult: () => voiceWakeResult(),
          onInput: (text) => presentWrite(() => voiceWake.edit(text)),
          onRetry: () => presentWrite(() => voiceWake.retry()),
        }}
        selection={resolveTalkRealtimeSelection(props.configObject ?? {})}
        catalog={settings.catalog()}
        catalogScope={settings.catalogScope()}
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
