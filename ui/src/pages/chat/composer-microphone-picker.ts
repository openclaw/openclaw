import type { TalkCatalogResult, TalkConfigResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { listen } from "../../lib/reactive/listener.ts";
import {
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "./talk/input.ts";

export type ComposerTalkCapabilityStatus = "checking" | "ready" | "unavailable" | "unknown";

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
  realtimeStatus: ComposerTalkCapabilityStatus = "unknown";
  dictationStatus: ComposerTalkCapabilityStatus = "unknown";
  // Terminal login changes credentials without replacing the Gateway connection.
  private readonly refreshOnFocus = (): void => void this.loadCatalog();

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  syncCatalog(client: GatewayBrowserClient | null, connected: boolean, sessionKey?: string): void {
    const canRead = hasOperatorReadAccess(client?.auth ?? null);
    const catalogConnected = connected && canRead;
    if (
      client === this.catalogClient &&
      catalogConnected === this.catalogConnected &&
      sessionKey === this.catalogSessionKey
    ) {
      return;
    }
    this.stopFocus?.();
    this.stopFocus = undefined;
    this.catalogClient = client;
    this.catalogConnected = catalogConnected;
    this.catalogSessionKey = sessionKey;
    this.catalogRequest++;
    this.realtimeStatus = canRead ? "unknown" : "unavailable";
    this.dictationStatus = canRead ? "unknown" : "unavailable";
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
    if (!client || !this.catalogConnected || !hasOperatorReadAccess(client.auth)) {
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
        client.request<TalkConfigResult>("talk.config", {}),
      ]);
      if (request !== this.catalogRequest) {
        return;
      }
      this.dictationStatus = catalog.transcription?.ready === true ? "ready" : "unavailable";
      const talk = config.config?.talk;
      if (talk?.realtime?.mode !== "stt-tts") {
        this.realtimeStatus = catalog.realtime?.ready === true ? "ready" : "unavailable";
        return;
      }
      let speechReady: boolean;
      if (talk.provider || talk.resolved?.provider) {
        speechReady = catalog.speech.providers.some(
          (provider) => provider.id === catalog.speech.activeProvider && provider.configured,
        );
      } else {
        const status = await client.request<{
          provider: string;
          providerStates: Array<{ id: string; configured: boolean }>;
          fallbackProviders: string[];
        }>("tts.status", {});
        speechReady =
          status.providerStates.some(
            (provider) => provider.id === status.provider && provider.configured,
          ) || status.fallbackProviders.length > 0;
      }
      if (request === this.catalogRequest) {
        this.realtimeStatus =
          this.dictationStatus === "ready" && speechReady ? "ready" : "unavailable";
      }
    } catch {
      if (request === this.catalogRequest) {
        this.setCatalogChecking(false);
      }
    } finally {
      if (request === this.catalogRequest) {
        this.dispatchEvent(new Event("change"));
      }
    }
  }
}
