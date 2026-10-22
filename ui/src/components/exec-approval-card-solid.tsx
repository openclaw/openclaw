import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import { normalizeCommandSpans } from "../../../src/shared/exec-approval-command-spans.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  compactApprovalCommand,
  summarizeApprovalScopeLabel,
} from "../app/approval-presentation.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { registerApprovalsEnglish } from "../i18n/locales/en-approvals.ts";
import { formatCountdown } from "../lib/format.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import { sidebarAttentionFocusRef } from "./sidebar-attention-focus.ts";
import { Icon } from "./solid/icon.tsx";
import { useScrollState } from "./solid/scroll-state.ts";

registerEnglishCatalog(registerApprovalsEnglish);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-approval-countdown": HTMLAttributes<HTMLElement>;
      "openclaw-sidebar-approval-row": HTMLAttributes<HTMLElement>;
    }
  }
}

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
const MOBILE_DECISION_ORDER = [
  "allow-always",
  "deny",
  "allow-once",
] as const satisfies readonly ExecApprovalDecision[];
const MODAL_DECISION_ORDER = [
  "deny",
  "allow-always",
  "allow-once",
] as const satisfies readonly ExecApprovalDecision[];

export type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  sourceSession?: GatewaySessionRow;
  busy: boolean;
  connected: boolean;
  canGrant: boolean;
  error: string | null;
  variant: "inline" | "modal";
  /** The mobile composer opts in using native mobile presentation facts, not pane width. */
  presentation?: "mobile";
  queueCount?: number;
  renderPendingQueue?: () => SolidJSX.Element;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

export type SidebarApprovalRowProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  connected: boolean;
  canGrant: boolean;
  error: string | null;
  openSessionHref?: string;
  sessionTitle?: string | null;
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onOpenSession?: (event: MouseEvent) => void;
};

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs, true) })
    : t("execApproval.expired");
}

function useApprovalClock(onTick?: (nowMs: number) => void) {
  const [now, setNow] = createSignal(Date.now());
  onSettled(() => {
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      onTick?.(time);
    }, 1_000);
    return () => clearInterval(timer);
  });
  return now;
}

export function ApprovalCountdown(
  props: Pick<
    SolidJSX.HTMLAttributes<HTMLElement>,
    "class" | "role" | "aria-label" | "aria-hidden" | "title"
  > & { expiresAtMs: number; compact?: boolean },
) {
  let host: HTMLElement | undefined;
  const now = useApprovalClock((time) => {
    if (!props.compact) {
      host
        ?.closest("openclaw-modal-dialog")
        ?.setAttribute("description", approvalRemainingLabel(props.expiresAtMs, time));
    }
  });
  return (
    <openclaw-approval-countdown
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
      class={props.class}
      role={props.role}
      aria-label={props["aria-label"]}
      aria-hidden={props["aria-hidden"]}
      title={props.title}
    >
      {props.compact
        ? formatCountdown(props.expiresAtMs, now(), true)
        : approvalRemainingLabel(props.expiresAtMs, now())}
    </openclaw-approval-countdown>
  );
}

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return undefined;
  }
  return (
    <div class="exec-approval-meta-row">
      <span>{label}</span>
      <span>{opts?.path ? formatApprovalDisplayPath(value) : value}</span>
    </div>
  );
}

function ExecApprovalCommand(props: {
  request: ExecApprovalRequestPayload;
  scrollState?: (element: HTMLDivElement) => void;
}) {
  const parts = createMemo(() => {
    const request = props.request;
    const spans =
      normalizeCommandSpans([...(request.commandSpans ?? [])], request.command.length) ?? [];
    const result = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.startIndex > cursor) {
        result.push(request.command.slice(cursor, span.startIndex));
      }
      result.push(
        <mark class="exec-approval-command-span">
          {request.command.slice(span.startIndex, span.endIndex)}
        </mark>,
      );
      cursor = span.endIndex;
    }
    if (cursor < request.command.length) {
      result.push(request.command.slice(cursor));
    }
    return result;
  });
  return (
    <div class="exec-approval-command mono" ref={props.scrollState}>
      {parts()}
    </div>
  );
}

function renderDetails(content: SolidJSX.Element) {
  return (
    <details class="exec-approval-details">
      <summary>{t("execApproval.details")}</summary>
      <div class="exec-approval-meta">{content}</div>
    </details>
  );
}

function renderChip(kind: "plugin" | "agent", id?: string | null) {
  return id ? (
    <span class="exec-approval-chip mono" data-approval-chip={kind}>
      {id}
    </span>
  ) : undefined;
}

function renderExecBody(
  request: ExecApprovalRequestPayload,
  variant: ExecApprovalCardProps["variant"],
) {
  return (
    <>
      {" "}
      <ExecApprovalCommand request={request} />
      {request.scope ? (
        <div class="exec-approval-scope">{summarizeApprovalScopeLabel(request.scope)}</div>
      ) : undefined}
      <div class="exec-approval-meta">
        {renderMetaRow(t("execApproval.labels.host"), request.host)}
        {renderMetaRow(t("execApproval.labels.cwd"), request.cwd, { path: true })}
      </div>
      {renderDetails(
        <>
          {renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
          {renderMetaRow(t("execApproval.labels.security"), request.security)}
          {renderMetaRow(t("execApproval.labels.ask"), request.ask)}
          {variant === "modal"
            ? renderMetaRow(t("execApproval.labels.session"), request.sessionKey)
            : undefined}
        </>,
      )}
    </>
  );
}

function MobileExecApprovalBody(props: { request: ExecApprovalRequestPayload }) {
  const commandScrollState = useScrollState(true, false);
  let disclosure: HTMLDetailsElement;
  let metadata: HTMLDivElement;
  let animation: Animation | undefined;
  let opening: boolean | undefined;

  function toggle(event: MouseEvent) {
    event.preventDefault();
    const open = !(opening ?? disclosure.open);
    const start = disclosure.getBoundingClientRect().height;
    animation?.cancel();
    animation = undefined;
    opening = undefined;
    disclosure.open = open;
    metadata.inert = !open;
    if (
      event.detail === 0 ||
      disclosure.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const end = disclosure.getBoundingClientRect().height;
    // Keep the expanded content painted during exit; the native disclosure owns
    // the settled state. Reversing starts at its current rendered height.
    disclosure.open = true;
    opening = open;
    animation = disclosure.animate([{ height: `${start}px` }, { height: `${end}px` }], {
      duration: 300,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    });
    animation.onfinish = () => {
      disclosure.open = open;
      opening = undefined;
      animation = undefined;
    };
  }

  onSettled(() => () => animation?.cancel());

  return (
    <>
      <details class="exec-approval-mobile-disclosure" ref={(element) => (disclosure = element)}>
        <summary class="exec-approval-mobile-summary" onClick={toggle}>
          <Icon name="terminal" class="exec-approval-mobile-terminal" />
          <ExecApprovalCommand request={props.request} scrollState={commandScrollState} />
          <Icon name="chevronDown" class="exec-approval-mobile-chevron" />
        </summary>
        <div class="exec-approval-mobile-metadata" ref={(element) => (metadata = element)}>
          <Show
            when={
              props.request.host ||
              props.request.cwd ||
              props.request.resolvedPath ||
              props.request.security ||
              props.request.ask
            }
          >
            <div class="exec-approval-meta">
              <div class="exec-approval-mobile-host">
                {renderMetaRow(t("execApproval.labels.host"), props.request.host)}
              </div>
              {renderMetaRow(t("execApproval.labels.directory"), props.request.cwd, { path: true })}
              {renderMetaRow(t("execApproval.labels.resolved"), props.request.resolvedPath, {
                path: true,
              })}
              {renderMetaRow(t("execApproval.labels.security"), props.request.security)}
              {renderMetaRow(t("execApproval.labels.ask"), props.request.ask)}
            </div>
          </Show>
        </div>
      </details>
      {props.request.scope ? (
        <div class="exec-approval-scope">{summarizeApprovalScopeLabel(props.request.scope)}</div>
      ) : undefined}
    </>
  );
}

function renderPluginBody(active: ExecApprovalRequest, variant: ExecApprovalCardProps["variant"]) {
  return (
    <>
      {" "}
      {active.pluginDescription ? (
        <pre class="exec-approval-command mono">{active.pluginDescription}</pre>
      ) : undefined}
      {active.pluginDetail ? (
        <pre class="exec-approval-command mono" dir="ltr">
          {active.pluginDetail}
        </pre>
      ) : undefined}
      {variant === "modal" && active.request.sessionKey
        ? renderDetails(renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey))
        : undefined}
    </>
  );
}

function approvalDecisionLabel(decision: ExecApprovalDecision, approval: ExecApprovalRequest) {
  const proposal = approval.kind === "exec" ? approval.request.streamProposal : undefined;
  if (proposal && decision !== "allow-always") {
    return t(
      decision === "deny"
        ? "execApproval.cancelWatcher"
        : proposal.operation === "add"
          ? "execApproval.startWatcher"
          : "execApproval.saveWatcher",
    );
  }
  if (approval.kind === "plugin" && Array.isArray(approval.pluginActions)) {
    for (const action of approval.pluginActions) {
      if (isRecord(action) && action.kind === "decision" && action.decision === decision) {
        const label = normalizeOptionalString(action.label);
        if (label) {
          return label;
        }
      }
    }
  }
  return t(
    decision === "allow-once"
      ? "execApproval.allowOnce"
      : decision === "allow-always"
        ? approval.kind === "exec"
          ? "execApproval.alwaysAllowHere"
          : "execApproval.alwaysAllow"
        : "execApproval.deny",
  );
}

function decisionClass(decision: ExecApprovalDecision) {
  return decision === "allow-once" ? "btn primary" : decision === "deny" ? "btn danger" : "btn";
}

function decisionShortcut(decision: ExecApprovalDecision) {
  return decision === "allow-once"
    ? "Ctrl/Cmd+Enter"
    : decision === "allow-always"
      ? "Ctrl/Cmd+Shift+Enter"
      : "Ctrl/Cmd+D";
}

export function resolveApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  return active.kind === "exec" && active.request.ask === "always"
    ? ["allow-once", "deny"]
    : DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function approvalTitle(active: ExecApprovalRequest): string {
  if (active.kind === "exec" && active.request.streamProposal) {
    return active.request.streamProposal.name;
  }
  return active.kind !== "exec"
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
}

export function SidebarApprovalRow(props: SidebarApprovalRowProps) {
  const approval = createMemo(() => props.approval);
  const nowMs = useApprovalClock();
  const expired = () => approval().expiresAtMs <= nowMs();
  const command = createMemo(() => compactApprovalCommand(approval().request.command));
  const sessionTitle = createMemo(() => {
    const sessionKey = approval().request.sessionKey?.trim();
    return (
      props.sessionTitle ??
      (sessionKey ? resolveSessionDisplayName(sessionKey) : approvalTitle(approval()))
    );
  });
  const expiryUrgent = () => expired() || approval().expiresAtMs - nowMs() < 2 * 60_000;
  const expiryLabel = () => approvalRemainingLabel(approval().expiresAtMs, nowMs());
  const reviewOnlyMessage = () => t("execApproval.reviewOnly");
  const grantError = () => !props.canGrant && props.error === reviewOnlyMessage();
  return (
    <openclaw-sidebar-approval-row style={{ display: "contents" }}>
      <article
        class="sidebar-approval-row sidebar-issues-panel__details--warning"
        data-attention-kind="pendingApproval"
        data-approval-id={approval().id}
      >
        <span class="sidebar-issues-panel__icon sidebar-approval-row__icon" aria-hidden="true">
          <Icon name="shieldQuestion" />
        </span>
        <div class="sidebar-approval-row__content">
          <div
            ref={sidebarAttentionFocusRef("row-only")}
            class="sidebar-approval-row__header"
            data-issue-row-focus
            tabindex="-1"
          >
            <span class="sidebar-issues-panel__entity" title={sessionTitle()}>
              {sessionTitle()}
            </span>
            <openclaw-approval-countdown
              style={{ display: "contents" }}
              class={[
                "sidebar-approval-row__timer",
                { "sidebar-approval-row__timer--urgent": expiryUrgent() },
              ]}
              role="timer"
              aria-label={expiryLabel()}
              title={expiryLabel()}
            >
              {formatCountdown(approval().expiresAtMs, nowMs(), true)}
            </openclaw-approval-countdown>
          </div>
          <div class="sidebar-approval-row__command mono" title={approval().request.command}>
            <span aria-hidden="true">$ </span>
            {command()}
          </div>
          <Show when={approval().request.scope}>
            {(scope) => (
              <div class="exec-approval-scope">{summarizeApprovalScopeLabel(scope())}</div>
            )}
          </Show>
          <Show when={approval().request.warningText}>
            {(warning) => (
              <div class="sidebar-approval-row__message" role="note">
                {warning()}
              </div>
            )}
          </Show>
          <div
            class="sidebar-approval-row__actions"
            role="group"
            aria-label={t("approvalPage.actionsLabel")}
          >
            <For each={resolveApprovalDecisions(approval())}>
              {(decision) => {
                const label = createMemo(() => approvalDecisionLabel(decision, approval()));
                return (
                  <button
                    ref={sidebarAttentionFocusRef()}
                    type="button"
                    class={[
                      "btn btn--xs sidebar-approval-row__action",
                      `sidebar-approval-row__action--${decision}`,
                      { "btn--ghost": decision === "deny" },
                    ]}
                    aria-label={t("execApproval.decisionRequest", {
                      decision: label(),
                      command: command(),
                    })}
                    disabled={!props.connected || props.busy || !props.canGrant || expired()}
                    onClick={(event: Event) => props.onDecision(event, approval().id, decision)}
                  >
                    {label()}
                  </button>
                );
              }}
            </For>
            {props.openSessionHref && props.onOpenSession ? (
              <a
                ref={sidebarAttentionFocusRef()}
                class="sidebar-approval-row__open-session"
                href={props.openSessionHref}
                aria-label={t("sessionsView.openSession")}
                title={t("sessionsView.openSession")}
                onClick={(event) => props.onOpenSession?.(event)}
              >
                <Icon name="arrowUpRight" />
              </a>
            ) : undefined}
          </div>
          {props.connected && !props.canGrant ? (
            <div class="sidebar-approval-row__message" role={grantError() ? "alert" : "note"}>
              {reviewOnlyMessage()}
            </div>
          ) : undefined}
          {props.error && !grantError() ? (
            <div
              class="sidebar-approval-row__message sidebar-approval-row__message--error"
              role="alert"
            >
              {props.error}
            </div>
          ) : undefined}
        </div>
      </article>
    </openclaw-sidebar-approval-row>
  );
}

function ExecApprovalCardContent(props: ExecApprovalCardProps) {
  const active = createMemo(() => props.approval);
  const mobile = createMemo(
    () => props.presentation === "mobile" && props.variant === "inline" && active().kind === "exec",
  );
  const decisions = createMemo(() => {
    const eligible = resolveApprovalDecisions(active());
    // Right-aligned footers keep the primary decision at the trailing edge.
    const order = mobile()
      ? MOBILE_DECISION_ORDER
      : props.variant === "modal"
        ? MODAL_DECISION_ORDER
        : undefined;
    return order ? order.filter((item) => eligible.includes(item)) : eligible;
  });
  const reviewOnlyMessage = () => t("execApproval.reviewOnly");
  const grantError = () => !props.canGrant && props.error === reviewOnlyMessage();
  const rawSeverity = () => active().pluginSeverity?.trim().toLowerCase();
  const severity = () =>
    active().kind === "exec" || rawSeverity() === "warning" || rawSeverity() === "warn"
      ? "warning"
      : rawSeverity() === "danger" || rawSeverity() === "critical" || rawSeverity() === "error"
        ? "danger"
        : "info";
  const pluginId = () => (active().kind === "plugin" ? active().pluginId?.trim() : null);
  const agentId = () => (props.variant === "modal" ? active().request.agentId?.trim() : null);
  const content = () => (
    <>
      <div class="exec-approval-header">
        <div>
          <div class="exec-approval-title">
            {mobile() && !active().request.streamProposal
              ? t("execApproval.runCommand")
              : approvalTitle(active())}
          </div>
          {pluginId() || agentId() ? (
            <div class="exec-approval-chips">
              {renderChip("plugin", pluginId())} {renderChip("agent", agentId())}
            </div>
          ) : undefined}
          <ApprovalCountdown
            class="exec-approval-sub exec-approval-countdown"
            role="timer"
            expiresAtMs={active().expiresAtMs}
          />
        </div>
        {(props.queueCount ?? 0) > 1 ? (
          <div class="exec-approval-queue">
            {t("execApproval.pending", { count: String(props.queueCount) })}
          </div>
        ) : undefined}
      </div>
      <Show when={props.variant === "inline" && active().sourceSessionKey}>
        {(sessionKey) => (
          <div class="exec-approval-warning" role="note">
            {t("execApproval.requestedBySession", {
              session: resolveSessionDisplayName(sessionKey(), props.sourceSession),
            })}
          </div>
        )}
      </Show>
      {active().kind === "exec" && active().request.streamProposal ? (
        <p class="exec-approval-summary">
          {t(
            active().request.host === "sandbox"
              ? "execApproval.watcherSandboxSummary"
              : active().request.host === "gateway"
                ? "execApproval.watcherGatewaySummary"
                : "execApproval.watcherSummary",
          )}
        </p>
      ) : null}
      {active().kind === "exec" && active().request.warningText ? (
        <div class="exec-approval-warning" role="note">
          {active().request.warningText}
        </div>
      ) : null}
      <Show
        when={mobile() && active().id}
        keyed
        fallback={
          active().kind === "exec"
            ? renderExecBody(active().request, props.variant)
            : renderPluginBody(active(), props.variant)
        }
      >
        {(_requestId) => <MobileExecApprovalBody request={active().request} />}
      </Show>
      {active().kind === "exec" &&
      (!mobile() || active().request.streamProposal) &&
      !decisions().includes("allow-always") ? (
        <div class="exec-approval-warning">
          {t(
            active().request.streamProposal
              ? "execApproval.watcherApprovalScope"
              : "execApproval.allowAlwaysUnavailable",
          )}
        </div>
      ) : undefined}
      {props.connected && !props.canGrant ? (
        <div
          class={grantError() ? "exec-approval-error" : "exec-approval-warning"}
          role={grantError() ? "alert" : "note"}
        >
          {reviewOnlyMessage()}
        </div>
      ) : undefined}
      {props.error && !grantError() ? (
        <div class="exec-approval-error" role="alert">
          {props.error}
        </div>
      ) : undefined}
      {props.renderPendingQueue?.()}
    </>
  );
  const actions = () => (
    <For each={decisions()}>
      {(decision) => {
        const label = createMemo(() =>
          mobile() && decision === "allow-always"
            ? t("execApproval.alwaysAllow")
            : approvalDecisionLabel(decision, active()),
        );
        return (
          <button
            class={[
              mobile() && decision === "deny" ? "btn" : decisionClass(decision),
              { [`exec-approval-mobile-action--${decision}`]: mobile() },
            ]}
            type="button"
            aria-label={label()}
            disabled={!props.connected || props.busy || !props.canGrant}
            title={
              props.variant === "modal" && props.connected && props.canGrant
                ? `${label()} (${decisionShortcut(decision)})`
                : label()
            }
            onClick={() => void props.onDecision(active().id, decision)}
          >
            <span>{label()}</span>
          </button>
        );
      }}
    </For>
  );
  return (
    <>
      {" "}
      <div
        class={[
          "exec-approval-card",
          `exec-approval-card--${props.variant}`,
          `exec-approval-card--severity-${severity()}`,
          { "exec-approval-card--mobile": mobile() },
        ]}
        data-approval-id={active().id}
      >
        <Show when={props.variant === "modal"} fallback={content()}>
          <div class="exec-approval-modal-content">{content()}</div>
        </Show>
        <Show
          when={props.variant === "modal"}
          fallback={<div class="exec-approval-actions">{actions()}</div>}
        >
          <openclaw-modal-actions class="exec-approval-actions">{actions()}</openclaw-modal-actions>
        </Show>
      </div>
    </>
  );
}

export const ExecApprovalCard = defineSolidBridge<{ props?: ExecApprovalCardProps }>(
  "openclaw-exec-approval-card",
  (props, host) => {
    host.style.display = "contents";
    return <>{props.props && <ExecApprovalCardContent {...props.props} />}</>;
  },
  { properties: { props: { default: undefined, attribute: false } } },
);
