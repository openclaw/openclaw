import { createMemo } from "solid-js";
import type { GatewaySessionRow, SessionRunStatus } from "../../api/types.ts";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
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

export function SessionStatusBadge(props: { row: GatewaySessionRow }) {
  const active = createMemo(() => isSessionRunActive(props.row));
  const idle = createMemo(
    () => props.row.hasActiveRun === false && (!props.row.status || props.row.status === "running"),
  );
  const label = createMemo(() =>
    t(
      props.row.status === "queued"
        ? "sessionsView.statusQueued"
        : active()
          ? "sessionsView.statusLive"
          : idle()
            ? "sessionsView.statusIdle"
            : (props.row.status && SESSION_RUN_STATUS_LABELS[props.row.status]) ||
              "sessionsView.statusUnknown",
    ),
  );
  const kind = createMemo(() =>
    props.row.status === "queued"
      ? "warn"
      : active() || props.row.status === "done"
        ? "ok"
        : idle() || !props.row.status || props.row.status === "interrupted"
          ? "muted"
          : "danger",
  );
  return (
    <openclaw-tooltip prop:content={`${t("sessionsView.status")}: ${label()}`}>
      <SettingsStatus kind={kind()} label={label()} />
    </openclaw-tooltip>
  );
}
