import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "./realtime-talk-input.ts";

export type ComposerTalkCapabilityStatus = "checking" | "ready" | "unavailable" | "unknown";

/**
 * Device list behind a composer's microphone control, owned per composer.
 *
 * Discovery, the `devicechange` subscription and the in-flight request token
 * belong together: the subscription only lives while the picker is open, and a
 * late discovery must not overwrite a newer one. Keeping them in one owner is
 * what lets a second composer surface offer the same control without repeating
 * the sequencing, and gives the watch a single release point.
 */
export class ComposerMicrophonePicker {
  private devicesValue: RealtimeTalkInputDevice[] = [];
  private loadingValue = false;
  private openValue = false;
  private issueValue: RealtimeTalkDeviceIssue | null = null;
  private deviceWatch: (() => void) | null = null;
  private discoveryRequest = 0;
  private catalogClient: GatewayBrowserClient | null = null;
  private catalogConnected = false;
  private eagerCatalog = true;
  private catalogRequest = 0;
  private realtimeStatusValue: ComposerTalkCapabilityStatus = "unknown";
  private dictationStatusValue: ComposerTalkCapabilityStatus = "unknown";
  // Terminal login changes credentials without replacing the Gateway connection.
  private readonly refreshOnFocus = (): void => {
    void this.loadCatalog();
  };

  constructor(private readonly requestUpdate: () => void) {}

  get devices(): RealtimeTalkInputDevice[] {
    return this.devicesValue;
  }

  get loading(): boolean {
    return this.loadingValue;
  }

  get open(): boolean {
    return this.openValue;
  }

  get issue(): RealtimeTalkDeviceIssue | null {
    return this.issueValue;
  }

  get realtimeStatus(): ComposerTalkCapabilityStatus {
    return this.realtimeStatusValue;
  }

  get dictationStatus(): ComposerTalkCapabilityStatus {
    return this.dictationStatusValue;
  }

  syncCatalog(client: GatewayBrowserClient | null, connected: boolean, eager = true): void {
    this.eagerCatalog = eager;
    if (client === this.catalogClient && connected === this.catalogConnected) {
      return;
    }
    window.removeEventListener("focus", this.refreshOnFocus);
    this.catalogClient = client;
    this.catalogConnected = connected;
    this.catalogRequest++;
    this.realtimeStatusValue = "unknown";
    this.dictationStatusValue = "unknown";
    if (!client || !connected) {
      return;
    }
    if (eager || this.openValue) {
      window.addEventListener("focus", this.refreshOnFocus);
      void this.loadCatalog(false);
    }
  }

  readonly handleOpen = (): void => {
    if (this.openValue) {
      return;
    }
    this.openValue = true;
    window.addEventListener("focus", this.refreshOnFocus);
    this.deviceWatch ??= observeRealtimeTalkDevices(this.discover);
    this.discover();
    void this.loadCatalog();
  };

  readonly handleClose = (): void => {
    if (!this.openValue) {
      return;
    }
    this.release();
    this.openValue = false;
    if (!this.eagerCatalog) {
      window.removeEventListener("focus", this.refreshOnFocus);
    }
    this.requestUpdate();
  };

  /** Drops the devicechange subscription so a closed picker stops refreshing. */
  release(): void {
    this.deviceWatch?.();
    this.deviceWatch = null;
  }

  /** Ends an in-flight discovery too, so a late result cannot revive the list. */
  dispose(): void {
    window.removeEventListener("focus", this.refreshOnFocus);
    this.release();
    this.discoveryRequest++;
    this.catalogRequest++;
    this.catalogClient = null;
    this.catalogConnected = false;
    this.realtimeStatusValue = "unknown";
    this.dictationStatusValue = "unknown";
    this.openValue = false;
    this.loadingValue = false;
  }

  private readonly discover = (): void => {
    this.loadingValue = true;
    this.issueValue = null;
    const request = ++this.discoveryRequest;
    this.requestUpdate();
    // A closed or replaced picker cannot turn delayed discovery into a prompt.
    void discoverRealtimeTalkInputs(() => this.openValue && request === this.discoveryRequest)
      .then((result) => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.devicesValue = result.devices;
        this.issueValue = result.issue;
      })
      .catch(() => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.devicesValue = [];
        this.issueValue = "failed";
      })
      .finally(() => {
        if (request !== this.discoveryRequest) {
          return;
        }
        this.loadingValue = false;
        this.requestUpdate();
      });
  };

  /** Prepare only after voice intent; superseded connections never authorize capture. */
  async prepareDictation(): Promise<boolean | null> {
    const client = this.catalogClient;
    const pending = this.loadCatalog();
    const request = this.catalogRequest;
    const loaded = await pending;
    return request === this.catalogRequest && client === this.catalogClient && this.catalogConnected
      ? loaded && this.dictationStatusValue === "ready"
      : null;
  }

  private loadCatalog(notify = true): Promise<boolean> {
    const client = this.catalogClient;
    if (!client || !this.catalogConnected) {
      return Promise.resolve(false);
    }
    const request = ++this.catalogRequest;
    if (this.realtimeStatusValue === "unknown") {
      this.realtimeStatusValue = "checking";
    }
    if (this.dictationStatusValue === "unknown") {
      this.dictationStatusValue = "checking";
    }
    if (notify) {
      this.requestUpdate();
    }
    return client
      .request<TalkCatalogResult>("talk.catalog", {})
      .then((catalog) => {
        if (request !== this.catalogRequest) {
          return false;
        }
        this.realtimeStatusValue = catalog.realtime?.ready === true ? "ready" : "unavailable";
        this.dictationStatusValue = catalog.transcription?.ready === true ? "ready" : "unavailable";
        return true;
      })
      .catch(() => {
        if (request !== this.catalogRequest) {
          return false;
        }
        if (this.realtimeStatusValue === "checking") {
          this.realtimeStatusValue = "unknown";
        }
        if (this.dictationStatusValue === "checking") {
          this.dictationStatusValue = "unknown";
        }
        return false;
      })
      .finally(() => {
        if (request === this.catalogRequest) {
          this.requestUpdate();
        }
      });
  }
}
