import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "./talk/input.ts";

export type ComposerTalkCapabilityStatus = "checking" | "ready" | "unavailable" | "unknown";

// Each composer owns discovery and the devicechange subscription; delayed results
// cannot overwrite newer discovery, and only an open picker watches devices.
export class ComposerMicrophonePicker {
  devices: RealtimeTalkInputDevice[] = [];
  loading = false;
  open = false;
  issue: RealtimeTalkDeviceIssue | null = null;
  private deviceWatch: (() => void) | null = null;
  private discoveryRequest = 0;
  private catalogClient: GatewayBrowserClient | null = null;
  private catalogConnected = false;
  private catalogRequest = 0;
  realtimeStatus: ComposerTalkCapabilityStatus = "unknown";
  dictationStatus: ComposerTalkCapabilityStatus = "unknown";
  // Terminal login changes credentials without replacing the Gateway connection.
  private readonly refreshOnFocus = (): void => this.loadCatalog();

  constructor(private readonly requestUpdate: () => void) {}

  syncCatalog(client: GatewayBrowserClient | null, connected: boolean): void {
    if (client === this.catalogClient && connected === this.catalogConnected) {
      return;
    }
    window.removeEventListener("focus", this.refreshOnFocus);
    this.catalogClient = client;
    this.catalogConnected = connected;
    this.catalogRequest++;
    if (!client || !connected) {
      this.realtimeStatus = "unknown";
      this.dictationStatus = "unknown";
      return;
    }
    window.addEventListener("focus", this.refreshOnFocus);
    this.loadCatalog(false);
  }

  readonly handleOpen = (): void => {
    if (this.open) {
      return;
    }
    this.open = true;
    this.deviceWatch ??= observeRealtimeTalkDevices(this.discover);
    this.discover();
    this.loadCatalog();
  };

  readonly handleClose = (): void => {
    if (!this.open) {
      return;
    }
    this.release();
    this.open = false;
    this.requestUpdate();
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

  private readonly discover = (): void => {
    this.loading = true;
    this.issue = null;
    const request = ++this.discoveryRequest;
    this.requestUpdate();
    // A closed or replaced picker cannot turn delayed discovery into a prompt.
    void discoverRealtimeTalkInputs(() => this.open && request === this.discoveryRequest)
      .then((result) => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.devices = result.devices;
        this.issue = result.issue;
      })
      .catch(() => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.devices = [];
        this.issue = "failed";
      })
      .finally(() => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.loading = false;
        this.requestUpdate();
      });
  };

  private setCatalogChecking(checking: boolean): void {
    for (const field of ["realtimeStatus", "dictationStatus"] as const) {
      if (this[field] === (checking ? "unknown" : "checking")) {
        this[field] = checking ? "checking" : "unknown";
      }
    }
  }

  private loadCatalog(notify = true): void {
    const client = this.catalogClient;
    if (!client || !this.catalogConnected) {
      return;
    }
    const request = ++this.catalogRequest;
    this.setCatalogChecking(true);
    if (notify) {
      this.requestUpdate();
    }
    void client
      .request<TalkCatalogResult>("talk.catalog", {})
      .then((catalog) => {
        if (request !== this.catalogRequest) {
          return;
        }
        this.realtimeStatus = catalog.realtime?.ready === true ? "ready" : "unavailable";
        this.dictationStatus = catalog.transcription?.ready === true ? "ready" : "unavailable";
      })
      .catch(() => {
        if (request !== this.catalogRequest) {
          return;
        }
        this.setCatalogChecking(false);
      })
      .finally(() => {
        if (request === this.catalogRequest) {
          this.requestUpdate();
        }
      });
  }
}
