import { createMemo, For, Show } from "solid-js";
import { normalizeCloudRepo } from "../../../../src/config/cloud-worker-project-profiles.js";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
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
  // Save feedback belongs to one repository, including an unavailable identity.
  return <For each={[props.repository]}>{() => <RepositoryMachine {...props} />}</For>;
}

function RepositoryMachine(props: RepositoryMachineProps) {
  const editor = useCloudWorkerConfig(() => {});
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
  async function change(profileId: string) {
    const target = repository();
    if (!target) {
      return;
    }
    await editor.save({
      build: (base) => buildCloudWorkerRepositoryProfilePatch(base, target, profileId),
      note: `cloud environments: change machine for ${target}`,
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
    });
  }
  return (
    <SettingsRow
      title={t("cloudWorkersPage.environments.machine")}
      description={
        <Show when={editor.state().error} fallback={facts()}>
          {(error) => (
            <span class="cloud-environments__error" role="alert">
              {error()}
            </span>
          )}
        </Show>
      }
      control={
        <span
          class="cloud-environments__machine"
          title={!repository() ? t("cloudWorkersPage.environments.identityUnavailable") : undefined}
        >
          <SettingsSelect
            aria-label={t("cloudWorkersPage.repositoryProfile")}
            value={props.defaultProfileId ?? ""}
            disabled={!repository() || !editor.writable()}
            options={[
              { value: "", label: t("cloudWorkersPage.selectProfile"), disabled: true },
              ...profiles().map((profile) => ({ value: profile.id, label: profile.id })),
            ]}
            onChange={(event) => void change(event.currentTarget.value)}
          />
        </span>
      }
    />
  );
}
