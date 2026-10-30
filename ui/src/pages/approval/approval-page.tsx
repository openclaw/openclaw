import "../../styles/approval.css";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  isPending,
  latest,
  Loading,
  onSettled,
  For,
} from "solid-js";
import {
  validateApprovalGetResult,
  validateApprovalResolveResult,
  type ApprovalDecision,
  type ApprovalGetResult,
  type ApprovalResolveResult,
  type ApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { controlUiPublicAssetPath } from "../../app/public-assets.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { createDocumentTitle } from "../../lib/reactive/document-title.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { ApprovalContent, approvalTitle, type ResolutionOrigin } from "./approval-presentation.tsx";
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_MIN_POLL_DELAY_MS = 250;
const APPROVAL_REQUIRED_SCOPE = "operator.approvals";

type ApprovalRequestError = "connection" | "unavailable" | null;

function isUnavailableApprovalError(error: unknown): boolean {
  if (!(error instanceof GatewayRequestError)) {
    return false;
  }
  const reason = isRecord(error.details) ? error.details.reason : undefined;
  return (
    reason === "APPROVAL_NOT_FOUND" ||
    error.gatewayCode === "APPROVAL_NOT_FOUND" ||
    error.gatewayCode === "INVALID_REQUEST"
  );
}

function appliedDecisionMatches(
  result: ApprovalResolveResult,
  decision: ApprovalDecision,
): boolean {
  if (!result.applied) {
    return true;
  }
  return decision === "deny"
    ? result.approval.status === "denied"
    : result.approval.status === "allowed" && result.approval.decision === decision;
}

type ApprovalPageProps = { approvalId: string };

const approvalIdHandlers = new WeakMap<HTMLElement, () => void>();

/** Approval admission stays synchronous; rendering observes the request owner's facts. */
function createApprovalPage(
  context: ApplicationContext,
  host: SolidBridgeElement<ApprovalPageProps>,
) {
  // The bridge owns this live value; callbacks must see changes before the next render.
  const approvalId = () => host.approvalId;
  const state: {
    approval: ApprovalSnapshot | null;
    connected: boolean;
    approvalsAccess: boolean;
    approvalGrantAccess: boolean;
    resolvingDecision: ApprovalDecision | null;
    requestError: ApprovalRequestError;
    resolutionOrigin: ResolutionOrigin;
  } = {
    approval: null,
    connected: false,
    approvalsAccess: true,
    approvalGrantAccess: false,
    resolvingDecision: null,
    requestError: null,
    resolutionOrigin: "observed",
  };
  // Observe admitted foreground reads without starting requests from a computation.
  let completion = Promise.withResolvers<void>();
  const [request, setRequest] = createSignal({ completion: completion.promise });
  function beginRead() {
    completion.resolve();
    completion = Promise.withResolvers<void>();
    setRequest({ completion: completion.promise });
  }
  const [optimisticDecision, setOptimisticDecision] = createOptimistic<ApprovalDecision | null>(
    null,
  );
  let presentationLifetime = Promise.withResolvers<void>();
  function retirePresentation() {
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
  }
  const presentDecision = action(function* (
    decision: ApprovalDecision,
    pending: Promise<void>,
    retired: Promise<void>,
    isCurrent: () => boolean,
  ) {
    if (isCurrent() && state.resolvingDecision !== null) {
      setOptimisticDecision(decision);
    }
    // Retiring the UI does not cancel an already admitted Gateway decision.
    yield Promise.race([pending, retired]);
  });
  let clientOwner: GatewayBrowserClient | null = null;
  let operationGeneration = 0;
  // Refreshes during an in-flight approval.get queue one follow-up instead of another request.
  let activeLookup:
    | { client: GatewayBrowserClient; id: string; generation: number; followUp: boolean }
    | undefined;
  let pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let boundApprovalId: string | undefined;
  let heading: HTMLHeadingElement | undefined;
  let notify = () => {};
  const view = projectSource(state, {
    read: (source) => source,
    subscribe: (_source, publish) => {
      notify = publish;
      return () => {
        notify = () => {};
      };
    },
    equality: "revision",
  });
  const hasGatewayConnection = (current = state) => current.connected && Boolean(clientOwner);
  const hasApprovalAccess = (current = state) =>
    current.approvalsAccess &&
    readGatewayOperatorAccess(context.gateway.snapshot).canReviewApprovals;
  const hasApprovalGrantAccess = (current = state) =>
    current.approvalGrantAccess &&
    readGatewayOperatorAccess(context.gateway.snapshot).canGrantApprovals;

  function bindApprovalId(force = false) {
    const id = approvalId();
    try {
      if (!force && boundApprovalId === id) {
        return;
      }
      boundApprovalId = id;
      operationGeneration += 1;
      retirePresentation();
      clearPollTimer();
      state.approval = null;
      beginRead();
      if (!id) {
        completion.resolve();
      }
      state.resolvingDecision = null;
      state.requestError = id ? null : "unavailable";
      state.resolutionOrigin = "observed";
      if (id && state.connected && clientOwner && hasApprovalAccess()) {
        const generation = operationGeneration;
        // Retire decisions immediately, but coalesce native ID writes before the lookup.
        queueMicrotask(() => {
          if (operationGeneration === generation) {
            void loadApproval({ id });
          }
        });
      }
    } finally {
      notify();
    }
  }

  function applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    try {
      const clientChanged = snapshot.client !== clientOwner;
      const connectionChanged = (snapshot.phase === "connected") !== state.connected;
      const access = readGatewayOperatorAccess(snapshot);
      const approvalAccessChanged = access.canReviewApprovals !== state.approvalsAccess;
      const approvalGrantAccessChanged = access.canGrantApprovals !== state.approvalGrantAccess;
      clientOwner = snapshot.client;
      state.connected = snapshot.phase === "connected";
      state.approvalsAccess = access.canReviewApprovals;
      state.approvalGrantAccess = access.canGrantApprovals;
      if (
        clientChanged ||
        connectionChanged ||
        approvalAccessChanged ||
        approvalGrantAccessChanged
      ) {
        operationGeneration += 1;
        retirePresentation();
        completion.resolve();
        clearPollTimer();
        state.resolvingDecision = null;
      }
      if (!state.approvalsAccess) {
        // A revoke can arrive in the same snapshot as disconnect; redact before
        // the connection branch can preserve the previously visible command.
        state.approval = null;
      }
      if (snapshot.phase !== "connected" || !snapshot.client) {
        if (approvalId()) {
          completion.resolve();
          state.requestError =
            !state.approval || state.approval.status === "pending" ? "connection" : null;
        }
        return;
      }
      if (!state.approvalsAccess) {
        completion.resolve();
        state.requestError = null;
        return;
      }
      if (!approvalId()) {
        completion.resolve();
        state.requestError = "unavailable";
        return;
      }
      if (clientChanged || connectionChanged || approvalAccessChanged || !state.approval) {
        void loadApproval();
        return;
      }
      schedulePoll();
    } finally {
      notify();
    }
  }

  function isCurrentOperation(client: GatewayBrowserClient, generation: number, id: string) {
    return (
      hasGatewayConnection() &&
      hasApprovalAccess() &&
      clientOwner === client &&
      approvalId() === id &&
      operationGeneration === generation
    );
  }

  async function loadApproval(options: { background?: boolean; id?: string } = {}) {
    const client = clientOwner;
    const id = options.id ?? approvalId();
    if (!client || !state.connected || !id || !hasApprovalAccess()) {
      return;
    }
    if (
      activeLookup?.generation === operationGeneration &&
      activeLookup.client === client &&
      activeLookup.id === id
    ) {
      activeLookup.followUp = true;
      if (!options.background) {
        beginRead();
        notify();
      }
      return;
    }
    const generation = ++operationGeneration;
    const lookup = (activeLookup = { client, id, generation, followUp: false });
    const previousStatus = state.approval?.status;
    let shouldFocusTerminal = false;
    clearPollTimer();
    if (!options.background) {
      beginRead();
    }
    notify();
    try {
      const result = await client.request<ApprovalGetResult>("approval.get", { id });
      if (!isCurrentOperation(client, generation, id)) {
        return;
      }
      if (!validateApprovalGetResult(result) || result.approval.id !== id) {
        state.approval = null;
        state.requestError = "unavailable";
        return;
      }
      state.requestError = null;
      state.approval = result.approval;
      if (result.approval.status === "pending") {
        state.resolutionOrigin = "observed";
      } else if (previousStatus === "pending" && state.resolutionOrigin === "observed") {
        state.resolutionOrigin = "elsewhere";
        shouldFocusTerminal = true;
      }
    } catch (error) {
      if (!isCurrentOperation(client, generation, id)) {
        return;
      }
      if (isUnavailableApprovalError(error)) {
        state.approval = null;
        state.requestError = "unavailable";
      } else {
        state.requestError = "connection";
      }
    } finally {
      if (activeLookup === lookup) {
        activeLookup = undefined;
      }
      if (isCurrentOperation(client, generation, id)) {
        // Retry can attach a foreground read receipt to this same lookup.
        completion.resolve();
        schedulePoll();
        notify();
      }
    }
    // Stale lookups returned above; a queued follow-up replaces the poll just armed.
    if (lookup.followUp && pollTimer !== undefined) {
      void loadApproval({ background: true });
    }
    if (shouldFocusTerminal && isCurrentOperation(client, generation, id)) {
      await focusTerminalState();
    }
  }

  async function resolveApproval(decision: ApprovalDecision) {
    const approval = state.approval;
    const client = clientOwner;
    const id = approvalId();
    if (
      !client ||
      !state.connected ||
      !hasApprovalGrantAccess() ||
      !id ||
      approval?.status !== "pending" ||
      !Array.prototype.includes.call(approval.presentation.allowedDecisions, decision) ||
      state.resolvingDecision !== null
    ) {
      return;
    }
    const kind = approval.presentation.kind;
    const generation = ++operationGeneration;
    completion.resolve();
    const isCurrentDecision = () =>
      isCurrentOperation(client, generation, id) && hasApprovalGrantAccess();
    const retired = presentationLifetime.promise;
    let shouldFocusTerminal = false;
    let shouldRecoverCanonicalState = false;
    clearPollTimer();
    state.resolvingDecision = decision;
    state.requestError = null;
    notify();
    const pending = applyDecision(client);
    // Publish the owner's admission before opening its optimistic transition.
    await Promise.resolve();
    try {
      await presentDecision(decision, pending, retired, isCurrentDecision);
    } catch (error) {
      if (isCurrentDecision()) {
        state.requestError = isUnavailableApprovalError(error) ? "unavailable" : "connection";
        notify();
      }
    }

    if (shouldRecoverCanonicalState && isCurrentDecision()) {
      await loadApproval({ background: true });
      return;
    }
    if (shouldFocusTerminal && isCurrentDecision()) {
      await focusTerminalState();
    }

    async function applyDecision(admittedClient: GatewayBrowserClient) {
      try {
        const result = await admittedClient.request<ApprovalResolveResult>("approval.resolve", {
          id,
          kind,
          decision,
        });
        if (!isCurrentDecision()) {
          return;
        }
        if (
          !validateApprovalResolveResult(result) ||
          result.approval.id !== id ||
          result.approval.presentation.kind !== kind ||
          !appliedDecisionMatches(result, decision)
        ) {
          // The write outcome is unknown. Keep every decision disabled until a
          // fresh, strictly validated read establishes canonical Gateway truth.
          state.requestError = "connection";
          shouldRecoverCanonicalState = true;
        } else {
          state.approval = result.approval;
          state.resolutionOrigin = result.applied ? "here" : "elsewhere";
          shouldFocusTerminal = true;
        }
      } catch (error) {
        if (!isCurrentDecision()) {
          return;
        }
        state.requestError = isUnavailableApprovalError(error) ? "unavailable" : "connection";
      } finally {
        if (isCurrentDecision()) {
          state.resolvingDecision = null;
          schedulePoll();
          notify();
        }
      }
    }
  }

  async function focusTerminalState() {
    await Promise.resolve();
    if (state.approval?.status === "pending") {
      return;
    }
    heading?.focus({ preventScroll: true });
    if (typeof heading?.scrollIntoView === "function") {
      heading.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    }
  }

  function clearPollTimer() {
    globalThis.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll() {
    clearPollTimer();
    const approval = state.approval;
    if (
      !hasGatewayConnection() ||
      !hasApprovalAccess() ||
      state.resolvingDecision !== null ||
      state.requestError === "unavailable" ||
      approval?.status !== "pending" ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const untilDeadline = approval.expiresAtMs - Date.now();
    const delay = Math.max(
      APPROVAL_MIN_POLL_DELAY_MS,
      Math.min(APPROVAL_POLL_INTERVAL_MS, untilDeadline + APPROVAL_MIN_POLL_DELAY_MS),
    );
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = undefined;
      void loadApproval({ background: true });
    }, delay);
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      clearPollTimer();
      return;
    }
    if (
      state.approval?.status === "pending" &&
      hasGatewayConnection() &&
      hasApprovalAccess() &&
      state.resolvingDecision === null
    ) {
      void loadApproval({ background: true });
    }
  };

  onSettled(() => {
    const stopVisibility = listen(document, "visibilitychange", handleVisibilityChange);
    bindApprovalId(true);
    // Gateway receipts retire decisions and polls and redact approvals synchronously when access changes.
    const stopGateway = context.gateway.subscribe(applyGatewaySnapshot);
    applyGatewaySnapshot(context.gateway.snapshot);
    approvalIdHandlers.set(host, () => bindApprovalId());
    return () => {
      approvalIdHandlers.delete(host);
      stopVisibility();
      stopGateway();
      operationGeneration += 1;
      retirePresentation();
      completion.resolve();
      clearPollTimer();
      clientOwner = null;
    };
  });
  createDocumentTitle(() => {
    const current = view.read();
    const pageTitle =
      current.connected && !current.approvalsAccess
        ? t("common.disabled")
        : current.requestError === "unavailable"
          ? t("approvalPage.unavailableTitle")
          : current.requestError === "connection" && !current.approval
            ? t("approvalPage.connectionErrorTitle")
            : current.approval
              ? approvalTitle(current.approval, current.resolutionOrigin)
              : t("approvalPage.loadingTitle");
    return `${pageTitle} — ${t("approvalPage.brandName")}`;
  });
  return {
    read: view.read,
    resolvingDecision: () => optimisticDecision() ?? view.read().resolvingDecision,
    request,
    hasGatewayConnection: () => hasGatewayConnection(view.read()),
    hasApprovalAccess: () => hasApprovalAccess(view.read()),
    hasApprovalGrantAccess: () => hasApprovalGrantAccess(view.read()),
    loadApproval,
    resolveApproval,
    setHeading: (element: HTMLHeadingElement) => {
      heading = element;
    },
  };
}

export const ApprovalPage = defineSolidBridge<ApprovalPageProps>(
  "openclaw-approval-page",
  (_props, host) => {
    const context = useApplication();
    const page = createApprovalPage(context, host);
    const initialRead = createMemo(() => (page.read().approval ? null : page.request()));
    function ReadyFrame() {
      const ready = createMemo(() => page.request().completion);
      const read = () => {
        if (!page.read().approval) {
          ready();
          return page.read();
        }
        latest(ready);
        return page.read();
      };
      const loading = () => {
        read();
        return isPending(ready);
      };
      return <Frame read={read} loading={loading()} />;
    }
    function Frame(props: { loading: boolean; read?: typeof page.read }) {
      const read = () => (props.read ?? page.read)();
      const approvals = () => {
        const approval = read().approval;
        return approval ? [approval] : [];
      };
      const missingScope = () => read().connected && !read().approvalsAccess;
      const disconnected = () => read().requestError === "connection" && !read().approval;
      const documentState = () =>
        missingScope()
          ? "missing-scope"
          : read().requestError === "unavailable"
            ? "unavailable"
            : disconnected()
              ? "connection-error"
              : (read().approval?.status ?? "loading");
      const severity = () => {
        const active = read().approval?.presentation;
        const raw = active?.kind === "plugin" ? active.severity?.trim().toLowerCase() : null;
        return active?.kind === "exec" || raw === "warning" || raw === "warn"
          ? "warning"
          : raw === "danger" || raw === "critical" || raw === "error"
            ? "danger"
            : "info";
      };
      const retry = (className: string) => (
        <button
          type="button"
          class={className}
          disabled={!page.hasGatewayConnection() || !page.hasApprovalAccess() || props.loading}
          onClick={() => void page.loadApproval()}
        >
          {t("approvalPage.retry")}
        </button>
      );
      const renderState = (kind: "loading" | "unavailable" | "missing-scope" | "connection") => {
        const title = {
          loading: "approvalPage.loadingTitle",
          unavailable: "approvalPage.unavailableTitle",
          "missing-scope": "common.disabled",
          connection: "approvalPage.connectionErrorTitle",
        }[kind];
        const description = {
          loading: "approvalPage.loadingDescription",
          unavailable: "approvalPage.unavailableDescription",
          connection: "approvalPage.connectionErrorDescription",
        };
        return (
          <div
            class={[
              "approval-page__state",
              `approval-page__state--${kind === "missing-scope" ? "unavailable" : kind}`,
            ]}
            role={kind === "loading" ? "status" : "alert"}
          >
            {kind === "loading" ? (
              <div class="approval-page__spinner" aria-hidden="true" />
            ) : (
              <div class="approval-page__state-mark" aria-hidden="true">
                !
              </div>
            )}
            <h1 ref={page.setHeading} id="approval-page-title">
              {t(title)}
            </h1>
            <p>
              {kind === "missing-scope" ? (
                <code>{APPROVAL_REQUIRED_SCOPE}</code>
              ) : (
                t(description[kind])
              )}
            </p>
            {kind === "connection" ? retry("btn") : null}
          </div>
        );
      };
      return (
        <main class="approval-page" data-state={documentState()}>
          <div class="approval-page__backdrop" aria-hidden="true" />
          <section
            class={["approval-page__card", `approval-page__card--severity-${severity()}`]}
            aria-labelledby="approval-page-title"
            aria-busy={props.loading || page.resolvingDecision() !== null ? "true" : "false"}
          >
            <header class="approval-page__brand">
              <img
                class="approval-page__logo"
                src={controlUiPublicAssetPath("apple-touch-icon.png", context.resourceBasePath)}
                alt=""
              />
              <div>
                <div class="approval-page__eyebrow">{t("approvalPage.eyebrow")}</div>
                <div class="approval-page__brand-name">{t("approvalPage.brandName")}</div>
              </div>
            </header>
            <div class="approval-page__content">
              {missingScope() ? (
                renderState("missing-scope")
              ) : props.loading && !read().approval ? (
                renderState("loading")
              ) : disconnected() ? (
                renderState("connection")
              ) : read().requestError === "unavailable" || !read().approval ? (
                renderState("unavailable")
              ) : (
                <For each={approvals()} keyed={(approval) => approval.id}>
                  {(approval) => (
                    <ApprovalContent approval={approval()} page={page} retry={retry} />
                  )}
                </For>
              )}
            </div>
          </section>
          <a class="approval-page__back-link" href={`${context.basePath}/chat`}>
            {t("approvalPage.openControlUi")}
          </a>
        </main>
      );
    }
    return (
      <Loading on={initialRead()} fallback={<Frame loading={true} />}>
        <ReadyFrame />
      </Loading>
    );
  },
  {
    properties: { approvalId: { default: "", attribute: "approval-id" } },
    propertyChanged: (host) => approvalIdHandlers.get(host)?.(),
  },
);
