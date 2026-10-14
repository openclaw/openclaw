import { createMemo, Show } from "solid-js";
import type { UpdateAvailable, UpdateScheduleState } from "../../api/types.ts";
import { getUpdateGitRevisions } from "../../app/update-schedule-projection.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../styles/update-git-revisions.css";

export function UpdateGitRevisions(props: {
  schedule: UpdateScheduleState | null | undefined;
  updateAvailable: UpdateAvailable | null | undefined;
}) {
  const revisions = createMemo(() => getUpdateGitRevisions(props.schedule, props.updateAvailable));
  return (
    <Show when={revisions()}>
      {(value) => (
        <div class="update-git-revisions">
          <span class="update-git-revisions__range" dir="ltr">
            <Show when={value().currentSha}>
              {(sha) => (
                <>
                  <code title={sha()}>{sha().slice(0, 8)}</code>
                  <span aria-hidden="true">→</span>
                </>
              )}
            </Show>
            <code title={value().targetSha}>{value().targetSha.slice(0, 8)}</code>
          </span>
          <Show when={value().compareUrl}>
            {(url) => (
              <a href={url()} target="_blank" rel="noopener noreferrer">
                {t("updates.target.viewChanges")} <span aria-hidden="true">↗</span>
              </a>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
