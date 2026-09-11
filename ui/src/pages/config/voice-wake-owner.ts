import type { ApplicationContext } from "../../app/context.ts";
// Voice-wake (trigger words) settings owner for the Talk page. Drafts and
// write ordering belong to the application Gateway, not a route element;
// weak ownership retains them across navigation without durable storage.
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { VoiceWakeEditorState } from "./talk-device.ts";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

type CatalogConnection = {
  gatewayUrl: string;
  client: GatewayClient | null;
  connected: boolean;
  voiceWake: boolean;
};

type VoiceWakeWrite = {
  connection: CatalogConnection;
  text: string;
  next: string | null;
};

const voiceWakeOwners = new WeakMap<ApplicationContext["gateway"], VoiceWakeSettingsOwner>();

export class VoiceWakeSettingsOwner {
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
    const snapshot = this.gateway.snapshot;
    const gatewayUrl = this.gateway.connection.gatewayUrl;
    const client = snapshot.client;
    const connected = snapshot.phase === "connected";
    const voiceWake =
      isGatewayMethodAdvertised(snapshot, "voicewake.get") === true &&
      isGatewayMethodAdvertised(snapshot, "voicewake.set") === true;
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
    const connection: CatalogConnection = { gatewayUrl, client, connected, voiceWake };
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

export function voiceWakeOwner(gateway: ApplicationContext["gateway"]): VoiceWakeSettingsOwner {
  let owner = voiceWakeOwners.get(gateway);
  if (!owner) {
    owner = new VoiceWakeSettingsOwner(gateway);
    voiceWakeOwners.set(gateway, owner);
  }
  return owner;
}
