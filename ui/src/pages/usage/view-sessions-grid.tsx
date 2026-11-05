import { Show, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import type { createSessionDetailReveal } from "./session-detail-reveal.ts";
import type { UsageProps, UsageSessionEntry } from "./types.ts";
import { SessionDetailPanel } from "./view-details.tsx";
import { SessionsCard } from "./view-sessions-card.tsx";

/** The session list, with the selected session's details stacked under it. */
export function UsageSessionsGrid(props: {
  usage: UsageProps;
  reveal: ReturnType<typeof createSessionDetailReveal>;
  sessions: UsageSessionEntry[];
  selectedRows: UsageSessionEntry[];
  totalSessions: number;
  overview?: UsageProps["data"]["sessionPage"];
  loading: boolean;
  selected: UsageSessionEntry | null | undefined;
}) {
  return (
    <div class="usage-grid">
      <div class="usage-grid-column">
        <SessionsCard
          sessions={props.sessions}
          selectedRows={props.selectedRows}
          usage={props.usage}
          totalSessions={props.totalSessions}
          overview={props.overview}
          loading={props.loading}
          onRowSelected={props.reveal.rowSelected}
          onRowMounted={props.reveal.rowMounted}
        />
      </div>
      <Show when={props.selected}>
        {(selectedSession) => (
          // Details stack under the session list so the page stays one column.
          <aside
            ref={props.reveal.bindDetail}
            class="usage-grid-column usage-session-detail-column"
            aria-label={t("usage.sessions.details")}
          >
            <SessionDetailPanel
              session={selectedSession()}
              detail={props.usage.detail}
              callbacks={props.usage.callbacks.details}
              range={props.usage.filters}
              contextExpanded={props.usage.display.contextExpanded}
              onClose={() => {
                props.reveal.closing();
                props.usage.callbacks.filters.onClearSessions();
              }}
            />
          </aside>
        )}
      </Show>
      <Show when={props.selected?.key} keyed>
        {(key) => {
          // After the panel above renders this selection, and again once it's gone.
          onSettled(() => {
            props.reveal.settle(key);
            return () => props.reveal.settle(undefined);
          });
          return null;
        }}
      </Show>
    </div>
  );
}
