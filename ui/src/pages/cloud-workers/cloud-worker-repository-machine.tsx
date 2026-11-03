import { createMemo, For, Show } from "solid-js";
import { normalizeCloudRepo } from "../../../../src/config/cloud-worker-project-profiles.js";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { readCloudWorkerProfiles } from "./cloud-worker-config.ts";
import { buildCloudWorkerRepositoryProfilePatch } from "./cloud-worker-repositories-config.ts";
import { useCloudWorkerConfig } from "./use-cloud-worker-config.ts";
type RepositoryMachineProps = {
  repository: string;
  /** `cloudWorkers.projectProfiles`: the only thing a session without a target can use. */
  defaultProfileId?: string;
  lastPreparedProfileId?: string;
};

export function CloudWorkerRepositoryMachine(props: RepositoryMachineProps) {
  // Save feedback belongs to one repository, including an unavailable identity.
  return <For each={[props.repository]}>{() => <RepositoryMachine {...props} />}</For>;
}

function RepositoryMachine(props: RepositoryMachineProps) {
  const editor = useCloudWorkerConfig(() => {});
  const profiles = createMemo(() => readCloudWorkerProfiles(editor.config()));
  const repository = () =>
    normalizeCloudRepo(`https://${props.repository}`) === props.repository
      ? props.repository
      : null;
  async function change(profileId: string) {
    const target = repository();
    if (!target) {
      return;
    }
    await editor.save({
      build: (base) => buildCloudWorkerRepositoryProfilePatch(base, target, profileId),
      note: `cloud environments: change default profile for ${target}`,
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
    });
  }
  const options = () => {
    const current = props.defaultProfileId;
    const listed = profiles().map((profile) => ({ value: profile.id, label: profile.id }));
    if (!current) {
      return [{ value: "", label: t("cloudWorkersPage.selectProfile"), disabled: true }, ...listed];
    }
    // A mapping to a removed profile still decides what happens, so it stays visible.
    return listed.some((option) => option.value === current)
      ? listed
      : [{ value: current, label: current, disabled: true }, ...listed];
  };
  const description = () => {
    const error = editor.state().error;
    if (error) {
      return (
        <span class="cloud-environments__error" role="alert">
          {error}
        </span>
      );
    }
    return props.lastPreparedProfileId
      ? t("cloudWorkersPage.environments.lastPrepared", { profile: props.lastPreparedProfileId })
      : undefined;
  };
  return (
    <Show when={!editor.readOnly() || props.defaultProfileId}>
      <SettingsRow
        title={t("cloudWorkersPage.repositoryProfile")}
        description={description()}
        control={
          <Show
            when={!editor.readOnly()}
            fallback={<SettingsValue value={props.defaultProfileId} />}
          >
            <span
              class="cloud-environments__machine"
              title={
                !repository() ? t("cloudWorkersPage.environments.identityUnavailable") : undefined
              }
            >
              <SettingsSelect
                aria-label={t("cloudWorkersPage.repositoryProfile")}
                value={props.defaultProfileId ?? ""}
                disabled={!repository() || !editor.writable()}
                options={options()}
                onChange={(event) => void change(event.currentTarget.value)}
              />
            </span>
          </Show>
        }
      />
    </Show>
  );
}
