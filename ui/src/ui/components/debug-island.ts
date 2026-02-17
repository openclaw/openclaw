import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { EventLogEntry } from "../types.ts";
import { gateway } from "../../services/gateway.ts";
import { renderDebug, type DebugProps } from "../views/debug.ts";

@customElement("debug-island")
export class DebugIsland extends LitElement {
  @state() private loading = false;
  @state() private status: Record<string, unknown> | null = null;
  @state() private health: Record<string, unknown> | null = null;
  @state() private models: unknown[] = [];
  @state() private heartbeat: unknown = null;
  @state() private eventLog: EventLogEntry[] = [];
  @state() private callMethod = "";
  @state() private callParams = "{}";
  @state() private callResult: string | null = null;
  @state() private callError: string | null = null;

  protected createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.loadData();
  }

  private async loadData() {
    this.loading = true;
    try {
      const [statusResult, healthResult] = await Promise.all([
        gateway.call<Record<string, unknown>>("status.get").catch(() => null),
        gateway.call<Record<string, unknown>>("health.check").catch(() => null),
      ]);
      this.status = statusResult;
      this.health = healthResult;
    } catch (err) {
      console.error("Failed to load debug data:", err);
    } finally {
      this.loading = false;
    }
  }

  private handleCallMethodChange(next: string) {
    this.callMethod = next;
  }

  private handleCallParamsChange(next: string) {
    this.callParams = next;
  }

  private async handleRefresh() {
    await this.loadData();
  }

  private async handleCall() {
    this.callResult = null;
    this.callError = null;
    try {
      const params = this.callParams.trim() ? JSON.parse(this.callParams) : undefined;
      const result = await gateway.call(this.callMethod, params);
      this.callResult = JSON.stringify(result, null, 2);
    } catch (err) {
      this.callError = err instanceof Error ? err.message : String(err);
    }
  }

  render() {
    const props: DebugProps = {
      loading: this.loading,
      status: this.status,
      health: this.health,
      models: this.models,
      heartbeat: this.heartbeat,
      eventLog: this.eventLog,
      callMethod: this.callMethod,
      callParams: this.callParams,
      callResult: this.callResult,
      callError: this.callError,
      onCallMethodChange: (next) => this.handleCallMethodChange(next),
      onCallParamsChange: (next) => this.handleCallParamsChange(next),
      onRefresh: () => void this.handleRefresh(),
      onCall: () => void this.handleCall(),
    };

    return html`${renderDebug(props)}`;
  }
}
