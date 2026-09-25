import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SnapshotProfile } from "./cloud-worker-snapshot-rows.ts";

function selectionHandler(apply: (value: string) => void) {
  return (event: Event) => {
    if (event.currentTarget instanceof HTMLSelectElement) {
      apply(event.currentTarget.value);
    }
  };
}

/** Profile and repository picker for a build; the page owns preparation and its state. */
export function renderSnapshotBuildDialog(options: {
  profiles: SnapshotProfile[];
  repositories: readonly { root: string; label: string }[];
  repositoriesLoading: boolean;
  profileId: string;
  projectPath: string;
  preparing: boolean;
  canPrepare: boolean;
  error: string | null;
  onProfileChange: (value: string) => void;
  onProjectChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const valid =
    options.profiles.some(
      (profile) => profile.id === options.profileId && profile.warmImages === "on",
    ) && options.repositories.some((repository) => repository.root === options.projectPath);
  return html`<openclaw-modal-dialog
    label=${t("cloudWorkersPage.snapshots.buildSnapshot")}
    @modal-cancel=${(event: Event) => {
      if (options.preparing) {
        event.preventDefault();
      } else {
        options.onClose();
      }
    }}
  >
    <div class="exec-approval-card">
      <h2>${t("cloudWorkersPage.snapshots.buildSnapshot")}</h2>
      <p>${t("cloudWorkersPage.snapshots.buildHelp")}</p>
      <label class="field"
        ><span>${t("cloudWorkersPage.snapshots.profile")}</span>
        <select
          class="settings-select"
          .value=${options.profileId}
          ?disabled=${options.preparing}
          @change=${selectionHandler(options.onProfileChange)}
        >
          <option value="">${t("cloudWorkersPage.snapshots.chooseProfile")}</option>
          ${options.profiles.map((profile) => html`<option value=${profile.id} ?disabled=${profile.warmImages !== "on"}>${profile.id}${profile.warmImages === "on" ? "" : ` — ${profile.reason}`}</option>`)}
        </select>
      </label>
      <label class="field"
        ><span>${t("cloudWorkersPage.snapshots.repository")}</span>
        <select
          class="settings-select"
          .value=${options.projectPath}
          ?disabled=${options.preparing || options.repositoriesLoading}
          @change=${selectionHandler(options.onProjectChange)}
        >
          <option value="">
            ${t(options.repositoriesLoading ? "common.loading" : "cloudWorkersPage.snapshots.chooseRepository")}
          </option>
          ${options.repositories.map((repository) => html`<option value=${repository.root}>${repository.label === repository.root ? repository.root : `${repository.label} · ${repository.root}`}</option>`)}
        </select>
      </label>
      ${!options.repositoriesLoading && !options.repositories.length && !options.error ? html`<p>${t("cloudWorkersPage.snapshots.noRepositories")}</p>` : nothing}
      ${options.error ? html`<div class="callout warning" role="alert">${options.error}</div>` : nothing}
      <div class="exec-approval-actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${!valid || options.preparing || !options.canPrepare}
          @click=${options.onSubmit}
        >
          ${t("cloudWorkersPage.snapshots.buildSnapshot")}
        </button>
        <button class="btn" type="button" ?disabled=${options.preparing} @click=${options.onClose}>
          ${t("common.cancel")}
        </button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}
