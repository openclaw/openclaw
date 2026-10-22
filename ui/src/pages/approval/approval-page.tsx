import "../../styles/approval.css";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { onCleanup, Show, For } from "solid-js";
import {
  validateApprovalGetResult,
  validateApprovalResolveResult,
  type ApprovalDecision,
  type ApprovalGetResult,
  type ApprovalResolveResult,
  type ApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { controlUiPublicAssetPath } from "../../app/public-assets.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { createDocumentTitle } from "../../lib/reactive/document-title.ts";
import { formatDateTimeMs } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import {
  approvalTitle,
  decisionLabel,
  renderApprovalPresentation,
  terminalDescription,
  terminalTitle,
  type ResolutionOrigin,
} from "./approval-presentation.tsx";
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

function ApprovalChip(props: { kind: "plugin" | "tool" | "agent"; value?: string | null }) {
  return (
    <Show when={props.value?.trim()}>
      {(value) => (
        <span class="approval-page__chip mono" data-approval-chip={props.kind}>
          {value()}
        </span>
      )}
    </Show>
  );
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
    loading: boolean;
    resolvingDecision: ApprovalDecision | null;
    requestError: ApprovalRequestError;
    resolutionOrigin: ResolutionOrigin;
  } = {
    approval: null,
    connected: false,
    approvalsAccess: true,
    approvalGrantAccess: false,
    loading: true,
    resolvingDecision: null,
    requestError: null,
    resolutionOrigin: "observed",
  };
  let clientOwner: GatewayBrowserClient | null = null;
  let operationGeneration = 0;
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
      clearPollTimer();
      state.approval = null;
      state.loading = Boolean(id);
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
          state.loading = false;
          state.requestError =
            !state.approval || state.approval.status === "pending" ? "connection" : null;
        }
        return;
      }
      if (!state.approvalsAccess) {
        state.loading = false;
        state.requestError = null;
        return;
      }
      if (!approvalId()) {
        state.loading = false;
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
    const generation = ++operationGeneration;
    const previousStatus = state.approval?.status;
    let shouldFocusTerminal = false;
    clearPollTimer();
    if (!options.background) {
      state.loading = true;
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
      if (isCurrentOperation(client, generation, id)) {
        state.loading = false;
        schedulePoll();
        notify();
      }
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
    const isCurrentDecision = () =>
      isCurrentOperation(client, generation, id) && hasApprovalGrantAccess();
    let shouldFocusTerminal = false;
    let shouldRecoverCanonicalState = false;
    clearPollTimer();
    state.resolvingDecision = decision;
    state.requestError = null;
    notify();
    try {
      const result = await client.request<ApprovalResolveResult>("approval.resolve", {
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
    if (shouldRecoverCanonicalState && isCurrentDecision()) {
      await loadApproval({ background: true });
      return;
    }
    if (shouldFocusTerminal && isCurrentDecision()) {
      await focusTerminalState();
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

  const stopVisibility = listen(document, "visibilitychange", handleVisibilityChange);
  bindApprovalId(true);
  // Gateway receipts retire decisions and polls and redact approvals synchronously when access changes.
  const stopGateway = context.gateway.subscribe(applyGatewaySnapshot);
  applyGatewaySnapshot(context.gateway.snapshot);
  approvalIdHandlers.set(host, () => bindApprovalId());
  onCleanup(() => {
    approvalIdHandlers.delete(host);
    stopVisibility();
    stopGateway();
    operationGeneration += 1;
    clearPollTimer();
    clientOwner = null;
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

defineSolidBridge<ApprovalPageProps>(
  "openclaw-approval-page",
  (_props, host) => {
    const context = useApplication();
    const page = createApprovalPage(context, host);
    const read = page.read;
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
        disabled={!page.hasGatewayConnection() || !page.hasApprovalAccess() || read().loading}
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
          aria-busy={read().loading || read().resolvingDecision !== null ? "true" : "false"}
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
            ) : read().loading && !read().approval ? (
              renderState("loading")
            ) : disconnected() ? (
              renderState("connection")
            ) : read().requestError === "unavailable" || !read().approval ? (
              renderState("unavailable")
            ) : (
              <Show when={read().approval}>
                {(approval) => <ApprovalContent approval={approval()} page={page} retry={retry} />}
              </Show>
            )}
          </div>
        </section>
        <a class="approval-page__back-link" href={`${context.basePath}/chat`}>
          {t("approvalPage.openControlUi")}
        </a>
      </main>
    );
  },
  {
    properties: { approvalId: { default: "", attribute: "approval-id" } },
    propertyChanged: (host) => approvalIdHandlers.get(host)?.(),
  },
);

function ApprovalContent(props: {
  approval: ApprovalSnapshot;
  page: ReturnType<typeof createApprovalPage>;
  retry: (className: string) => JSX.Element;
}) {
  const pending = () => props.approval.status === "pending";
  const presentation = () => props.approval.presentation;
  const origin = () => props.page.read().resolutionOrigin;
  const pluginPresentation = () => {
    const value = presentation();
    return value.kind === "plugin" ? value : null;
  };
  const resolvedAt = () => {
    const approval = props.approval;
    return approval.status === "pending" ? approval.expiresAtMs : approval.resolvedAtMs;
  };
  return (
    <>
      <div class="approval-page__status" aria-live="polite" aria-atomic="true">
        <span
          class={[
            "approval-page__status-dot",
            `approval-page__status-dot--${props.approval.status}`,
          ]}
          aria-hidden="true"
        />
        {pending() ? t("approvalPage.pending") : terminalTitle(props.approval, origin())}
      </div>
      <div class="approval-page__heading">
        <h1
          ref={props.page.setHeading}
          id="approval-page-title"
          tabindex={pending() ? undefined : -1}
        >
          {approvalTitle(props.approval, origin())}
        </h1>
        <div class="approval-page__chips">
          <Show when={pluginPresentation()}>
            {(value) => (
              <>
                <ApprovalChip kind="plugin" value={value().pluginId} />
                <ApprovalChip kind="tool" value={value().toolName} />
              </>
            )}
          </Show>
          <ApprovalChip kind="agent" value={presentation().agentId} />
        </div>
        <p>
          {pending()
            ? t(
                props.page.hasApprovalGrantAccess()
                  ? "approvalPage.pendingDescription"
                  : "execApproval.reviewOnly",
              )
            : terminalDescription(props.approval, origin())}
        </p>
      </div>
      {renderApprovalPresentation(presentation())}
      <div class="approval-page__timing">
        <span>{pending() ? t("approvalPage.expiresLabel") : t("approvalPage.resolvedLabel")}</span>
        <time datetime={new Date(resolvedAt()).toISOString()}>
          {formatDateTimeMs(resolvedAt(), { dateStyle: "medium", timeStyle: "short" })}
        </time>
      </div>
      <Show when={props.page.read().requestError === "connection"}>
        <div class="approval-page__callout" role="alert">
          <div>
            <strong>{t("approvalPage.connectionErrorTitle")}</strong>
            <span>{t("approvalPage.connectionErrorDescription")}</span>
          </div>
          {props.retry("btn btn--sm")}
        </div>
      </Show>
      <Show
        when={pending()}
        fallback={
          <div class="approval-page__terminal" role="status">
            {t("approvalPage.safeToClose")}
          </div>
        }
      >
        <div
          class="approval-page__actions"
          role="group"
          aria-label={t("approvalPage.actionsLabel")}
        >
          <For each={presentation().allowedDecisions} keyed={(decision) => decision}>
            {(decision) => (
              <button
                type="button"
                class={["btn approval-page__action", `approval-page__action--${decision()}`]}
                data-decision={decision()}
                disabled={
                  props.page.read().resolvingDecision !== null ||
                  !props.page.hasGatewayConnection() ||
                  !props.page.hasApprovalGrantAccess() ||
                  props.page.read().requestError !== null
                }
                onClick={() => void props.page.resolveApproval(decision())}
              >
                {props.page.read().resolvingDecision === decision()
                  ? t("approvalPage.resolvingDecision", {
                      decision: decisionLabel(decision(), presentation()),
                    })
                  : decisionLabel(decision(), presentation())}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
