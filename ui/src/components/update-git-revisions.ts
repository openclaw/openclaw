import { html, nothing } from "lit";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getUpdateGitRevisions } from "../app/update-schedule-projection.ts";
import { t } from "../i18n/index.ts";
import "../styles/update-git-revisions.css";

export function renderUpdateGitRevisions(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
) {
  const revisions = getUpdateGitRevisions(schedule, updateAvailable);
  if (!revisions) {
    return nothing;
  }
  return html`<div class="update-git-revisions">
    <span class="update-git-revisions__range" dir="ltr">
      ${
        revisions.currentSha
          ? html`<code title=${revisions.currentSha}>${revisions.currentSha.slice(0, 8)}</code>
              <span aria-hidden="true">→</span>`
          : nothing
      }
      <code title=${revisions.targetSha}>${revisions.targetSha.slice(0, 8)}</code>
    </span>
    ${
      revisions.compareUrl
        ? html`<a href=${revisions.compareUrl} target="_blank" rel="noopener noreferrer"
            >${t("updates.target.viewChanges")} <span aria-hidden="true">↗</span></a
          >`
        : nothing
    }
  </div>`;
}
