import { For, createEffect, createMemo, createSignal } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { collectSessionDescendantRows } from "../../../components/app-sidebar-session-parent.ts";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { sessionRowAttention } from "../../../lib/session-attention.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { isSubagentsPanelSession } from "../chat-spawned-subagent.ts";

type Props = {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
  onOpenSubagent: ((key: string) => void) | undefined;
  onOpenSession: ((key: string) => void) | undefined;
};
export type ChatChildAttention = SolidBridgeElement<Props>;
const attentionIcons = {
  hand: "hand",
  key: "key",
  alert: "alertTriangle",
  flag: "flag",
  lock: "lock",
  hourglass: "circle",
} as const;

/** Child status is a recorded outcome, even when its parent has no new reply. */
export const ChatChildAttention = defineSolidBridge<Props>(
  "openclaw-chat-child-attention",
  (props, host) => {
    host.style.display = "contents";
    const [clock, setClock] = createSignal(0);
    const rows = createMemo(() => {
      clock();
      const now = Date.now();
      return collectSessionDescendantRows(props.sessions, props.sessionKey).flatMap((row) => {
        const attention = sessionRowAttention(row, now);
        return attention.kind === "none" ? [] : [{ row, attention }];
      });
    });
    createEffect(rows, (current) => {
      const expiry = Math.min(
        ...current.flatMap(({ row, attention }) =>
          attention.kind === "agent" && row.agentStatus ? [row.agentStatus.expiresAt] : [],
        ),
      );
      if (!Number.isFinite(expiry)) {
        return undefined;
      }
      // Canonical rows own clearing; this one-shot only repaints at their next TTL.
      const timer = setTimeout(
        () => setClock((value) => value + 1),
        Math.max(0, expiry - Date.now() + 1),
      );
      return () => clearTimeout(timer);
    });
    return (
      <For each={rows()} keyed={(item) => item.row.key}>
        {(item) => {
          const open = () =>
            isSubagentsPanelSession(item().row)
              ? (props.onOpenSubagent ?? props.onOpenSession)
              : props.onOpenSession;
          const note = () => {
            const attention = item().attention;
            return attention.kind === "agent" ? attention.note : attention.reason;
          };
          const icon = () => {
            const attention = item().attention;
            return attention.kind === "agent" ? attentionIcons[attention.icon] : "alertTriangle";
          };
          return (
            <div
              class={[
                "chat-composer-neighbor-card",
                "chat-child-attention",
                {
                  "chat-composer-neighbor-card--warn": item().attention.kind === "agent",
                  "chat-composer-neighbor-card--danger": item().attention.kind !== "agent",
                },
              ]}
              data-child-session-key={item().row.key}
              role={item().attention.kind === "agent" ? "status" : "alert"}
            >
              <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
                <Icon name={icon()} />
              </span>
              <div class="chat-composer-neighbor-card__copy">
                <strong>{resolveSessionDisplayName(item().row.key, item().row)}</strong>
                <span>{formatWebUiIconErrorText(note())}</span>
              </div>
              {open() && (
                <button class="btn btn--sm" type="button" onClick={() => open()?.(item().row.key)}>
                  {t("sessionsView.openSession")}
                </button>
              )}
            </div>
          );
        }}
      </For>
    );
  },
  {
    properties: {
      sessions: { default: [], attribute: false },
      sessionKey: { default: "" },
      onOpenSubagent: { default: undefined, attribute: false },
      onOpenSession: { default: undefined, attribute: false },
    },
  },
);
