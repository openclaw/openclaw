import { Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";

export function AgentFileError(params: {
  error: string | null;
  conflictName: string | null;
  busy: boolean;
  canWrite: boolean;
  onReload: (name: string) => void;
  onOverwrite: (name: string) => void;
}) {
  return (
    <Show
      when={params.conflictName}
      fallback={
        <Show when={params.error}>
          <div class="callout danger">{params.error}</div>
        </Show>
      }
    >
      {(name) => (
        <div class="callout danger">
          <span>{params.error ?? t("agents.files.conflictHint")}</span>
          <div class="agent-file-actions">
            <button
              class="btn btn--sm"
              type="button"
              disabled={params.busy}
              onClick={() => params.onReload(name())}
            >
              {t("common.reload")}
            </button>
            <button
              class="btn btn--sm"
              type="button"
              disabled={params.busy || !params.canWrite}
              onClick={() => params.onOverwrite(name())}
            >
              {t("agents.files.overwrite")}
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
