import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { normalizeCloudRepo } from "../../../../src/config/cloud-worker-project-profiles.js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import { readCloudWorkerProfiles } from "./cloud-worker-config.ts";
import { buildCloudWorkerRepositoryProfilePatch } from "./cloud-worker-repositories-config.ts";
export function CloudWorkerRepositoryMachine(props: {
  repository: string;
  profileId?: string;
  defaultProfileId?: string;
  machineFacts: string;
}) {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const [editing, setEditing] = createSignal(false, { ownedWrite: true });
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const save = new CloudWorkerConfigSave(() => setRevision((value) => value + 1));
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => {
      setEditing(false);
      save.update({ busy: false, error: null, notice: null });
    },
  });
  const state = () => {
    revision();
    return save.state;
  };
  const config = () => resolveEditableSnapshotConfig(runtime.read().state.configSnapshot);
  const profiles = createMemo(() => readCloudWorkerProfiles(config()));
  const configuredProfile = createMemo(() =>
    profiles().find((profile) => profile.id === props.profileId),
  );
  const facts = () =>
    props.machineFacts ||
    [configuredProfile()?.backend, configuredProfile()?.machineClass, configuredProfile()?.target]
      .filter(Boolean)
      .join(" · ");
  createEffect(
    () => props.repository,
    () => {
      setEditing(false);
      save.update({ error: null, notice: null });
    },
  );
  const repository = () =>
    normalizeCloudRepo(`https://${props.repository}`) === props.repository
      ? props.repository
      : null;
  const editable = () =>
    Boolean(
      repository() &&
      canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin") &&
      runtime.read().state.configSnapshot?.hash &&
      !runtime.read().state.configSaving &&
      !state().busy,
    );
  async function change(profileId: string) {
    const scope = gateway.capture();
    const runtimeConfig = context.runtimeConfig;
    const target = repository();
    if (!scope || !target || !editable()) {
      return;
    }
    const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
    await save.save(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerRepositoryProfilePatch(base, target, profileId),
      note: `cloud environments: change machine for ${target}`,
      canDispatch: () =>
        isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
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
            disabled={state().busy}
            onClick={() => setEditing(false)}
          >
            {t("common.cancel")}
          </button>
        </Show>
      </div>
      <Show when={state().error}>
        <div class="callout warning" role="alert">
          {state().error}
        </div>
      </Show>
    </SettingsSection>
  );
}
