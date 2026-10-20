import { For, Show, createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerProcessesEnglish } from "../../../i18n/locales/en-processes.ts";
import { registerSessionOrganizationEnglish } from "../../../i18n/locales/en-session-organization.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";

registerEnglishCatalog(registerProcessesEnglish);
registerEnglishCatalog(registerSessionOrganizationEnglish);

export type ChatDetailsMobileProcessesProps = {
  /** The session host retains the native ProcessesPanelData projection and its demand. */
  data: Pick<ProcessesPanelData["snapshot"], "rows" | "error" | "loading"> &
    Pick<ProcessesPanelData, "refresh">;
  presented: boolean;
  onOpen?: () => void;
};

const order = { running: 0, failed: 1, killed: 2, completed: 3 } as const;
function ProcessRow(props: {
  row: SessionProcessSummary;
  presented: boolean;
  onOpen?: () => void;
}) {
  const status = () => t(`chat.processesPanel.status.${props.row.status}`);
  const lastLine = () => props.row.tail.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const description = () => [props.row.name, status(), lastLine()].filter(Boolean).join(". ");
  const content = () => (
    <>
      <span class="chat-details__process-icon" data-status={props.row.status} aria-hidden="true">
        <Icon name="terminal" />
      </span>
      <span class="chat-details__process-name">{props.row.name}</span>
      <span class="chat-details__process-elapsed" aria-hidden="true">
        <ElapsedTime startMs={props.row.startedAt} endMs={props.row.endedAt ?? null} />
      </span>
      <span class="chat-details__process-tail">{lastLine() || status()}</span>
    </>
  );
  return (
    <div role="listitem" data-process-id={props.row.processId}>
      <Show when={props.onOpen} fallback={<div class="chat-details__process">{content()}</div>}>
        <button
          type="button"
          class="chat-details__process"

          aria-label={description()}
          disabled={!props.presented}
          onClick={() => props.onOpen?.()}
        >
          {content()}
        </button>
      </Show>
    </div>
  );
}

/** Two native process rows; the existing host opens the complete collection. */
export function ChatDetailsMobileProcesses(props: ChatDetailsMobileProcessesProps) {
  const rows = createMemo(() =>
    props.data.rows.toSorted((a, b) => order[a.status] - order[b.status]),
  );
  return (
    <div class="chat-details-mobile-processes">
      <Show when={rows().length === 0 && props.data.error}>
        <div class="chat-details-mobile-processes__error" role="status">
          <span>{t("chat.sessionDetails.processesError")}</span>
          <button
            type="button"
            class="chip"
            disabled={!props.presented || props.data.loading}
            onClick={() => void props.data.refresh()}
          >
            {t("common.retry")}
          </button>
        </div>
      </Show>
      <div role="list" aria-label={t("chat.sessionDetails.processes")}>
        <For each={rows().slice(0, 2)} keyed={(row) => row.instanceId}>
          {(row) => <ProcessRow row={row()} presented={props.presented} onOpen={props.onOpen} />}
        </For>
      </div>
      <Show when={props.onOpen}>
        <button
          type="button"
          class="chat-details-mobile-root__entry chat-details-mobile-processes__show-all"
          disabled={!props.presented}
          onClick={() => props.onOpen?.()}
        >
          <span class="chat-details-mobile-root__copy">{t("sessionsView.showAll")}</span>
        </button>
      </Show>
    </div>
  );
}
