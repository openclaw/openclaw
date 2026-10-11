import { For, Show, createMemo } from "solid-js";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { SidebarApprovalRow } from "./exec-approval-card-solid.tsx";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import { SidebarDismissButton, SidebarNotificationCard } from "./sidebar-notification-card.tsx";
import { SidebarUpdateCard } from "./sidebar-update-card.tsx";
import { Icon } from "./solid/icon.tsx";
import { askBrandLabel } from "./theme-brand-label.ts";
import "./viewer-facepile.ts";

registerEnglishCatalog(registerSidebarAttentionEnglish);

type SidebarIssueItemHandlers = {
  basePath: string;
  onDismiss?: () => void;
  onNavigate: (routeId: NavigationRouteId) => void;
  onOpen: (item: SidebarAttentionItem) => void;
};

export function renderSidebarMentionItem(params: {
  mention: MentionInboxItem;
  context: Pick<ApplicationContext, "basePath">;
  dismissing: boolean;
  onDismiss: () => void;
  onNavigate: ApplicationContext["navigate"];
}) {
  const mention = createMemo(() => params.mention);
  const sender = createMemo<PresenceViewer>(() => ({
    id: mention().senderProfileId,
    identity: { type: "profile", id: mention().senderProfileId },
    name: mention().senderLabel,
    avatarUrl: mention().senderAvatarUrl,
    watchedSessions: [],
  }));
  const label = createMemo(() => t("attention.mentions.from", { sender: mention().senderLabel }));
  const target = createMemo(() =>
    sessionNavigationTarget({
      face: "chat",
      sessionKey: mention().sessionKey,
      fallbackAgentId: mention().agentId,
      basePath: params.context.basePath,
      row: { key: mention().sessionKey, displayName: mention().sessionTitle },
      exactKey: true,
    }),
  );
  return (
    <Show when={mention().id} keyed>
      {(id) => (
        <article
          class="sidebar-mention-row"
          data-attention-kind="mention"
          data-mention-id={id}
          aria-label={label()}
        >
          <SidebarNotificationCard
            title={mention().sessionTitle}
            detail={label()}
            timestampMs={mention().createdAt}
            icon={
              <openclaw-viewer-avatar
                prop:user={sender()}
                prop:markAsViewer={false}
                variant="footer"
              />
            }
            onDismiss={params.onDismiss}
            dismissing={params.dismissing}
            body={
              <>
                {mention().excerpt ? (
                  <p class="sidebar-mention-row__excerpt">{mention().excerpt}</p>
                ) : null}
                <div class="sidebar-issues-panel__actions sidebar-mention-row__actions">
                  <a
                    class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                    href={target().href}
                    onClick={(event) => {
                      if (!shouldHandleNavigationClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      params.onNavigate("chat", target().options);
                    }}
                  >
                    {t("attention.mentions.open")}
                  </a>
                </div>
              </>
            }
          />
        </article>
      )}
    </Show>
  );
}

export function renderSidebarApprovalItem(params: {
  approval: ExecApprovalRequest;
  context: ApplicationContext;
  onNavigate: ApplicationContext["navigate"];
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
}) {
  const snapshot = () => params.context.overlays.snapshot;
  const sessionKey = createMemo(() => params.approval.request.sessionKey?.trim());
  const session = () => {
    const key = sessionKey();
    return key
      ? params.context.sessions.state.result?.sessions.find((candidate) =>
          areUiSessionKeysEquivalent(candidate.key, key),
        )
      : undefined;
  };
  const sessionTarget = createMemo(() => {
    const key = sessionKey();
    return key
      ? sessionNavigationTarget({ context: params.context, face: "chat", sessionKey: key })
      : null;
  });
  return (
    <SidebarApprovalRow
      props={{
        get approval() {
          return params.approval;
        },
        get busy() {
          return snapshot().approvalBusy;
        },
        get canGrant() {
          return snapshot().approvalCanGrant;
        },
        get error() {
          return snapshot().approvalErrors.get(params.approval.id) ?? null;
        },
        get openSessionHref() {
          return sessionTarget()?.href;
        },
        get sessionTitle() {
          return session()?.displayName?.trim() || session()?.label?.trim();
        },
        onDecision: (event, approvalId, decision) => params.onDecision(event, approvalId, decision),
        onOpenSession: (event) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          const target = sessionTarget();
          if (target) {
            params.onNavigate("chat", target.options);
          }
        },
      }}
    />
  );
}

export function renderSidebarUpdateSurface(params: {
  context: Pick<ApplicationContext, "gateway" | "overlays">;
  onDismiss?: () => void;
  onNavigate: () => void;
  watchUpdateProgress: ((listener: (progress: UpdateProgress) => void) => () => void) | undefined;
}) {
  const snapshot = () => params.context.overlays.snapshot;
  const gateway = () => params.context.gateway.snapshot;
  return (
    <SidebarUpdateCard
      class="sidebar-issues-panel__update"
      data-attention-kind="updateAvailable"
      compact={true}
      updateAvailable={snapshot().updateAvailable}
      updateSchedule={snapshot().updateSchedule}
      heldUpdateCampaignId={snapshot().heldUpdateCampaignId}
      updateBusy={snapshot().updateRunning || snapshot().updateReconciliationPending}
      updateRun={snapshot().updateRun}
      updateRunAcknowledged={snapshot().updateRunAcknowledged}
      connected={gateway().phase === "connected"}
      onAcknowledge={() => params.context.overlays.acknowledgeUpdateRun()}
      onCheckStatus={() => params.context.overlays.refreshUpdateStatus()}
      statusBanner={snapshot().updateStatusBanner}
      watchUpdateProgress={params.watchUpdateProgress}
      canUpdate={canCallGatewayMethod(gateway(), "update.run", "operator.admin")}
      canHoldUpdate={canCallGatewayMethod(gateway(), "update.hold", "operator.admin")}
      onUpdate={() => void params.context.overlays.runUpdate()}
      refreshRequired={false}
      onHoldUpdate={() => params.context.overlays.holdUpdate()}
      onReviewUpdate={params.onNavigate}
      onDismiss={params.onDismiss}
    />
  );
}

function scopeUpgradeText(state: Exclude<ScopeUpgradeState, { phase: "hidden" }>): string {
  switch (state.phase) {
    case "guidance":
      return t("connection.scopeUpgrade.guidance");
    case "available":
      return t("connection.scopeUpgrade.limited");
    case "requesting":
      return t("connection.scopeUpgrade.requesting");
    case "pending":
      return t("connection.scopeUpgrade.pending", {
        command: `openclaw devices approve ${state.requestId}`,
      });
    case "rejected":
      return t(
        state.expired ? "connection.scopeUpgrade.expired" : "connection.scopeUpgrade.rejected",
      );
    case "error":
      return t("connection.scopeUpgrade.error", { error: state.message });
  }
  return state satisfies never;
}

export function renderSidebarScopeUpgradeItem(params: {
  state: Exclude<ScopeUpgradeState, { phase: "hidden" }>;
  onCancel: () => void;
  onDismiss?: () => void;
  onRequest: () => void;
  onRetry: () => void;
}) {
  const text = () => scopeUpgradeText(params.state);
  const summary = () => t("connection.scopeUpgrade.inboxState");
  const retryable = () =>
    params.state.phase === "error"
      ? params.state.retryable
      : params.state.phase === "pending" || params.state.phase === "rejected";
  return (
    <details
      class={[
        "sidebar-issues-panel__details",
        `sidebar-issues-panel__details--${params.state.phase === "error" || params.state.phase === "rejected" ? "error" : "warning"}`,
      ]}
      data-attention-kind="scopeUpgrade"
    >
      <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
        <span class="sidebar-issues-panel__icon" aria-hidden="true">
          <Icon name="shieldQuestion" />
        </span>
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity">{t("connection.scopeUpgrade.status")}</span>
          <span class="sidebar-issues-panel__state" title={summary()}>
            {summary()}
          </span>
        </span>
        <SidebarDismissButton
          itemLabel={t("connection.scopeUpgrade.status")}
          onDismiss={params.onDismiss}
        />
        <span class="sidebar-issues-panel__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class="sidebar-issues-panel__body" role="status" aria-live="polite">
        <div>{text()}</div>
        {params.state.phase === "available" || params.state.phase === "requesting" ? (
          <div class="sidebar-issues-panel__actions">
            <button
              type="button"
              class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
              disabled={params.state.phase === "requesting"}
              onClick={() => {
                if (params.state.phase === "available") {
                  params.onRequest();
                }
              }}
            >
              {t(
                params.state.phase === "available"
                  ? "connection.scopeUpgrade.request"
                  : "connection.scopeUpgrade.requestingAction",
              )}
            </button>
          </div>
        ) : retryable() || params.state.phase === "error" ? (
          <div class="sidebar-issues-panel__actions">
            {retryable() ? (
              <button
                type="button"
                class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                onClick={() => params.onRetry()}
              >
                {t("connection.scopeUpgrade.retry")}
              </button>
            ) : null}
            <button
              type="button"
              class="sidebar-issues-panel__action"
              onClick={() => params.onCancel()}
            >
              {t("connection.scopeUpgrade.cancel")}
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SidebarItemMeta(props: { item: SidebarAttentionItem }) {
  return (
    <Show
      when={props.item.meta}
      fallback={
        <span class="sidebar-issues-panel__state" title={props.item.detail}>
          {props.item.detail}
        </span>
      }
    >
      {(meta) => (
        <span class="sidebar-issues-panel__state-row" title={props.item.detail}>
          {meta().context ? (
            <>
              <span class="sidebar-issues-panel__meta-context">{meta().context}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span class="sidebar-issues-panel__meta-status">{meta().status}</span>
          <span aria-hidden="true">·</span>
          <span class="sidebar-issues-panel__meta-time">{meta().time}</span>
        </span>
      )}
    </Show>
  );
}

function SidebarIssueContent(props: { item: SidebarAttentionItem }) {
  return (
    <>
      <span
        class={[
          "sidebar-issues-panel__icon",
          {
            "sidebar-issues-panel__icon--critical":
              props.item.action.kind !== "navigate" && props.item.kind === "modelAuthExpired",
          },
        ]}
        aria-hidden="true"
      >
        <Icon name={props.item.icon} />
      </span>
      <span class="sidebar-issues-panel__content">
        <span class="sidebar-issues-panel__entity" title={props.item.label}>
          {props.item.label}
        </span>
        <SidebarItemMeta item={props.item} />
      </span>
    </>
  );
}

export function SidebarIssueItem(props: {
  item: SidebarAttentionItem;
  handlers: SidebarIssueItemHandlers;
}) {
  const navigation = createMemo(() => {
    const action = props.item.action;
    return action.kind === "navigate" ? action : null;
  });
  const visibleFacts = createMemo(() => {
    const action = props.item.action;
    return action.kind === "askCustodian"
      ? action.alert.facts.filter((fact) => fact !== props.item.label)
      : [];
  });
  return (
    <Show
      when={navigation()}
      fallback={
        <details
          class={`sidebar-issues-panel__details sidebar-issues-panel__details--${props.item.severity}`}
          data-attention-kind={props.item.kind}
        >
          <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
            <SidebarIssueContent item={props.item} />
            <SidebarDismissButton
              itemLabel={props.item.label}
              onDismiss={props.handlers.onDismiss}
            />
            <span class="sidebar-issues-panel__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </summary>
          <div class="sidebar-issues-panel__body">
            {visibleFacts().length ? (
              <ul class="sidebar-issues-panel__facts">
                <For each={visibleFacts()}>{(fact) => <li>{fact}</li>}</For>
              </ul>
            ) : null}
            <div class="sidebar-issues-panel__actions">
              <Show when={props.item.inlineAction}>
                {(action) => (
                  <button
                    type="button"
                    class="sidebar-issues-panel__action sidebar-issues-panel__action--primary"
                    onClick={() => props.handlers.onNavigate(action().routeId)}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
              <button
                type="button"
                class={[
                  "sidebar-issues-panel__action",
                  { "sidebar-issues-panel__action--primary": !props.item.inlineAction },
                ]}
                onClick={() => props.handlers.onOpen(props.item)}
              >
                {askBrandLabel()}
              </button>
            </div>
          </div>
        </details>
      }
    >
      {(action) => (
        <div
          class={`sidebar-issues-panel__details sidebar-issues-panel__details--${props.item.severity}`}
          data-attention-kind={props.item.kind}
        >
          <div class="sidebar-issues-panel__summary sidebar-issues-panel__summary--navigation">
            <a
              class="sidebar-issues-panel__navigation-link"
              href={pathForRoute(action().routeId, props.handlers.basePath)}
              data-issue-row-focus
              onClick={(event) => {
                if (!shouldHandleNavigationClick(event)) {
                  return;
                }
                event.preventDefault();
                props.handlers.onNavigate(action().routeId);
              }}
            >
              <SidebarIssueContent item={props.item} />
            </a>
            <SidebarDismissButton
              itemLabel={props.item.label}
              onDismiss={props.handlers.onDismiss}
            />
            <span class="sidebar-issues-panel__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </div>
        </div>
      )}
    </Show>
  );
}

export function renderSidebarIssueItem(
  item: SidebarAttentionItem,
  handlers: SidebarIssueItemHandlers,
) {
  return <SidebarIssueItem item={item} handlers={handlers} />;
}
