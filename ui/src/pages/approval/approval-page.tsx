import "../../styles/approval.css";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show, For, untrack } from "solid-js";
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
import { formatDateTimeMs } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { renderApprovalPresentation } from "./approval-presentation.tsx";
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_MIN_POLL_DELAY_MS = 250;
const APPROVAL_REQUIRED_SCOPE = "operator.approvals";

type ApprovalRequestError = "connection" | "unavailable" | null;
type ResolutionOrigin = "here" | "elsewhere" | "observed";

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

function decisionLabel(decision: ApprovalDecision): string {
  return t(
    {
      "allow-once": "execApproval.allowOnce",
      "allow-always": "execApproval.alwaysAllow",
      deny: "execApproval.deny",
    }[decision],
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

function terminalTitle(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")) {
    return t("approvalPage.resolvedElsewhere");
  }
  if (origin === "here" && approval.status === "allowed") {
    return t("approvalPage.approvedHere");
  }
  if (origin === "here" && approval.status === "denied") {
    return t("approvalPage.deniedHere");
  }
  return t(
    {
      allowed: "approvalPage.approved",
      denied: "approvalPage.denied",
      expired: "approvalPage.expired",
      cancelled: "approvalPage.cancelled",
      pending: "approvalPage.pending",
    }[approval.status],
  );
}

function terminalDescription(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")) {
    return t("approvalPage.resolvedElsewhereDescription");
  }
  if (approval.status === "allowed") {
    return t(
      approval.decision === "allow-always"
        ? "approvalPage.allowedAlwaysDescription"
        : "approvalPage.allowedOnceDescription",
    );
  }
  return t(
    {
      denied: "approvalPage.deniedDescription",
      expired: "approvalPage.expiredDescription",
      cancelled: "approvalPage.cancelledDescription",
      pending: "approvalPage.pendingDescription",
    }[approval.status],
  );
}

function approvalTitle(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  return approval.status === "pending"
    ? approval.presentation.kind === "plugin"
      ? approval.presentation.title
      : t("approvalPage.execTitle")
    : terminalTitle(approval, origin);
}

type ApprovalPageProps = { approvalId: string };

/** Request admission remains synchronous; Solid observes the published revision. */
class ApprovalPageController {
  approval: ApprovalSnapshot | null = null;
  connected = false;
  approvalsAccess = true;
  approvalGrantAccess = false;
  loading = true;
  resolvingDecision: ApprovalDecision | null = null;
  requestError: ApprovalRequestError = null;
  resolutionOrigin: ResolutionOrigin = "observed";

  constructor(
    readonly context: ApplicationContext,
    private readonly props: ApprovalPageProps,
    private readonly host: HTMLElement,
    private readonly notify: () => void,
  ) {}
  get approvalId() {
    return untrack(() => this.props.approvalId);
  }
  private client: GatewayBrowserClient | null = null;
  private operationGeneration = 0;
  private pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private stopGateway: (() => void) | undefined;
  private boundApprovalId: string | undefined;
  private previousDocumentTitle: string | undefined;
  private activeDocumentTitle: string | undefined;

  connect() {
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.previousDocumentTitle = document.title;
    this.bindApprovalId(true);
    this.stopGateway = this.context.gateway.subscribe((snapshot) =>
      this.applyGatewaySnapshot(snapshot),
    );
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  dispose() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.operationGeneration += 1;
    this.clearPollTimer();
    this.client = null;
    this.connected = false;
    if (
      this.previousDocumentTitle !== undefined &&
      (!this.activeDocumentTitle || document.title === this.activeDocumentTitle)
    ) {
      document.title = this.previousDocumentTitle;
    }
  }

  bindApprovalId(force = false) {
    try {
      if (!force && this.boundApprovalId === this.approvalId) {
        return;
      }
      this.boundApprovalId = this.approvalId;
      this.operationGeneration += 1;
      this.clearPollTimer();
      this.approval = null;
      this.loading = Boolean(this.approvalId);
      this.resolvingDecision = null;
      this.requestError = this.approvalId ? null : "unavailable";
      this.resolutionOrigin = "observed";
      if (this.approvalId && this.connected && this.client && this.hasApprovalAccess) {
        void this.loadApproval();
      }
    } finally {
      this.notify();
    }
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    try {
      const clientChanged = snapshot.client !== this.client;
      const connectionChanged = (snapshot.phase === "connected") !== this.connected;
      const access = readGatewayOperatorAccess(snapshot);
      const approvalAccessChanged = access.canReviewApprovals !== this.approvalsAccess;
      const approvalGrantAccessChanged = access.canGrantApprovals !== this.approvalGrantAccess;
      this.client = snapshot.client;
      this.connected = snapshot.phase === "connected";
      this.approvalsAccess = access.canReviewApprovals;
      this.approvalGrantAccess = access.canGrantApprovals;
      if (
        clientChanged ||
        connectionChanged ||
        approvalAccessChanged ||
        approvalGrantAccessChanged
      ) {
        this.operationGeneration += 1;
        this.clearPollTimer();
        this.resolvingDecision = null;
      }
      if (!this.approvalsAccess) {
        // A revoke can arrive in the same snapshot as disconnect; redact before
        // the connection branch can preserve the previously visible command.
        this.approval = null;
      }
      if (snapshot.phase !== "connected" || !snapshot.client) {
        if (this.approvalId) {
          this.loading = false;
          this.requestError =
            !this.approval || this.approval.status === "pending" ? "connection" : null;
        }
        return;
      }
      if (!this.approvalsAccess) {
        this.loading = false;
        this.requestError = null;
        return;
      }
      if (!this.approvalId) {
        this.loading = false;
        this.requestError = "unavailable";
        return;
      }
      if (clientChanged || connectionChanged || approvalAccessChanged || !this.approval) {
        void this.loadApproval();
        return;
      }
      this.schedulePoll();
    } finally {
      this.notify();
    }
  }

  private isCurrentOperation(client: GatewayBrowserClient, generation: number, id: string) {
    return (
      this.hasGatewayConnection &&
      this.hasApprovalAccess &&
      this.client === client &&
      this.approvalId === id &&
      this.operationGeneration === generation
    );
  }

  get hasGatewayConnection(): boolean {
    return this.connected && Boolean(this.client);
  }

  get hasApprovalAccess(): boolean {
    return (
      this.approvalsAccess &&
      readGatewayOperatorAccess(this.context.gateway.snapshot).canReviewApprovals
    );
  }

  get hasApprovalGrantAccess(): boolean {
    return (
      this.approvalGrantAccess &&
      readGatewayOperatorAccess(this.context.gateway.snapshot).canGrantApprovals
    );
  }

  async loadApproval(options: { background?: boolean } = {}) {
    const client = this.client;
    const id = this.approvalId;
    if (!client || !this.connected || !id || !this.hasApprovalAccess) {
      return;
    }
    const generation = ++this.operationGeneration;
    const previousStatus = this.approval?.status;
    let shouldFocusTerminal = false;
    this.clearPollTimer();
    if (!options.background) {
      this.loading = true;
    }
    this.notify();
    try {
      const result = await client.request<ApprovalGetResult>("approval.get", { id });
      if (!this.isCurrentOperation(client, generation, id)) {
        return;
      }
      if (!validateApprovalGetResult(result) || result.approval.id !== id) {
        this.approval = null;
        this.requestError = "unavailable";
        return;
      }
      this.requestError = null;
      this.approval = result.approval;
      if (result.approval.status === "pending") {
        this.resolutionOrigin = "observed";
      } else if (previousStatus === "pending" && this.resolutionOrigin === "observed") {
        this.resolutionOrigin = "elsewhere";
        shouldFocusTerminal = true;
      }
    } catch (error) {
      if (!this.isCurrentOperation(client, generation, id)) {
        return;
      }
      if (isUnavailableApprovalError(error)) {
        this.approval = null;
        this.requestError = "unavailable";
      } else {
        this.requestError = "connection";
      }
    } finally {
      if (this.isCurrentOperation(client, generation, id)) {
        this.loading = false;
        this.schedulePoll();
        this.notify();
      }
    }
    if (shouldFocusTerminal && this.isCurrentOperation(client, generation, id)) {
      await this.focusTerminalState();
    }
  }

  async resolveApproval(decision: ApprovalDecision) {
    const approval = this.approval;
    const client = this.client;
    const id = this.approvalId;
    if (
      !client ||
      !this.connected ||
      !this.hasApprovalGrantAccess ||
      !id ||
      approval?.status !== "pending" ||
      !Array.prototype.includes.call(approval.presentation.allowedDecisions, decision) ||
      this.resolvingDecision !== null
    ) {
      return;
    }
    const kind = approval.presentation.kind;
    const generation = ++this.operationGeneration;
    const isCurrentDecision = () =>
      this.isCurrentOperation(client, generation, id) && this.hasApprovalGrantAccess;
    let shouldFocusTerminal = false;
    let shouldRecoverCanonicalState = false;
    this.clearPollTimer();
    this.resolvingDecision = decision;
    this.requestError = null;
    this.notify();
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
        this.requestError = "connection";
        shouldRecoverCanonicalState = true;
      } else {
        this.approval = result.approval;
        this.resolutionOrigin = result.applied ? "here" : "elsewhere";
        shouldFocusTerminal = true;
      }
    } catch (error) {
      if (!isCurrentDecision()) {
        return;
      }
      this.requestError = isUnavailableApprovalError(error) ? "unavailable" : "connection";
    } finally {
      if (isCurrentDecision()) {
        this.resolvingDecision = null;
        this.schedulePoll();
        this.notify();
      }
    }
    if (shouldRecoverCanonicalState && isCurrentDecision()) {
      await this.loadApproval({ background: true });
      return;
    }
    if (shouldFocusTerminal && isCurrentDecision()) {
      await this.focusTerminalState();
    }
  }

  private async focusTerminalState() {
    await Promise.resolve();
    if (this.approval?.status === "pending") {
      return;
    }
    const heading = this.host.querySelector<HTMLElement>("#approval-page-title");
    heading?.focus({ preventScroll: true });
    if (typeof heading?.scrollIntoView === "function") {
      heading.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    }
  }

  private clearPollTimer() {
    globalThis.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedulePoll() {
    this.clearPollTimer();
    const approval = this.approval;
    if (
      !this.hasGatewayConnection ||
      !this.hasApprovalAccess ||
      this.resolvingDecision !== null ||
      this.requestError === "unavailable" ||
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
    this.pollTimer = globalThis.setTimeout(() => {
      this.pollTimer = undefined;
      void this.loadApproval({ background: true });
    }, delay);
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      this.clearPollTimer();
      return;
    }
    if (
      this.approval?.status === "pending" &&
      this.hasGatewayConnection &&
      this.hasApprovalAccess &&
      this.resolvingDecision === null
    ) {
      void this.loadApproval({ background: true });
    }
  };

  documentTitle() {
    const pageTitle =
      this.connected && !this.approvalsAccess
        ? t("common.disabled")
        : this.requestError === "unavailable"
          ? t("approvalPage.unavailableTitle")
          : this.requestError === "connection" && !this.approval
            ? t("approvalPage.connectionErrorTitle")
            : this.approval
              ? approvalTitle(this.approval, this.resolutionOrigin)
              : t("approvalPage.loadingTitle");
    return `${pageTitle} — ${t("approvalPage.brandName")}`;
  }

  updateDocumentTitle(title: string) {
    document.title = title;
    this.activeDocumentTitle = title;
  }
}

function ApprovalPageContent(props: ApprovalPageProps & { host: HTMLElement }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const controller = new ApprovalPageController(
    context,
    props,
    untrack(() => props.host),
    () => setRevision((value) => value + 1),
  );
  const read = () => {
    revision();
    return controller;
  };
  untrack(() => controller.connect());
  onCleanup(() => controller.dispose());
  createEffect(
    () => props.approvalId,
    () => controller.bindApprovalId(),
  );
  createEffect(
    () => {
      revision();
      return controller.documentTitle();
    },
    (title) => controller.updateDocumentTitle(title),
  );
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
      disabled={!read().hasGatewayConnection || !read().hasApprovalAccess || read().loading}
      onClick={() => void controller.loadApproval()}
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
        <h1 id="approval-page-title">{t(title)}</h1>
        <p>
          {kind === "missing-scope" ? <code>{APPROVAL_REQUIRED_SCOPE}</code> : t(description[kind])}
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
              {(approval) => <ApprovalContent approval={approval()} read={read} retry={retry} />}
            </Show>
          )}
        </div>
      </section>
      <a class="approval-page__back-link" href={`${context.basePath}/chat`}>
        {t("approvalPage.openControlUi")}
      </a>
    </main>
  );
}

function ApprovalContent(props: {
  approval: ApprovalSnapshot;
  read: () => ApprovalPageController;
  retry: (className: string) => JSX.Element;
}) {
  const pending = () => props.approval.status === "pending";
  const presentation = () => props.approval.presentation;
  const origin = () => props.read().resolutionOrigin;
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
          class={`approval-page__status-dot approval-page__status-dot--${props.approval.status}`}
          aria-hidden="true"
        />
        {pending() ? t("approvalPage.pending") : terminalTitle(props.approval, origin())}
      </div>
      <div class="approval-page__heading">
        <h1 id="approval-page-title" tabindex={pending() ? undefined : -1}>
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
                props.read().hasApprovalGrantAccess
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
      <Show when={props.read().requestError === "connection"}>
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
                  props.read().resolvingDecision !== null ||
                  !props.read().hasGatewayConnection ||
                  !props.read().hasApprovalGrantAccess ||
                  props.read().requestError !== null
                }
                onClick={() => void props.read().resolveApproval(decision())}
              >
                {props.read().resolvingDecision === decision()
                  ? t("approvalPage.resolvingDecision", { decision: decisionLabel(decision()) })
                  : decisionLabel(decision())}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

defineSolidBridge<ApprovalPageProps>(
  "openclaw-approval-page",
  (props, host) => <ApprovalPageContent approvalId={props.approvalId} host={host} />,
  {
    properties: { approvalId: { default: "", attribute: "approval-id" } },
    connected: (host) => {
      if (!host.querySelector(".approval-page__brand")) {
        host.replaceChildren();
      }
    },
  },
);
