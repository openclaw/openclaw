import { Show, createEffect, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { createSessionDetailReveal } from "./session-detail-reveal.ts";
import type { UsageProps, UsageSessionEntry } from "./types.ts";
import { SessionDetailPanel } from "./view-details.tsx";
import { SessionsCard } from "./view-sessions-card.tsx";

/** The session list, with the selected session's details stacked under it. */
export function UsageSessionsGrid(props: {
  usage: UsageProps;
  sessions: UsageSessionEntry[];
  selectedRows: UsageSessionEntry[];
  totalSessions: number;
  overview?: UsageProps["data"]["sessionPage"];
  loading: boolean;
  selected: UsageSessionEntry | null | undefined;
}) {
  const reveal = createSessionDetailReveal();
  createEffect(() => props.selected?.key, reveal.settle);
  onSettled(() => reveal.dispose);
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
          onRowSelected={reveal.rowSelected}
        />
      </div>
      <Show when={props.selected}>
        {(selectedSession) => (
          // Details stack under the session list so the page stays one column.
          <aside
            ref={reveal.bindDetail}
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
                reveal.closing();
                props.usage.callbacks.filters.onClearSessions();
              }}
            />
          </aside>
        )}
      </Show>
    </div>
  );
}
