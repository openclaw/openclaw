import { createMemo, createSignal, For, Show } from "solid-js";
import { normalizeCloudRepo } from "../../../../src/config/cloud-worker-project-profiles.js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { readCloudWorkerProfiles } from "./cloud-worker-config.ts";
import { buildCloudWorkerRepositoryProfilePatch } from "./cloud-worker-repositories-config.ts";
import { useCloudWorkerConfig } from "./use-cloud-worker-config.ts";
type RepositoryMachineProps = {
  repository: string;
  profileId?: string;
  defaultProfileId?: string;
  machineFacts: string;
};

export function CloudWorkerRepositoryMachine(props: RepositoryMachineProps) {
  // Editing and save feedback belong to one repository, including an unavailable identity.
  return <For each={[props.repository]}>{() => <RepositoryMachine {...props} />}</For>;
}

function RepositoryMachine(props: RepositoryMachineProps) {
  const [editing, setEditing] = createSignal(false, { ownedWrite: true });
  const editor = useCloudWorkerConfig(() => setEditing(false));
  const profiles = createMemo(() => readCloudWorkerProfiles(editor.config()));
  const configuredProfile = createMemo(() =>
    profiles().find((profile) => profile.id === props.profileId),
  );
  const facts = () =>
    props.machineFacts ||
    [configuredProfile()?.backend, configuredProfile()?.machineClass, configuredProfile()?.target]
      .filter(Boolean)
      .join(" · ");
  const repository = () =>
    normalizeCloudRepo(`https://${props.repository}`) === props.repository
      ? props.repository
      : null;
  const editable = () => Boolean(repository() && editor.editable());
  async function change(profileId: string) {
    const target = repository();
    if (!target) {
      return;
    }
    await editor.save({
      build: (base) => buildCloudWorkerRepositoryProfilePatch(base, target, profileId),
      note: `cloud environments: change machine for ${target}`,
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
      success: () => {
        setEditing(false);
        return t("cloudWorkersPage.settingsSaved");
      },
    });
  }
  return (
    <SettingsSection title={t("cloudWorkersPage.environments.machine")}>
      <div class="cloud-environments__machine">
        <span title={props.profileId}>{facts() || props.profileId || "—"}</span>
        <Show
          when={editing()}
          fallback={
            <span
              title={
                !repository() ? t("cloudWorkersPage.environments.identityUnavailable") : undefined
              }
            >
              <button
                type="button"
                class="btn btn--sm"
                disabled={!editable()}
                onClick={() => setEditing(true)}
              >
                {t("cloudWorkersPage.environments.change")}
              </button>
            </span>
          }
        >
          <select
            class="settings-select"
            aria-label={t("cloudWorkersPage.repositoryProfile")}
            value={props.defaultProfileId ?? ""}
            disabled={!editable()}
            onChange={(event) => void change(event.currentTarget.value)}
          >
            <option value="" disabled>
              {t("cloudWorkersPage.selectProfile")}
            </option>
            <For each={profiles()}>
              {(profile) => (
                <option value={profile.id} selected={props.defaultProfileId === profile.id}>
                  {profile.id}
                </option>
              )}
            </For>
          </select>
          <button
            type="button"
            class="btn btn--sm"
            disabled={editor.state().busy}
            onClick={() => setEditing(false)}
          >
            {t("common.cancel")}
          </button>
        </Show>
      </div>
      <Show when={editor.state().error}>
        <div class="callout warning" role="alert">
          {editor.state().error}
        </div>
      </Show>
    </SettingsSection>
  );
}
