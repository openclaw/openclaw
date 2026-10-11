import { For } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import type { SnapshotProfile } from "./cloud-worker-snapshot-rows.tsx";

export function SnapshotBuildDialog(props: {
  profiles: SnapshotProfile[];
  profile: string;
  project: string;
  repositories: { root: string; label: string }[];
  repositoriesLoading: boolean;
  preparing: boolean;
  error: string | null;
  canPrepare: boolean;
  onProfile: (value: string) => void;
  onProject: (value: string) => void;
  onBuild: () => void;
  onClose: () => void;
}) {
  const valid = () =>
    props.profiles.some((profile) => profile.id === props.profile && profile.warmImages === "on") &&
    props.repositories.some((repository) => repository.root === props.project);
  return (
    <openclaw-modal-dialog
      label={t("cloudWorkersPage.snapshots.buildSnapshot")}
      onModal-cancel={(event) => {
        if (props.preparing) {
          event.preventDefault();
        } else {
          props.onClose();
        }
      }}
    >
      <div class="exec-approval-card">
        <h2>{t("cloudWorkersPage.snapshots.buildSnapshot")}</h2>
        <p>{t("cloudWorkersPage.snapshots.buildHelp")}</p>
        <label class="field">
          <span>{t("cloudWorkersPage.snapshots.profile")}</span>
          <select
            class="settings-select"
            value={props.profile}
            disabled={props.preparing}
            onChange={(event) => props.onProfile(event.currentTarget.value)}
          >
            <option value="">{t("cloudWorkersPage.snapshots.chooseProfile")}</option>
            <For each={props.profiles}>
              {(profile) => (
                <option
                  value={profile.id}
                  selected={profile.id === props.profile}
                  disabled={profile.warmImages !== "on"}
                >
                  {profile.id}
                  {profile.warmImages === "on" ? "" : ` — ${profile.reason}`}
                </option>
              )}
            </For>
          </select>
        </label>
        <label class="field">
          <span>{t("cloudWorkersPage.snapshots.repository")}</span>
          <select
            class="settings-select"
            value={props.project}
            disabled={props.preparing || props.repositoriesLoading}
            onChange={(event) => props.onProject(event.currentTarget.value)}
          >
            <option value="">
              {t(
                props.repositoriesLoading
                  ? "common.loading"
                  : "cloudWorkersPage.snapshots.chooseRepository",
              )}
            </option>
            <For each={props.repositories}>
              {(repository) => (
                <option value={repository.root} selected={repository.root === props.project}>
                  {repository.label === repository.root
                    ? repository.root
                    : `${repository.label} · ${repository.root}`}
                </option>
              )}
            </For>
          </select>
        </label>
        {!props.repositoriesLoading && !props.repositories.length && !props.error ? (
          <p>{t("cloudWorkersPage.snapshots.noRepositories")}</p>
        ) : null}
        {props.error ? (
          <div class="callout warning" role="alert">
            {props.error}
          </div>
        ) : null}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            type="button"
            disabled={!valid() || props.preparing || !props.canPrepare}
            onClick={() => props.onBuild()}
          >
            {t("cloudWorkersPage.snapshots.buildSnapshot")}
          </button>
          <button
            class="btn"
            type="button"
            disabled={props.preparing}
            onClick={() => props.onClose()}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}
