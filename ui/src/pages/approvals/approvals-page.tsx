import type { JSX } from "@solidjs/web";
import { For, createEffect, createSignal, onCleanup } from "solid-js";
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
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { parseApprovalResolvedEvent } from "../../app/exec-approval.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsLoadingSkeleton,
  LearnMoreLink,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { formatDateTimeMs } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PageLayout } from "../page-layout.tsx";

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

function EmptyRow(props: { columns: number; label: string }) {
  return (
    <tr>
      <td colspan={props.columns} class="data-table-empty-cell">
        <div class="data-table-empty-state" role="status" aria-live="polite">
          {props.label}
        </div>
      </td>
    </tr>
  );
}
function Cell(props: { labelKey: string; value: JSX.Element; mono?: boolean }) {
  return (
    <td class={props.mono ? "mono" : undefined} data-label={t(props.labelKey)}>
      {props.value}
    </td>
  );
}

function ApprovalsPageContent() {
  const context = useApplication();
  let disposed = false;
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const publish = () => setRevision((value) => value + 1);
  // Request admission stays synchronous; Solid observes these view-owned facts.
  const state: {
    items: TerminalApprovalSnapshot[];
    grants: ExecApprovalStandingGrant[];
    grantsError: string | null;
    revokingGrantId: string | null;
    nextCursor: string | null;
    loadKind: "reset" | "more" | null;
    error: string | null;
    connected: boolean;
    approvalsAccess: boolean;
    client: GatewayBrowserClient | null;
    gatewaySource: ApplicationContext["gateway"] | null;
    requestGeneration: number;
    hasLoaded: boolean;
    historyRefreshPending: boolean;
  } = {
    items: [],
    grants: [],
    grantsError: null,
    revokingGrantId: null,
    nextCursor: null,
    loadKind: null,
    error: null,
    connected: false,
    approvalsAccess: true,
    client: null,
    gatewaySource: null,
    requestGeneration: 0,
    hasLoaded: false,
    historyRefreshPending: false,
  };
  const view = () => {
    revision();
    return state;
  };

  createEffect(
    () => context.gateway,
    (gateway) => {
      resetHistory(true);
      state.gatewaySource = gateway;
      applyGatewaySnapshot(gateway.snapshot);
      const stopSnapshots = gateway.subscribe((snapshot) => {
        if (state.gatewaySource === gateway && context.gateway === gateway) {
          applyGatewaySnapshot(snapshot);
        }
      });
      const stopEvents = gateway.subscribeEvents((event) => {
        if (
          state.gatewaySource !== gateway ||
          context.gateway !== gateway ||
          !state.approvalsAccess ||
          !readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals ||
          !parseApprovalResolvedEvent(event.event, event.payload)
        ) {
          return;
        }
        state.historyRefreshPending = true;
        if (state.loadKind === null) {
          void loadPage(true);
        }
      });
      return () => {
        stopSnapshots();
        stopEvents();
        resetHistory(false);
        state.gatewaySource = null;
      };
    },
  );
  onCleanup(() => {
    disposed = true;
    resetHistory(false);
  });

  function resetHistory(clearData: boolean) {
    state.requestGeneration += 1;
    state.loadKind = null;
    state.historyRefreshPending = false;
    state.revokingGrantId = null;
    if (clearData) {
      state.grants = [];
      state.grantsError = null;
      state.hasLoaded = false;
      state.items = [];
      state.nextCursor = null;
      state.error = null;
    }
  }

  function applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== state.client;
    const connectionChanged = (snapshot.phase === "connected") !== state.connected;
    const nextApprovalsAccess = readGatewayOperatorAccess(snapshot).canReviewApprovals;
    const approvalAccessChanged = nextApprovalsAccess !== state.approvalsAccess;
    state.connected = snapshot.phase === "connected";
    state.approvalsAccess = nextApprovalsAccess;
    if (clientChanged || approvalAccessChanged) {
      state.client = snapshot.client;
      resetHistory(true);
    } else if (connectionChanged) {
      resetHistory(false);
      if (snapshot.phase === "connected") {
        state.hasLoaded = false;
      }
    }
    if (
      snapshot.phase === "connected" &&
      snapshot.client &&
      state.approvalsAccess &&
      !state.hasLoaded &&
      state.loadKind !== "reset"
    ) {
      void loadPage(true);
    }
    publish();
  }

  async function loadPage(reset: boolean): Promise<void> {
    const client = state.client;
    const gateway = state.gatewaySource;
    if (
      !client ||
      !gateway ||
      !state.connected ||
      !state.approvalsAccess ||
      !readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals ||
      state.loadKind !== null
    ) {
      return;
    }
    const generation = state.requestGeneration;
    const cursor = reset ? undefined : (state.nextCursor ?? undefined);
    if (!reset && !cursor) {
      return;
    }
    if (reset) {
      state.historyRefreshPending = false;
    }
    state.loadKind = reset ? "reset" : "more";
    state.error = null;
    publish();
    const isCurrent = () => isCurrentRequest(client, gateway, generation);
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
      state.items = reset ? result.items : [...state.items, ...result.items];
      state.nextCursor = result.nextCursor ?? null;
      state.hasLoaded = true;
      if (reset) {
        void loadGrants(client, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) {
        state.error = formatUiError(error);
        state.hasLoaded = true;
      }
    } finally {
      if (isCurrent()) {
        state.loadKind = null;
        publish();
        if (state.historyRefreshPending) {
          void loadPage(true);
        }
      }
    }
  }

  async function loadGrants(client: GatewayBrowserClient, isCurrent: () => boolean): Promise<void> {
    try {
      const result = await client.request<ExecApprovalGrantsListResult>(
        "exec.approval.grants.list",
        {},
      );
      if (!isCurrent()) {
        return;
      }
      state.grants = Array.isArray(result.grants) ? result.grants : [];
      state.grantsError = null;
      publish();
    } catch (error) {
      if (isCurrent()) {
        state.grantsError = formatUiError(error);
        publish();
      }
    }
  }

  function isCurrentRequest(
    client: GatewayBrowserClient,
    gateway: ApplicationContext["gateway"],
    generation: number,
  ): boolean {
    return (
      !disposed &&
      state.connected &&
      state.approvalsAccess &&
      state.gatewaySource === gateway &&
      context.gateway === gateway &&
      gateway.snapshot.phase === "connected" &&
      readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals &&
      state.client === client &&
      state.requestGeneration === generation
    );
  }

  async function revokeGrant(grantId: string): Promise<void> {
    const client = state.client;
    const gateway = state.gatewaySource;
    const generation = state.requestGeneration;
    if (
      !client ||
      !gateway ||
      state.revokingGrantId !== null ||
      !isCurrentRequest(client, gateway, generation)
    ) {
      return;
    }
    const isCurrent = () => isCurrentRequest(client, gateway, generation);
    state.revokingGrantId = grantId;
    publish();
    try {
      await client.request("exec.approval.grants.revoke", { grantId });
      if (!isCurrent()) {
        return;
      }
      const nowMs = Date.now();
      state.grants = state.grants.map((grant) =>
        grant.grantId === grantId ? { ...grant, revokedAtMs: nowMs } : grant,
      );
      state.grantsError = null;
      publish();
    } catch (error) {
      if (isCurrent()) {
        state.grantsError = formatUiError(error);
        publish();
      }
    } finally {
      if (isCurrent()) {
        state.revokingGrantId = null;
        publish();
      }
    }
  }

  function GrantRow(props: { grant: ExecApprovalStandingGrant }) {
    const revokeLabel = () =>
      t(
        view().revokingGrantId === props.grant.grantId
          ? "standingGrants.revoking"
          : "standingGrants.revoke",
      );
    return (
      <tr>
        <Cell
          labelKey="standingGrants.columns.automation"
          value={props.grant.cronJobName ?? props.grant.cronJobId}
        />
        <Cell labelKey="standingGrants.columns.command" value={props.grant.command} mono />
        <Cell labelKey="standingGrants.columns.uses" value={props.grant.useCount} />
        <td data-label={t("standingGrants.columns.state")} aria-live="polite">
          {grantStateLabel(props.grant, Date.now())}
        </td>
        <td>
          {grantIsActive(props.grant, Date.now()) ? (
            <button
              class="btn btn--sm"
              aria-label={`${revokeLabel()}: ${props.grant.cronJobName ?? props.grant.cronJobId} — ${props.grant.command}`}
              disabled={view().revokingGrantId !== null}
              onClick={() => void revokeGrant(props.grant.grantId)}
            >
              {revokeLabel()}
            </button>
          ) : null}
        </td>
      </tr>
    );
  }
  function HistoryRow(props: { item: TerminalApprovalSnapshot }) {
    return (
      <tr>
        <Cell
          labelKey="approvalHistory.columns.resolved"
          value={formatDateTimeMs(props.item.resolvedAtMs, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        />
        <Cell
          labelKey="approvalHistory.columns.kind"
          value={t(APPROVAL_KIND_LABELS[props.item.presentation.kind])}
        />
        <Cell labelKey="approvalHistory.columns.request" value={requestLabel(props.item)} mono />
        <Cell
          labelKey="approvalHistory.columns.decision"
          value={
            <>
              {t(APPROVAL_STATUS_LABELS[props.item.status])} ·{" "}
              {t(
                "decision" in props.item && props.item.decision
                  ? APPROVAL_DECISION_LABELS[props.item.decision]
                  : "approvalHistory.notApplicable",
              )}
            </>
          }
        />
        <Cell
          labelKey="approvalHistory.columns.reason"
          value={t(APPROVAL_REASON_LABELS[props.item.reason])}
        />
        <Cell labelKey="approvalHistory.columns.source" value={sourceLabel(props.item)} mono />
        <Cell labelKey="approvalHistory.columns.resolver" value={resolverLabel(props.item)} mono />
      </tr>
    );
  }
  return (
    <>
      <SettingsPageHeader
        title={t("tabs.approvals")}
        subtitle={
          <>
            {t("approvalHistory.description")} <LearnMoreLink url={APPROVALS_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <SettingsPage wide>
          {!view().connected ? (
            <div class="callout warn" role="status">
              {t("approvalHistory.offline")}
            </div>
          ) : null}
          {view().connected && !view().approvalsAccess ? (
            <div class="callout warn" role="status">
              {t("common.disabled")} · <code>{APPROVAL_HISTORY_REQUIRED_SCOPE}</code>
            </div>
          ) : null}
          {view().approvalsAccess && view().error ? (
            <div class="callout danger" role="alert">
              {view().error}
              <button class="btn btn--sm" onClick={() => void loadPage(true)}>
                {t("common.retry")}
              </button>
            </div>
          ) : null}
          {view().approvalsAccess ? (
            <>
              <SettingsSection
                title={<span id="standing-grants-title">{t("standingGrants.title")}</span>}
                description={t("standingGrants.description")}
                notice={
                  view().grantsError ? (
                    <div class="callout danger" role="alert">
                      {view().grantsError}
                    </div>
                  ) : null
                }
              >
                <div class="data-table-container">
                  <table
                    class="data-table standing-grants-table settings-table--stacked"
                    role="table"
                    aria-labelledby="standing-grants-title"
                  >
                    <thead>
                      <tr>
                        <th scope="col">{t("standingGrants.columns.automation")}</th>
                        <th scope="col">{t("standingGrants.columns.command")}</th>
                        <th scope="col">{t("standingGrants.columns.uses")}</th>
                        <th scope="col">{t("standingGrants.columns.state")}</th>
                        <th scope="col">
                          <span class="sr-only">{t("standingGrants.revoke")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {view().grants.length === 0 ? (
                        <EmptyRow columns={5} label={t("standingGrants.empty")} />
                      ) : (
                        <For each={view().grants} keyed={(grant) => grant.grantId}>
                          {(grant) => <GrantRow grant={grant()} />}
                        </For>
                      )}
                    </tbody>
                  </table>
                </div>
              </SettingsSection>
              <SettingsSection
                title={<span id="approval-history-title">{t("standingGrants.historyTitle")}</span>}
              >
                {view().loadKind === "reset" && view().items.length === 0 ? (
                  <SettingsLoadingSkeleton label={t("approvalHistory.loading")} />
                ) : (
                  <>
                    <div class="data-table-container">
                      <table
                        class="data-table approval-history-table settings-table--stacked"
                        role="table"
                        aria-labelledby="approval-history-title"
                        aria-busy={view().loadKind !== null ? "true" : "false"}
                      >
                        <thead>
                          <tr>
                            <For
                              each={[
                                "resolved",
                                "kind",
                                "request",
                                "decision",
                                "reason",
                                "source",
                                "resolver",
                              ]}
                            >
                              {(column) => (
                                <th scope="col">{t(`approvalHistory.columns.${column}`)}</th>
                              )}
                            </For>
                          </tr>
                        </thead>
                        <tbody>
                          {view().items.length === 0 ? (
                            <EmptyRow
                              columns={7}
                              label={t(
                                view().error || !view().hasLoaded
                                  ? "approvalHistory.unknown"
                                  : "approvalHistory.empty",
                              )}
                            />
                          ) : (
                            <For each={view().items} keyed={(item) => item.id}>
                              {(item) => <HistoryRow item={item()} />}
                            </For>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div class="data-table-pagination">
                      <div class="data-table-pagination__info">
                        {t("approvalHistory.retention")}
                      </div>
                      <div class="data-table-pagination__controls">
                        {view().nextCursor ? (
                          <button
                            disabled={view().loadKind === "more"}
                            onClick={() => void loadPage(false)}
                          >
                            {t(
                              view().loadKind === "more"
                                ? "approvalHistory.loadingMore"
                                : "approvalHistory.loadMore",
                            )}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </>
                )}
              </SettingsSection>
            </>
          ) : null}
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}

export const ApprovalsPage = defineSolidBridge(
  "openclaw-approvals-page",
  (_props, host) => (
    <PageLayout host={host}>
      <ApprovalsPageContent />
    </PageLayout>
  ),
  { properties: {} },
);
