import type {
  DesktopSource,
  WorkerDesktopAppId,
  WorkerDesktopLaunchResult,
} from "@openclaw/gateway-protocol";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";

type LaunchTarget = {
  client: GatewayBrowserClient | null;
  source: DesktopSource | null;
  presented: boolean;
  state: DesktopPanelState;
  apps: readonly WorkerDesktopAppId[];
};

/** Keeps app-launch feedback scoped to the current desktop presentation. */
export class DesktopAppLauncher {
  app: WorkerDesktopAppId | null = null;
  error: string | null = null;
  private operationId = 0;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly target: () => LaunchTarget,
  ) {}

  clear(): void {
    this.operationId += 1;
    this.app = null;
    this.error = null;
    this.host.requestUpdate();
  }

  async launch(app: WorkerDesktopAppId): Promise<void> {
    const { client, source, presented, state, apps } = this.target();
    if (
      !client ||
      !presented ||
      source?.kind !== "environment" ||
      (state !== "connecting" && state !== "connected") ||
      !apps.includes(app) ||
      this.app === app
    ) {
      return;
    }
    const operationId = ++this.operationId;
    this.app = app;
    this.error = null;
    this.host.requestUpdate();
    try {
      await client.request<WorkerDesktopLaunchResult>("desktop.launch", { source, app });
    } catch (error) {
      if (operationId !== this.operationId) {
        return;
      }
      this.error = formatUiError(error);
    }
    if (operationId === this.operationId) {
      this.app = null;
      this.host.requestUpdate();
    }
  }
}
