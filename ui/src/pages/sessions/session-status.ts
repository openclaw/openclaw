import { html } from "lit";
import type { GatewaySessionRow, SessionRunStatus } from "../../api/types.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";

const SESSION_RUN_STATUS_LABELS = {
  queued: "sessionsView.statusQueued",
  running: "sessionsView.statusRunning",
  done: "sessionsView.statusDone",
  failed: "sessionsView.statusFailed",
  interrupted: "sessionsView.statusInterrupted",
  killed: "sessionsView.statusKilled",
  timeout: "sessionsView.statusTimeout",
} as const satisfies Record<SessionRunStatus, string>;

export function renderSessionStatusBadge(row: GatewaySessionRow) {
  const active = isSessionRunActive(row);
  const idle = row.hasActiveRun === false && (!row.status || row.status === "running");
  const label = t(
    row.status === "queued"
      ? "sessionsView.statusQueued"
      : active
        ? "sessionsView.statusLive"
        : idle
          ? "sessionsView.statusIdle"
          : (row.status && SESSION_RUN_STATUS_LABELS[row.status]) || "sessionsView.statusUnknown",
  );
  const kind =
    row.status === "queued"
      ? "warn"
      : active || row.status === "done"
        ? "ok"
        : idle || !row.status || row.status === "interrupted"
          ? "muted"
          : "danger";
  const title = `${t("sessionsView.status")}: ${label}`;
  return html`
    <openclaw-tooltip .content=${title}>
      ${renderSettingsStatus({ kind, label })}
    </openclaw-tooltip>
  `;
}
