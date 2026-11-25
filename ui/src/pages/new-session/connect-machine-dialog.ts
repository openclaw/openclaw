import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { DevicePairJoinSetup } from "../../lib/device-pair-setup.ts";
import { formatUiError } from "../../lib/format-error.ts";

registerNewSessionSetupEnglish();

export type ConnectMachineRequest = {
  completion: Promise<void>;
  retired: Promise<void>;
  isCurrent: () => boolean;
  reportError: (error: unknown) => void;
};

// Closing, replacing the Gateway, or starting a newer request retires prior setup.
// Both the request token and open state fence late replies.
export class ConnectMachineSetupState {
  private openValue = false;
  private loadingValue = false;
  private errorValue: string | null = null;
  private setupValue: DevicePairJoinSetup | null = null;
  private requestId = 0;
  private request: ConnectMachineRequest | null = null;
  private retireRequest: (() => void) | undefined;
  private readonly requestListeners = new Set<(request: ConnectMachineRequest) => void>();

  readonly subscribeRequests = (listener: (request: ConnectMachineRequest) => void) => {
    const stop = registerListener(this.requestListeners, listener);
    if (this.request) {
      listener(this.request);
    }
    return stop;
  };

  constructor(
    private readonly gateway: () => { client: GatewayBrowserClient | null; connected: boolean },
    private readonly changed: () => void,
  ) {}

  get open(): boolean {
    return this.openValue;
  }

  start(): void {
    this.openValue = true;
    this.errorValue = null;
    this.setupValue = null;
    this.changed();
    void this.refresh();
  }

  close(): void {
    // Release presentation immediately; the admitted RPC still settles at its owner.
    this.retireRequest?.();
    this.retireRequest = undefined;
    this.request = null;
    this.requestId += 1;
    this.openValue = false;
    this.loadingValue = false;
    this.errorValue = null;
    this.setupValue = null;
  }

  view(enabled: boolean, onManageDevices: () => void) {
    return {
      open: this.open && enabled,
      loading: this.loadingValue,
      error: this.errorValue,
      setup: this.setupValue,
      subscribeRequests: this.subscribeRequests,
      onClose: () => {
        this.close();
        this.changed();
      },
      onRefresh: () => void this.refresh(),
      onManageDevices,
    };
  }

  refresh(): Promise<void> {
    if (!this.openValue || this.loadingValue) {
      return Promise.resolve();
    }
    const { client, connected } = this.gateway();
    if (!connected || !client) {
      this.errorValue = t("newSession.connectMachineUnavailable");
      this.changed();
      return Promise.resolve();
    }
    const requestId = ++this.requestId;
    this.loadingValue = true;
    this.errorValue = null;
    const lifetime = Promise.withResolvers<void>();
    this.retireRequest = lifetime.resolve;
    const completion = this.load(requestId, client);
    const request: ConnectMachineRequest = {
      completion,
      retired: lifetime.promise,
      isCurrent: () => this.loadingValue && this.stillCurrent(requestId, client),
      reportError: (error) => {
        if (this.stillCurrent(requestId, client)) {
          this.errorValue = formatUiError(error);
          this.changed();
        }
      },
    };
    this.request = request;
    this.changed();
    for (const listener of this.requestListeners) {
      listener(request);
    }
    return completion;
  }

  private async load(requestId: number, client: GatewayBrowserClient): Promise<void> {
    try {
      const { requestDevicePairJoinSetup } = await import("../../lib/device-pair-setup.ts");
      if (!this.stillCurrent(requestId, client)) {
        return;
      }
      const setup = await requestDevicePairJoinSetup(client);
      if (!this.stillCurrent(requestId, client)) {
        return;
      }
      if (!setup.joinUrl?.trim()) {
        this.setupValue = null;
        this.errorValue = t("newSession.connectMachineMissingUrl");
        return;
      }
      this.setupValue = setup;
    } catch (error) {
      if (this.stillCurrent(requestId, client)) {
        this.errorValue = formatUiError(error);
      }
    } finally {
      if (requestId === this.requestId) {
        this.request = null;
        this.loadingValue = false;
        this.changed();
      }
    }
  }

  private stillCurrent(requestId: number, client: GatewayBrowserClient): boolean {
    const gateway = this.gateway();
    return (
      requestId === this.requestId &&
      client === gateway.client &&
      gateway.connected &&
      this.openValue
    );
  }
}
