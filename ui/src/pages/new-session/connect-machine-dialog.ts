import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  requestDevicePairJoinSetup,
  type DevicePairJoinSetup,
} from "../../lib/device-pair-setup.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";

registerNewSessionSetupEnglish();

// Closing, replacing the Gateway, or starting a newer request retires prior setup.
// Both the request token and open state fence late replies.
export class ConnectMachineSetupState {
  private openValue = false;
  private loadingValue = false;
  private errorValue: string | null = null;
  private setupValue: DevicePairJoinSetup | null = null;
  private requestId = 0;

  constructor(
    private readonly gateway: () => { client: GatewayBrowserClient | null; connected: boolean },
    private readonly requestUpdate: () => void,
  ) {}

  get open(): boolean {
    return this.openValue;
  }

  start(): void {
    this.openValue = true;
    this.errorValue = null;
    this.setupValue = null;
    this.requestUpdate();
    void this.refresh();
  }

  close(): void {
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
      onClose: () => {
        this.close();
        this.requestUpdate();
      },
      onRefresh: () => void this.refresh(),
      onManageDevices,
    };
  }

  render(enabled: boolean, onManageDevices: () => void) {
    return solidContent(ConnectMachineDialog, this.view(enabled, onManageDevices));
  }

  async refresh(): Promise<void> {
    if (!this.openValue || this.loadingValue) {
      return;
    }
    const { client, connected } = this.gateway();
    if (!connected || !client) {
      this.errorValue = t("newSession.connectMachineUnavailable");
      this.requestUpdate();
      return;
    }
    const requestId = ++this.requestId;
    this.loadingValue = true;
    this.errorValue = null;
    this.requestUpdate();
    try {
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
        this.loadingValue = false;
        this.requestUpdate();
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
