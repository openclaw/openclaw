import type { TalkCatalogResult, TalkConfigResult } from "@openclaw/gateway-protocol";
import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { listen } from "../../lib/reactive/listener.ts";
import {
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "./talk/input.ts";

/** Per voice surface, the provider whose sign-in doesn't cover it and needs an API key. */
export type VoiceApiKeyProviders = Partial<Record<"talk" | "dictation" | "speech", string>>;

type CatalogEntries = TalkCatalogResult["realtime"]["providers"] | undefined;
const keyed = (entries: CatalogEntries, ready?: boolean, selected?: string) =>
  ready ? undefined : entries?.find((entry) => entry.id === selected && entry.apiKeyRequired)?.id;

/** The Gateway marks providers whose saved sign-in can't do voice; nothing else implies it. */
function voiceApiKeyProviders({ realtime, transcription }: TalkCatalogResult, speechMode: boolean) {
  const dictation = keyed(
    transcription?.providers,
    transcription?.ready,
    transcription?.activeProvider,
  );
  return {
    talk: speechMode
      ? dictation
      : keyed(realtime?.providers, realtime?.ready, realtime?.activeProvider),
    dictation,
  };
}

export type ComposerTalkCapabilityStatus = "checking" | "ready" | "unavailable" | "unknown";

export type MicrophonePickerProps = {
  devices: RealtimeTalkInputDevice[];
  loading: boolean;
  open: boolean;
  selectedDeviceId: string;
  voiceActive: boolean;
  issue: RealtimeTalkDeviceIssue | null;
  holdToDictate?: boolean;
  showRealtimeCapability?: boolean;
  realtimeStatus: ComposerTalkCapabilityStatus;
  dictationStatus: ComposerTalkCapabilityStatus;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (deviceId: string) => void;
  onHoldToDictateChange?: (enabled: boolean) => void;
  onOpenTalkSettings?: () => void;
  onOpenDictationSettings?: () => void;
  apiKeyProviders?: VoiceApiKeyProviders;
  onConfigureApiKey?: (modelProvider: string | undefined) => void;
};

// Each composer owns discovery and the devicechange subscription; delayed results
// cannot overwrite newer discovery, and only an open picker watches devices.
export class ComposerMicrophoneOwner extends EventTarget {
  devices: RealtimeTalkInputDevice[] = [];
  loading = false;
  open = false;
  issue: RealtimeTalkDeviceIssue | null = null;
  private deviceWatch: (() => void) | null = null;
  private discoveryRequest = 0;
  private catalogClient: GatewayBrowserClient | null = null;
  private catalogConnected = false;
  private catalogSessionKey: string | undefined;
  private catalogRequest = 0;
  private stopFocus: (() => void) | undefined;
  canConfigure = true;
  realtimeStatus: ComposerTalkCapabilityStatus = "unknown";
  dictationStatus: ComposerTalkCapabilityStatus = "unknown";
  apiKeyProviders: VoiceApiKeyProviders = {};
  /** Tapping Talk without its key explains why instead of opening the picker. */
  talkApiKeyNotice = false;
  // Terminal login changes credentials without replacing the Gateway connection.
  private readonly refreshOnFocus = (): void => void this.loadCatalog();

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  syncCatalog(client: GatewayBrowserClient | null, connected: boolean, sessionKey?: string): void {
    const canRead = hasOperatorReadAccess(client?.auth ?? null);
    const canDictate =
      Boolean(sessionKey) &&
      roleScopesAllow({
        role: client?.auth?.role ?? "operator",
        requestedScopes: ["operator.sessions.write"],
        allowedScopes: client?.auth?.scopes ?? [],
      });
    const catalogConnected = connected && (canRead || canDictate);
    if (
      client === this.catalogClient &&
      catalogConnected === this.catalogConnected &&
      canRead === this.canConfigure &&
      sessionKey === this.catalogSessionKey
    ) {
      return;
    }
    this.stopFocus?.();
    this.stopFocus = undefined;
    this.canConfigure = canRead;
    this.catalogClient = client;
    this.catalogConnected = catalogConnected;
    this.catalogSessionKey = sessionKey;
    this.catalogRequest++;
    this.realtimeStatus = canRead ? "unknown" : "unavailable";
    this.dictationStatus = canRead || canDictate ? "unknown" : "unavailable";
    this.apiKeyProviders = {};
    this.talkApiKeyNotice = false;
    if (!client || !catalogConnected) {
      return;
    }
    this.stopFocus = listen(window, "focus", this.refreshOnFocus);
    void this.loadCatalog();
  }

  readonly handleOpen = (): void => {
    if (this.open) {
      return;
    }
    this.open = true;
    this.deviceWatch ??= observeRealtimeTalkDevices(() => void this.discover());
    void this.discover();
    void this.loadCatalog();
  };

  readonly handleClose = (): void => {
    if (!this.open) {
      return;
    }
    this.release();
    this.open = false;
    this.dispatchEvent(new Event("change"));
  };

  setTalkApiKeyNotice(open: boolean): void {
    if (this.talkApiKeyNotice !== open) {
      this.talkApiKeyNotice = open;
      this.dispatchEvent(new Event("change"));
    }
  }

  /** Drops the devicechange subscription so a closed picker stops refreshing. */
  release(): void {
    this.deviceWatch?.();
    this.deviceWatch = null;
  }

  /** Ends an in-flight discovery too, so a late result cannot revive the list. */
  dispose(): void {
    this.syncCatalog(null, false);
    this.release();
    this.discoveryRequest++;
    this.open = false;
    this.loading = false;
  }

  private readonly discover = async (): Promise<void> => {
    this.loading = true;
    this.issue = null;
    const request = ++this.discoveryRequest;
    this.dispatchEvent(new Event("change"));
    // A closed or replaced picker cannot turn delayed discovery into a prompt.
    const result = await discoverRealtimeTalkInputs(
      () => this.open && request === this.discoveryRequest,
    ).catch(() => ({ devices: [], issue: "failed" as const }));
    if (request !== this.discoveryRequest) {
      return;
    }
    this.devices = result.devices;
    this.issue = result.issue;
    this.loading = false;
    this.dispatchEvent(new Event("change"));
  };

  private setCatalogChecking(checking: boolean): void {
    for (const field of ["realtimeStatus", "dictationStatus"] as const) {
      if (this[field] === (checking ? "unknown" : "checking")) {
        this[field] = checking ? "checking" : "unknown";
      }
    }
  }

  private async loadCatalog(): Promise<void> {
    const client = this.catalogClient;
    if (!client || !this.catalogConnected) {
      return;
    }
    const request = ++this.catalogRequest;
    this.setCatalogChecking(true);
    this.dispatchEvent(new Event("change"));
    try {
      const [catalog, config] = await Promise.all([
        client.request<TalkCatalogResult>(
          "talk.catalog",
          this.catalogSessionKey === undefined ? {} : { sessionKey: this.catalogSessionKey },
        ),
        this.canConfigure
          ? client.request<TalkConfigResult>("talk.config", {})
          : Promise.resolve(null),
      ]);
      if (request !== this.catalogRequest) {
        return;
      }
      const talk = config?.config?.talk;
      this.dictationStatus = catalog.transcription?.ready === true ? "ready" : "unavailable";
      this.apiKeyProviders = voiceApiKeyProviders(catalog, talk?.realtime?.mode === "stt-tts");
      if (!config) {
        this.realtimeStatus = "unavailable";
        return;
      }
      if (talk?.realtime?.mode !== "stt-tts") {
        this.realtimeStatus = catalog.realtime?.ready === true ? "ready" : "unavailable";
        return;
      }
      let speechProvider = catalog.speech.activeProvider;
      let speechReady: boolean;
      if (talk.provider || talk.resolved?.provider) {
        speechReady = catalog.speech.providers.some(
          (provider) => provider.id === speechProvider && provider.configured,
        );
      } else {
        const status = await client.request<{
          provider: string;
          providerStates: Array<{ id: string; configured: boolean }>;
          fallbackProviders: string[];
        }>("tts.status", {});
        speechProvider = status.provider;
        speechReady =
          status.providerStates.some(
            (provider) => provider.id === status.provider && provider.configured,
          ) || status.fallbackProviders.length > 0;
      }
      if (request === this.catalogRequest) {
        if (!this.apiKeyProviders.talk) {
          this.apiKeyProviders.speech = keyed(
            catalog.speech.providers,
            speechReady,
            speechProvider,
          );
        }
        this.realtimeStatus =
          this.dictationStatus === "ready" && speechReady ? "ready" : "unavailable";
      }
    } catch {
      if (request === this.catalogRequest) {
        this.setCatalogChecking(false);
      }
    } finally {
      if (request === this.catalogRequest) {
        this.talkApiKeyNotice &&= Boolean(this.apiKeyProviders.talk ?? this.apiKeyProviders.speech);
        this.dispatchEvent(new Event("change"));
      }
    }
  }
}
