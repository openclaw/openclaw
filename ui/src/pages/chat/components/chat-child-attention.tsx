import { For, createMemo, createSignal } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { collectSessionDescendantRows } from "../../../components/app-sidebar-session-parent.ts";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { createInterval } from "../../../lib/reactive/timers.ts";
import { sessionRowAttention } from "../../../lib/session-attention.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSubagentsPanelSession } from "../chat-spawned-subagent.ts";

type Props = {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
  onOpenSubagent: ((key: string) => void) | undefined;
  onOpenSession: ((key: string) => void) | undefined;
};
const attentionIcons = {
  hand: "hand",
  key: "key",
  alert: "alertTriangle",
  flag: "flag",
  lock: "lock",
  hourglass: "circle",
} as const;

/** Child status is a recorded outcome, even when its parent has no new reply. */
export function ChatChildAttention(props: Props) {
  const [clock, setClock] = createSignal(0);
  const rows = createMemo(() => {
    clock();
    const now = Date.now();
    return collectSessionDescendantRows(props.sessions, props.sessionKey).flatMap((row) => {
      const attention = sessionRowAttention(row, now);
      return attention.kind === "none" ? [] : [{ row, attention }];
    });
  });
  createInterval(
    () => setClock((value) => value + 1),
    () => {
      const expiry = Math.min(
        ...rows().flatMap(({ row, attention }) =>
          attention.kind === "agent" && row.agentStatus ? [row.agentStatus.expiresAt] : [],
        ),
      );
      return Number.isFinite(expiry) ? Math.max(0, expiry - Date.now() + 1) : undefined;
    },
  );
  return (
    <openclaw-chat-child-attention style={{ display: "contents" }}>
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
    </openclaw-chat-child-attention>
  );
}
