import {
  For,
  Loading,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  isPending,
  latest,
  onSettled,
} from "solid-js";
import {
  validateApprovalHistoryResult,
  type ApprovalHistoryResult,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import type { TerminalApprovalSnapshot } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ExecApprovalGrantsListResult,
  ExecApprovalStandingGrant,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { parseApprovalResolvedEvent } from "../../app/exec-approval.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsLoadingSkeleton,
  LearnMoreLink,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerApprovalsEnglish } from "../../i18n/locales/en-approvals.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createCompactMsFormatter, createMsFormatter } from "../../lib/format.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ApprovalErrorNotice } from "./approval-error-notice.tsx";
import { HistoryRow } from "./approval-history-row.tsx";
import { GrantRow } from "./standing-grant-row.tsx";

registerEnglishCatalog(registerApprovalsEnglish);

const APPROVAL_HISTORY_PAGE_SIZE = 50;

const APPROVAL_HISTORY_REQUIRED_SCOPE = "operator.approvals";
const APPROVALS_DOCS_URL = "https://docs.openclaw.ai/tools/exec-approvals";

function StandingGrantsEmpty(props: { loaded: boolean }) {
  return (
    <SettingsEmpty
      message={
        <span class="standing-grants-empty" data-empty-message={t("standingGrants.empty")}>
          <span>{t(props.loaded ? "standingGrants.empty" : "approvalHistory.unknown")}</span>
        </span>
      }
    />
  );
}

export function ApprovalsPage() {
  const context = useApplication();
  let disposed = false;
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const publish = () => setRevision((value) => value + 1);
  // Request admission stays synchronous; Solid observes these view-owned facts.
  const state: {
    items: TerminalApprovalSnapshot[];
    grants: ExecApprovalStandingGrant[];
    grantsLoaded: boolean;
    grantsError: string | null;
    revokingGrantId: string | null;
    nextCursor: string | null;
    loadKind: "reset" | "more" | null;
    error: string | null;
    connected: boolean;
    approvalsAccess: boolean;
    client: GatewayBrowserClient | null;
    gatewaySource: ApplicationContext["gateway"] | null;
    presentationScopeKey: number | null;
    requestGeneration: number;
    grantsGeneration: number;
    hasLoaded: boolean;
    historyRefreshPending: boolean;
  } = {
    items: [],
    grants: [],
    grantsLoaded: false,
    grantsError: null,
    revokingGrantId: null,
    nextCursor: null,
    loadKind: null,
    error: null,
    connected: false,
    approvalsAccess: true,
    client: null,
    gatewaySource: null,
    presentationScopeKey: null,
    requestGeneration: 0,
    grantsGeneration: 0,
    hasLoaded: false,
    historyRefreshPending: false,
  };
  const view = () => {
    revision();
    return state;
  };
  const historyItems = createMemo(() => view().items);
  const formatResolvedAt = createMemo(
    () => {
      // Refresh the system timezone with history, not unrelated grants or loading notices.
      historyItems();
      getLocale();
      // History is a rolling 30-day window: the row drops the year, and today's date.
      return {
        short: createCompactMsFormatter({
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
        full: createMsFormatter({ dateStyle: "medium", timeStyle: "short" }),
      };
    },
    { lazy: true },
  );
  type ReadReceipt = { generation: number; completion: Promise<void> };
  const [historyReceipt, setHistoryReceipt] = createSignal<ReadReceipt | null>(null);
  const [grantsReceipt, setGrantsReceipt] = createSignal<ReadReceipt | null>(null);
  const requestGeneration = createMemo(() => view().requestGeneration);
  let presentationLifetime = Promise.withResolvers<void>();
  // Observe admitted work, leaving rows and request authority with the plain owner.
  const historyRead = createMemo(() => {
    const generation = requestGeneration();
    const receipt = historyReceipt();
    return receipt?.generation === generation ? receipt.completion : undefined;
  });
  const grantsRead = createMemo(() => {
    const generation = requestGeneration();
    const receipt = grantsReceipt();
    return receipt?.generation === generation ? receipt.completion : undefined;
  });
  const historyLoadingKey = createMemo(() => (view().items.length === 0 ? historyReceipt() : null));
  const readHistory = () => {
    // Suspend the first read; retained owner rows must stay live during refresh.
    if (view().items.length === 0) {
      historyRead();
    } else {
      latest(historyRead);
    }
    return null;
  };
  const readGrants = () => {
    if (view().grantsLoaded) {
      latest(grantsRead);
    } else {
      grantsRead();
    }
    return null;
  };
  const loadingMore = () => isPending(historyRead) && view().loadKind === "more";
  const revokePresentation = createMemo(() => {
    const generation = requestGeneration();
    const [saving, setSaving] = createOptimistic(false);
    return { generation, saving, setSaving };
  });
  const presentRevoke = action(function* (
    presentation: ReturnType<typeof revokePresentation>,
    completion: Promise<void>,
    retired: Promise<void>,
  ) {
    if (!disposed && presentation.generation === state.requestGeneration) {
      presentation.setSaving(true);
    }
    yield Promise.race([completion, retired]);
  });
  const revokeSaving = () => revokePresentation().saving();
  let stopEvents: (() => void) | undefined;
  useGatewayPage({
    getGateway: () => context.gateway,
    onSnapshot: ({ snapshot, initial, sourceChanged }) => {
      if (initial || sourceChanged) {
        stopEvents?.();
        resetHistory(true);
        const gateway = context.gateway;
        state.gatewaySource = gateway;
        stopEvents = gateway.subscribeEvents((event) => {
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
      }
      applyGatewaySnapshot(snapshot);
    },
  });
  onSettled(() => () => {
    disposed = true;
    stopEvents?.();
    resetHistory(false);
    state.gatewaySource = null;
  });

  function resetHistory(clearData: boolean) {
    // Retire pending presentation before replacing its request scope.
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
    state.requestGeneration += 1;
    state.loadKind = null;
    state.historyRefreshPending = false;
    state.revokingGrantId = null;
    if (clearData) {
      state.grants = [];
      state.grantsLoaded = false;
      state.grantsError = null;
      state.hasLoaded = false;
      state.items = [];
      state.nextCursor = null;
      state.error = null;
    }
  }

  function applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const scopeKey = state.gatewaySource ? gatewayPresentationScope(state.gatewaySource).key : null;
    const identityChanged =
      snapshot.client !== state.client || scopeKey !== state.presentationScopeKey;
    state.presentationScopeKey = scopeKey;
    const connectionChanged = (snapshot.phase === "connected") !== state.connected;
    const nextApprovalsAccess =
      snapshot.phase === "connected"
        ? readGatewayOperatorAccess(snapshot).canReviewApprovals
        : state.approvalsAccess;
    const approvalAccessChanged = nextApprovalsAccess !== state.approvalsAccess;
    state.connected = snapshot.phase === "connected";
    state.approvalsAccess = nextApprovalsAccess;
    if (identityChanged || approvalAccessChanged) {
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
    // Standing grants remain revocable even when the history read stalls or fails.
    if (reset) {
      void loadGrants(client, isCurrent);
    }
    const completion = applyPage(client);
    setHistoryReceipt({
      generation,
      completion: Promise.race([completion, presentationLifetime.promise]),
    });
    return completion;

    async function applyPage(admittedClient: GatewayBrowserClient) {
      try {
        const result = await admittedClient.request<ApprovalHistoryResult>("approval.history", {
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
  }

  async function loadGrants(client: GatewayBrowserClient, isCurrent: () => boolean): Promise<void> {
    const generation = ++state.grantsGeneration;
    const canPublish = () => isCurrent() && state.grantsGeneration === generation;
    const completion = applyGrants();
    setGrantsReceipt({
      generation: state.requestGeneration,
      completion: Promise.race([completion, presentationLifetime.promise]),
    });
    return completion;

    async function applyGrants() {
      try {
        const result = await client.request<ExecApprovalGrantsListResult>(
          "exec.approval.grants.list",
          {},
        );
        if (!canPublish()) {
          return;
        }
        state.grants = result.grants;
        state.grantsLoaded = true;
        state.grantsError = null;
        publish();
      } catch (error) {
        if (canPublish()) {
          state.grantsError = formatUiError(error);
          publish();
        }
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
    const presentation = revokePresentation();
    const retired = presentationLifetime.promise;
    state.revokingGrantId = grantId;
    const completion = applyRevoke(client);
    await presentRevoke(presentation, completion, retired);

    async function applyRevoke(admittedClient: GatewayBrowserClient) {
      try {
        await admittedClient.request("exec.approval.grants.revoke", { grantId });
        if (!isCurrent()) {
          return;
        }
        state.grantsGeneration += 1;
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
  }

  return (
    <openclaw-approvals-page>
      <SettingsPageHeader
        title={t("tabs.approvals")}
        subtitle={
          <>
            {t("subtitles.approvals")} <LearnMoreLink url={APPROVALS_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <SettingsPage wide>
          {!view().connected ? (
            <InlineAlert tone="warning" role="status">
              {t("approvalHistory.offline")}
            </InlineAlert>
          ) : null}
          {view().connected && !view().approvalsAccess ? (
            <InlineAlert tone="warning" role="status">
              {t("common.disabled")} · <code>{APPROVAL_HISTORY_REQUIRED_SCOPE}</code>
            </InlineAlert>
          ) : null}
          {view().approvalsAccess ? (
            <ApprovalErrorNotice
              error={view().error}
              onRetry={() => void loadPage(true)}
              retryDisabled={!view().connected}
            />
          ) : null}
          {view().approvalsAccess ? (
            <>
              <SettingsSection
                title={<span id="standing-grants-title">{t("standingGrants.title")}</span>}
                description={t("standingGrants.description")}
                notice={<ApprovalErrorNotice error={view().grantsError} />}
              >
                <Loading on={requestGeneration()} fallback={<StandingGrantsEmpty loaded={false} />}>
                  {readGrants()}
                  {view().grants.length === 0 ? (
                    <StandingGrantsEmpty loaded={view().grantsLoaded} />
                  ) : (
                    <ul class="standing-grants" aria-labelledby="standing-grants-title">
                      <For each={view().grants} keyed={(grant) => grant.grantId}>
                        {(grant) => (
                          <GrantRow
                            grant={grant()}
                            revoking={revokeSaving() && view().revokingGrantId === grant().grantId}
                            disabled={revokeSaving() || !view().connected}
                            onRevoke={() => void revokeGrant(grant().grantId)}
                          />
                        )}
                      </For>
                    </ul>
                  )}
                </Loading>
              </SettingsSection>
              <SettingsSection
                title={<span id="approval-history-title">{t("standingGrants.historyTitle")}</span>}
              >
                <Loading
                  on={historyLoadingKey()}
                  fallback={<SettingsLoadingSkeleton label={t("approvalHistory.loading")} />}
                >
                  {readHistory()}
                  {view().items.length === 0 ? (
                    <SettingsEmpty
                      message={t(
                        view().error || !view().hasLoaded
                          ? "approvalHistory.unknown"
                          : "approvalHistory.empty",
                      )}
                    />
                  ) : (
                    <ul
                      class="approval-log"
                      aria-labelledby="approval-history-title"
                      aria-busy={isPending(historyRead) ? "true" : "false"}
                    >
                      <For each={historyItems()} keyed={(item) => item.id}>
                        {(item) => (
                          <HistoryRow
                            item={item()}
                            time={formatResolvedAt().short(item().resolvedAtMs)}
                            fullTime={formatResolvedAt().full(item().resolvedAtMs)}
                          />
                        )}
                      </For>
                    </ul>
                  )}
                  <div class="data-table-pagination">
                    <div class="data-table-pagination__info">{t("approvalHistory.retention")}</div>
                    <div class="data-table-pagination__controls">
                      {view().nextCursor ? (
                        <button
                          disabled={!view().connected || loadingMore()}
                          onClick={() => void loadPage(false)}
                        >
                          {t(
                            loadingMore()
                              ? "approvalHistory.loadingMore"
                              : "approvalHistory.loadMore",
                          )}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </Loading>
              </SettingsSection>
            </>
          ) : null}
        </SettingsPage>
      </SettingsWorkspace>
    </openclaw-approvals-page>
  );
}
