import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { MigrationsMemoryApplyResult, MigrationsMemoryPlanResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderMemoryImport } from "./view.ts";

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : typeof error === "string"
      ? error
      : "request failed";
}

export class MemoryImportPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private plan: MigrationsMemoryPlanResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private replaceExisting = false;
  @state() private selectedByProvider: Record<string, string[]> = {};
  @state() private applyingProviderId: string | null = null;
  @state() private pendingProviderId: string | null = null;
  @state() private applyError: string | null = null;
  @state() private lastResults: Record<string, MigrationsMemoryApplyResult> = {};

  private loadedKey: string | null = null;
  private requestedKey: string | null = null;
  private loadedClient: GatewayBrowserClient | null = null;
  private requestedClient: GatewayBrowserClient | null = null;
  private refreshEpoch = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
    );

  override disconnectedCallback() {
    this.refreshEpoch += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated() {
    const snapshot = this.context.gateway.snapshot;
    if (!snapshot.connected || !snapshot.client) {
      this.plan = null;
      this.loadedKey = null;
      this.requestedKey = null;
      this.loadedClient = null;
      this.requestedClient = null;
      return;
    }
    if (!this.context.agents.state.agentsList) {
      void this.context.agents.ensureList();
      return;
    }
    const agentId = this.currentAgentId();
    if (!agentId) {
      return;
    }
    const key = this.planKey(agentId);
    if (
      !this.loading &&
      (this.loadedClient !== snapshot.client || this.loadedKey !== key) &&
      (this.requestedClient !== snapshot.client || this.requestedKey !== key)
    ) {
      void this.refresh();
    }
  }

  private currentAgentId(): string | null {
    const list = this.context.agents.state.agentsList;
    if (!list) {
      return null;
    }
    const selected = this.context.agentSelection.state.selectedId;
    if (selected && list.agents.some((agent) => agent.id === selected)) {
      return selected;
    }
    return list.defaultId ?? list.agents[0]?.id ?? null;
  }

  private planKey(agentId: string): string {
    return `${agentId}:${this.replaceExisting ? "replace" : "safe"}`;
  }

  private async refresh(force = false) {
    const snapshot = this.context.gateway.snapshot;
    const agentId = this.currentAgentId();
    if (!snapshot.connected || !snapshot.client || !agentId || this.loading) {
      return;
    }
    const client = snapshot.client;
    const key = this.planKey(agentId);
    if (!force && this.loadedClient === client && this.loadedKey === key) {
      return;
    }
    const epoch = ++this.refreshEpoch;
    this.requestedKey = key;
    this.requestedClient = client;
    this.loading = true;
    this.error = null;
    try {
      const plan = await client.request<MigrationsMemoryPlanResult>("migrations.memory.plan", {
        agentId,
        overwrite: this.replaceExisting,
      });
      if (epoch !== this.refreshEpoch) {
        return;
      }
      this.plan = plan;
      this.loadedKey = key;
      this.loadedClient = client;
      this.selectedByProvider = Object.fromEntries(
        plan.providers.map((provider) => [
          provider.providerId,
          provider.items.filter((item) => item.status === "planned").map((item) => item.id),
        ]),
      );
    } catch (error) {
      if (epoch === this.refreshEpoch) {
        this.plan = null;
        this.error = toErrorMessage(error);
        // Record the attempted key so reactive updates keep the stable error.
        // The Refresh action explicitly retries with force=true.
        this.loadedKey = key;
        this.loadedClient = client;
      }
    } finally {
      if (epoch === this.refreshEpoch) {
        this.loading = false;
        this.requestedKey = null;
        this.requestedClient = null;
      }
    }
  }

  private selectAgent(agentId: string) {
    this.context.agentSelection.set(agentId);
    this.plan = null;
    this.loadedKey = null;
    this.requestedKey = null;
    this.loadedClient = null;
    this.requestedClient = null;
    this.applyError = null;
    this.lastResults = {};
  }

  private setReplaceExisting(enabled: boolean) {
    this.replaceExisting = enabled;
    this.plan = null;
    this.loadedKey = null;
    this.requestedKey = null;
    this.loadedClient = null;
    this.requestedClient = null;
    this.applyError = null;
    this.lastResults = {};
  }

  private toggleCollection(providerId: string, itemIds: readonly string[], selected: boolean) {
    const next = new Set(this.selectedByProvider[providerId] ?? []);
    for (const itemId of itemIds) {
      if (selected) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
    }
    this.selectedByProvider = { ...this.selectedByProvider, [providerId]: [...next] };
  }

  private requestImport(providerId: string) {
    if ((this.selectedByProvider[providerId]?.length ?? 0) === 0) {
      return;
    }
    this.applyError = null;
    this.pendingProviderId = providerId;
  }

  private async confirmImport() {
    if (this.applyingProviderId !== null) {
      return;
    }
    const providerId = this.pendingProviderId;
    const snapshot = this.context.gateway.snapshot;
    const agentId = this.currentAgentId();
    const itemIds = providerId ? (this.selectedByProvider[providerId] ?? []) : [];
    const planFingerprint = this.plan?.providers.find(
      (provider) => provider.providerId === providerId,
    )?.planFingerprint;
    if (!providerId || !snapshot.client || !agentId || !planFingerprint || itemIds.length === 0) {
      return;
    }
    this.applyingProviderId = providerId;
    this.applyError = null;
    try {
      const result = await snapshot.client.request<MigrationsMemoryApplyResult>(
        "migrations.memory.apply",
        {
          agentId,
          providerId,
          planFingerprint,
          itemIds,
          overwrite: this.replaceExisting,
        },
      );
      this.lastResults = { ...this.lastResults, [providerId]: result };
      this.pendingProviderId = null;
      this.loadedKey = null;
      this.requestedKey = null;
      this.loadedClient = null;
      this.requestedClient = null;
      await this.refresh(true);
    } catch (error) {
      this.pendingProviderId = null;
      this.applyError = toErrorMessage(error);
    } finally {
      this.applyingProviderId = null;
    }
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    const agentsList = this.context.agents.state.agentsList;
    const agentId = this.currentAgentId();
    const body = renderMemoryImport({
      connected: snapshot.connected,
      agents: agentsList?.agents ?? [],
      selectedAgentId: agentId,
      plan: this.plan,
      loading: this.loading,
      error: this.error,
      applyError: this.applyError,
      replaceExisting: this.replaceExisting,
      selectedByProvider: this.selectedByProvider,
      applyingProviderId: this.applyingProviderId,
      pendingProviderId: this.pendingProviderId,
      lastResults: this.lastResults,
      onSelectAgent: (nextAgentId) => this.selectAgent(nextAgentId),
      onReplaceExisting: (enabled) => this.setReplaceExisting(enabled),
      onRefresh: () => void this.refresh(true),
      onToggleCollection: (providerId, itemIds, selected) =>
        this.toggleCollection(providerId, itemIds, selected),
      onRequestImport: (providerId) => this.requestImport(providerId),
      onConfirmImport: () => void this.confirmImport(),
      onCancelImport: () => {
        this.pendingProviderId = null;
      },
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("memory-import")}</div>
          <div class="page-sub">${subtitleForRoute("memory-import")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-memory-import-page", MemoryImportPage);
