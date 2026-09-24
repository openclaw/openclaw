import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import {
  validateApprovalHistoryResult,
  type ApprovalHistoryResult,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalTerminalReason,
  TerminalApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ExecApprovalGrantsListResult,
  ExecApprovalStandingGrant,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { parseApprovalResolvedEvent } from "../../app/exec-approval.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import {
  renderLearnMoreLink,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { i18n, t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

const APPROVAL_HISTORY_PAGE_SIZE = 50;

function grantStateLabel(grant: ExecApprovalStandingGrant, nowMs: number): string {
  if (grant.revokedAtMs !== null) {
    return t("standingGrants.stateRevoked");
  }
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
    return t("standingGrants.stateExpired");
  }
  if (grant.expiresAtMs !== null) {
    const days = Math.max(1, Math.ceil((grant.expiresAtMs - nowMs) / 86_400_000));
    return t("standingGrants.stateExpiresIn", { count: String(days) });
  }
  return t("standingGrants.stateUntilRevoked");
}

function grantIsActive(grant: ExecApprovalStandingGrant, nowMs: number): boolean {
  return grant.revokedAtMs === null && (grant.expiresAtMs === null || grant.expiresAtMs > nowMs);
}
const APPROVAL_HISTORY_REQUIRED_SCOPE = "operator.approvals";
const APPROVALS_DOCS_URL = "https://docs.openclaw.ai/tools/exec-approvals";

function formatResolvedAt(timestampMs: number): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

const APPROVAL_KIND_LABELS = {
  exec: "approvalHistory.kinds.exec",
  plugin: "approvalHistory.kinds.plugin",
  "system-agent": "approvalHistory.kinds.systemAgent",
} satisfies Record<ApprovalKind, string>;

const APPROVAL_STATUS_LABELS = {
  allowed: "approvalHistory.statuses.allowed",
  denied: "approvalHistory.statuses.denied",
  expired: "approvalHistory.statuses.expired",
  cancelled: "approvalHistory.statuses.cancelled",
} satisfies Record<TerminalApprovalSnapshot["status"], string>;

const APPROVAL_DECISION_LABELS = {
  "allow-once": "approvalHistory.decisions.allowOnce",
  "allow-always": "approvalHistory.decisions.allowAlways",
  deny: "approvalHistory.decisions.deny",
} satisfies Record<ApprovalDecision, string>;

const APPROVAL_REASON_LABELS = {
  user: "approvalHistory.reasons.user",
  timeout: "approvalHistory.reasons.timeout",
  "malformed-verdict": "approvalHistory.reasons.malformedVerdict",
  "no-route": "approvalHistory.reasons.noRoute",
  "run-aborted": "approvalHistory.reasons.runAborted",
  "gateway-restart": "approvalHistory.reasons.gatewayRestart",
  "storage-corrupt": "approvalHistory.reasons.storageCorrupt",
} satisfies Record<ApprovalTerminalReason, string>;

function requestLabel(item: TerminalApprovalSnapshot): string {
  const presentation = item.presentation;
  const request = presentation.kind === "exec" ? presentation.commandText : presentation.title;
  return request || t("approvalHistory.unknown");
}

function sourceLabel(item: TerminalApprovalSnapshot): string {
  const parts = [item.source?.agentId, item.source?.sessionKey].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : t("approvalHistory.unknown");
}

function resolverLabel(item: TerminalApprovalSnapshot): string {
  if (!item.resolver) {
    return t("approvalHistory.unknown");
  }
  return item.resolver.id ? `${item.resolver.kind} · ${item.resolver.id}` : item.resolver.kind;
}

class ApprovalsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private items: TerminalApprovalSnapshot[] = [];
  @state() private grants: ExecApprovalStandingGrant[] = [];
  @state() private grantsError: string | null = null;
  @state() private revokingGrantId: string | null = null;
  @state() private nextCursor: string | null = null;
  @state() private loading = false;
  @state() private loadingMore = false;
  @state() private error: string | null = null;
  @state() private connected = false;
  @state() private approvalsAccess = true;

  private client: GatewayBrowserClient | null = null;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private requestGeneration = 0;
  private hasLoaded = false;
  private historyRefreshPending = false;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      // A new gateway identity (even with the same client/connection) is a fresh
      // data source: invalidate in-flight requests and drop the previous
      // gateway's rows/cursor/error so stale history is not shown and "Load more"
      // cannot append across sources. Mirrors the client-change reset below.
      if (this.gatewaySource !== gateway) {
        this.resetHistory(true);
      }
      this.gatewaySource = gateway;
      this.applyGatewaySnapshot(gateway.snapshot);
      const stopSnapshots = gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway && this.context.gateway === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
      const stopEvents = gateway.subscribeEvents((event) => {
        if (
          this.gatewaySource !== gateway ||
          this.context.gateway !== gateway ||
          !this.approvalsAccess ||
          !readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals ||
          !parseApprovalResolvedEvent(event.event, event.payload)
        ) {
          return;
        }
        this.historyRefreshPending = true;
        if (!this.loading && !this.loadingMore) {
          void this.loadPage(true);
        }
      });
      return () => {
        stopSnapshots();
        stopEvents();
      };
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.resetHistory(false);
    this.gatewaySource = null;
    super.disconnectedCallback();
  }

  private resetHistory(clearData: boolean) {
    this.requestGeneration += 1;
    this.loading = false;
    this.loadingMore = false;
    this.historyRefreshPending = false;
    if (clearData) {
      this.hasLoaded = false;
      this.items = [];
      this.nextCursor = null;
      this.error = null;
    }
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const connectionChanged = (snapshot.phase === "connected") !== this.connected;
    const nextApprovalsAccess = readGatewayOperatorAccess(snapshot).canReviewApprovals;
    const approvalAccessChanged = nextApprovalsAccess !== this.approvalsAccess;
    this.connected = snapshot.phase === "connected";
    this.approvalsAccess = nextApprovalsAccess;
    if (clientChanged || approvalAccessChanged) {
      this.client = snapshot.client;
      this.resetHistory(true);
    } else if (connectionChanged) {
      this.resetHistory(false);
      if (snapshot.phase === "connected") {
        this.hasLoaded = false;
      }
    }
    if (
      snapshot.phase === "connected" &&
      snapshot.client &&
      this.approvalsAccess &&
      !this.hasLoaded &&
      !this.loading
    ) {
      void this.loadPage(true);
    }
  }

  private async loadPage(reset: boolean): Promise<void> {
    const client = this.client;
    const gateway = this.gatewaySource;
    if (
      !client ||
      !gateway ||
      !this.connected ||
      !this.approvalsAccess ||
      !readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals ||
      this.loading ||
      this.loadingMore
    ) {
      return;
    }
    const generation = this.requestGeneration;
    const cursor = reset ? undefined : (this.nextCursor ?? undefined);
    if (!reset && !cursor) {
      return;
    }
    if (reset) {
      this.historyRefreshPending = false;
      this.loading = true;
    } else {
      this.loadingMore = true;
    }
    this.error = null;
    const isCurrent = () =>
      this.isConnected &&
      this.connected &&
      this.approvalsAccess &&
      this.gatewaySource === gateway &&
      this.context.gateway === gateway &&
      gateway.snapshot.phase === "connected" &&
      readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals &&
      this.client === client &&
      this.requestGeneration === generation;
    try {
      const result = await client.request<ApprovalHistoryResult>("approval.history", {
        ...(cursor ? { cursor } : {}),
        limit: APPROVAL_HISTORY_PAGE_SIZE,
      });
      if (!validateApprovalHistoryResult(result)) {
        throw new Error(t("approvalHistory.invalidResponse"));
      }
      if (!isCurrent()) {
        return;
      }
      this.items = reset ? result.items : [...this.items, ...result.items];
      this.nextCursor = result.nextCursor ?? null;
      this.hasLoaded = true;
      if (reset) {
        void this.loadGrants(client, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
        this.hasLoaded = true;
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
        this.loadingMore = false;
        if (this.historyRefreshPending) {
          void this.loadPage(true);
        }
      }
    }
  }

  private async loadGrants(client: GatewayBrowserClient, isCurrent: () => boolean): Promise<void> {
    try {
      const result = await client.request<ExecApprovalGrantsListResult>(
        "exec.approval.grants.list",
        {},
      );
      if (!isCurrent()) {
        return;
      }
      this.grants = Array.isArray(result.grants) ? result.grants : [];
      this.grantsError = null;
    } catch (error) {
      if (isCurrent()) {
        this.grantsError = formatUiError(error);
      }
    }
  }

  private async revokeGrant(grantId: string): Promise<void> {
    const client = this.client;
    if (!client || this.revokingGrantId !== null) {
      return;
    }
    this.revokingGrantId = grantId;
    try {
      await client.request("exec.approval.grants.revoke", { grantId });
      const nowMs = Date.now();
      this.grants = this.grants.map((grant) =>
        grant.grantId === grantId ? { ...grant, revokedAtMs: nowMs } : grant,
      );
      this.grantsError = null;
    } catch (error) {
      this.grantsError = formatUiError(error);
    } finally {
      this.revokingGrantId = null;
    }
  }

  private renderGrants() {
    const nowMs = Date.now();
    return renderSettingsSection(
      {
        title: html`<span id="standing-grants-title">${t("standingGrants.title")}</span>`,
        description: t("standingGrants.description"),
        notice: this.grantsError
          ? html`<div class="callout danger" role="alert">${this.grantsError}</div>`
          : nothing,
      },
      html`
        <div class="data-table-container">
          <table
            class="data-table standing-grants-table settings-table--stacked"
            role="table"
            aria-labelledby="standing-grants-title"
          >
            <thead>
              <tr>
                <th scope="col">${t("standingGrants.columns.automation")}</th>
                <th scope="col">${t("standingGrants.columns.command")}</th>
                <th scope="col">${t("standingGrants.columns.uses")}</th>
                <th scope="col">${t("standingGrants.columns.state")}</th>
                <th scope="col"><span class="sr-only">${t("standingGrants.revoke")}</span></th>
              </tr>
            </thead>
            <tbody>
              ${
                this.grants.length === 0
                  ? html`
                      <tr>
                        <td colspan="5" class="data-table-empty-cell">
                          <div class="data-table-empty-state" role="status" aria-live="polite">
                            ${t("standingGrants.empty")}
                          </div>
                        </td>
                      </tr>
                    `
                  : this.grants.map(
                      (grant) => html`
                        <tr>
                          <td data-label=${t("standingGrants.columns.automation")}>
                            ${grant.cronJobName ?? grant.cronJobId}
                          </td>
                          <td class="mono" data-label=${t("standingGrants.columns.command")}>
                            ${grant.command}
                          </td>
                          <td data-label=${t("standingGrants.columns.uses")}>${grant.useCount}</td>
                          <td data-label=${t("standingGrants.columns.state")} aria-live="polite">
                            ${grantStateLabel(grant, nowMs)}
                          </td>
                          <td>
                            ${
                              grantIsActive(grant, nowMs)
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      aria-label=${`${
                                        this.revokingGrantId === grant.grantId
                                          ? t("standingGrants.revoking")
                                          : t("standingGrants.revoke")
                                      }: ${grant.cronJobName ?? grant.cronJobId} — ${grant.command}`}
                                      ?disabled=${this.revokingGrantId !== null}
                                      @click=${() => void this.revokeGrant(grant.grantId)}
                                    >
                                      ${
                                        this.revokingGrantId === grant.grantId
                                          ? t("standingGrants.revoking")
                                          : t("standingGrants.revoke")
                                      }
                                    </button>
                                  `
                                : nothing
                            }
                          </td>
                        </tr>
                      `,
                    )
              }
            </tbody>
          </table>
        </div>
      `,
    );
  }

  private renderTable() {
    if (this.loading && this.items.length === 0) {
      return renderSettingsLoadingSkeleton({ label: t("approvalHistory.loading") });
    }
    return html`
      <div class="data-table-container">
        <table
          class="data-table approval-history-table settings-table--stacked"
          role="table"
          aria-labelledby="approval-history-title"
          aria-busy=${this.loading || this.loadingMore ? "true" : "false"}
        >
          <thead>
            <tr>
              <th scope="col">${t("approvalHistory.columns.resolved")}</th>
              <th scope="col">${t("approvalHistory.columns.kind")}</th>
              <th scope="col">${t("approvalHistory.columns.request")}</th>
              <th scope="col">${t("approvalHistory.columns.decision")}</th>
              <th scope="col">${t("approvalHistory.columns.reason")}</th>
              <th scope="col">${t("approvalHistory.columns.source")}</th>
              <th scope="col">${t("approvalHistory.columns.resolver")}</th>
            </tr>
          </thead>
          <tbody>
            ${
              this.items.length === 0
                ? html`
                    <tr>
                      <td colspan="7" class="data-table-empty-cell">
                        <div class="data-table-empty-state" role="status" aria-live="polite">
                          ${
                            this.error || !this.hasLoaded
                              ? t("approvalHistory.unknown")
                              : t("approvalHistory.empty")
                          }
                        </div>
                      </td>
                    </tr>
                  `
                : this.items.map(
                    (item) => html`
                      <tr>
                        <td data-label=${t("approvalHistory.columns.resolved")}>
                          ${formatResolvedAt(item.resolvedAtMs)}
                        </td>
                        <td data-label=${t("approvalHistory.columns.kind")}>
                          ${t(APPROVAL_KIND_LABELS[item.presentation.kind])}
                        </td>
                        <td class="mono" data-label=${t("approvalHistory.columns.request")}>
                          ${requestLabel(item)}
                        </td>
                        <td data-label=${t("approvalHistory.columns.decision")}>
                          ${t(APPROVAL_STATUS_LABELS[item.status])} ·
                          ${t("decision" in item && item.decision ? APPROVAL_DECISION_LABELS[item.decision] : "approvalHistory.notApplicable")}
                        </td>
                        <td data-label=${t("approvalHistory.columns.reason")}>
                          ${t(APPROVAL_REASON_LABELS[item.reason])}
                        </td>
                        <td class="mono" data-label=${t("approvalHistory.columns.source")}>
                          ${sourceLabel(item)}
                        </td>
                        <td class="mono" data-label=${t("approvalHistory.columns.resolver")}>
                          ${resolverLabel(item)}
                        </td>
                      </tr>
                    `,
                  )
            }
          </tbody>
        </table>
      </div>
      <div class="data-table-pagination">
        <div class="data-table-pagination__info">${t("approvalHistory.retention")}</div>
        <div class="data-table-pagination__controls">
          ${
            this.nextCursor
              ? html`
                  <button ?disabled=${this.loadingMore} @click=${() => void this.loadPage(false)}>
                    ${
                      this.loadingMore
                        ? t("approvalHistory.loadingMore")
                        : t("approvalHistory.loadMore")
                    }
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    `;
  }

  override render() {
    const body = renderSettingsPage(
      html`
        ${
          !this.connected
            ? html`<div class="callout warn" role="status">${t("approvalHistory.offline")}</div>`
            : nothing
        }
        ${
          this.connected && !this.approvalsAccess
            ? html`
                <div class="callout warn" role="status">
                  ${t("common.disabled")} · <code>${APPROVAL_HISTORY_REQUIRED_SCOPE}</code>
                </div>
              `
            : nothing
        }
        ${
          this.approvalsAccess && this.error
            ? html`
                <div class="callout danger" role="alert">
                  ${this.error}
                  <button class="btn btn--sm" @click=${() => void this.loadPage(true)}>
                    ${t("common.retry")}
                  </button>
                </div>
              `
            : nothing
        }
        ${this.approvalsAccess ? this.renderGrants() : nothing}
        ${
          this.approvalsAccess
            ? renderSettingsSection(
                {
                  title: html`<span id="approval-history-title">
                    ${t("standingGrants.historyTitle")}
                  </span>`,
                },
                this.renderTable(),
              )
            : nothing
        }
      `,
      { wide: true },
    );
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("approvals"),
        subtitle: html`${t("approvalHistory.description")}
        ${renderLearnMoreLink(APPROVALS_DOCS_URL)}`,
      })}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-approvals-page")) {
  customElements.define("openclaw-approvals-page", ApprovalsPage);
}
