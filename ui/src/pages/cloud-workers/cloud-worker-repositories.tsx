import { createMemo, createSignal, createStore, For, Show } from "solid-js";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import { readCloudWorkerProfiles } from "./cloud-worker-config.ts";
import {
  buildCloudWorkerPreparedPoolPatch,
  buildCloudWorkerRepositoryDeletePatch,
  buildCloudWorkerRepositoryUpsertPatch,
  readCloudWorkerPreparedPool,
  readCloudWorkerRepositories,
  type CloudWorkerRepository,
  type CloudWorkerRepositoryPatch,
} from "./cloud-worker-repositories-config.ts";

registerEnglishCatalog(registerSettingsEnglish);

type RepositoryEditorState = {
  original: CloudWorkerRepository | null;
  draft: CloudWorkerRepository;
};

export const CloudWorkerRepositories = defineSolidBridge(
  "openclaw-cloud-worker-repositories",
  (props: { canManage: boolean }, host) => {
    host.style.display = "contents";
    const context = useApplication();
    const [view, setView] = createStore<{
      editor: RepositoryEditorState | null;
      poolDraft: string | null;
    }>({ editor: null, poolDraft: null });

    const [saveRevision, setSaveRevision] = createSignal(0, { ownedWrite: true });
    const configSave = new CloudWorkerConfigSave(() => setSaveRevision((revision) => revision + 1));
    const configProjection = projectRuntimeConfig(context.runtimeConfig);

    const gateway = useGatewayPage({
      getGateway: () => context.gateway,
      invalidateRequests: () => {
        setView((draft) => {
          draft.editor = null;
          draft.poolDraft = null;
        });
        configSave.update({ busy: false, error: null, notice: null });
      },
    });

    function config() {
      return resolveEditableSnapshotConfig(configProjection.read().state.configSnapshot);
    }

    function editable() {
      saveRevision();
      return props.canManage && !configSave.state.busy;
    }

    async function save(
      build: (config: Readonly<Record<string, unknown>>) => CloudWorkerRepositoryPatch,
    ): Promise<boolean> {
      const scope = gateway.capture();
      const runtimeConfig = context.runtimeConfig;
      if (!scope || !editable()) {
        return false;
      }
      const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
      return configSave.save(runtimeConfig, isCurrent, {
        build,
        note: "cloud workers: update repository defaults or prepared pool",
        canDispatch: () =>
          isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
        failed: () => t("cloudWorkersPage.errors.settingsSaveFailed"),
        success: () => t("cloudWorkersPage.settingsSaved"),
      });
    }

    function openEditor(mapping?: CloudWorkerRepository) {
      if (!editable()) {
        return;
      }
      setView((draft) => {
        draft.editor = {
          original: mapping ?? null,
          draft: mapping
            ? { ...mapping }
            : {
                repository: "",
                profileId: readCloudWorkerProfiles(config())[0]?.id ?? "",
              },
        };
      });
      configSave.update({ error: null, notice: null });
    }

    function changeDraft(patch: Partial<CloudWorkerRepository>) {
      if (view.editor) {
        setView((draft) => {
          if (draft.editor) {
            Object.assign(draft.editor.draft, patch);
          }
        });
        configSave.update({ error: null });
      }
    }

    async function saveRepository() {
      const editor = view.editor;
      if (
        editor &&
        (await save((base) =>
          buildCloudWorkerRepositoryUpsertPatch(base, editor.draft, editor.original),
        ))
      ) {
        setView((draft) => {
          draft.editor = null;
        });
      }
    }

    async function savePool() {
      const value = view.poolDraft ?? readCloudWorkerPreparedPool(config());
      if (await save(() => buildCloudWorkerPreparedPoolPatch(value))) {
        setView((draft) => {
          draft.poolDraft = null;
        });
      }
    }

    function RepositoryEditor(editorProps: { editor: RepositoryEditorState }) {
      const editorDraft = () => editorProps.editor.draft;
      const profiles = createMemo(() => readCloudWorkerProfiles(config()));
      const missingProfile = () =>
        !profiles().some((profile) => profile.id === editorDraft().profileId);
      return (
        <SettingsSection
          title={t(
            editorProps.editor.original === null
              ? "cloudWorkersPage.addRepository"
              : "cloudWorkersPage.editRepository",
          )}
        >
          <SettingsRow
            title={t("cloudWorkersPage.repositoryIdentity")}
            description={t("cloudWorkersPage.repositoryIdentityHelp")}
            control={
              <input
                class="settings-input mono"
                aria-label={t("cloudWorkersPage.repositoryIdentity")}
                autocomplete="off"
                spellcheck="false"
                value={editorDraft().repository}
                disabled={!editable()}
                onInput={(event: Event) => {
                  if (event.currentTarget instanceof HTMLInputElement) {
                    changeDraft({ repository: event.currentTarget.value });
                  }
                }}
              />
            }
          />
          <SettingsRow
            title={t("cloudWorkersPage.repositoryProfile")}
            control={
              <select
                class="settings-select"
                aria-label={t("cloudWorkersPage.repositoryProfile")}
                value={editorDraft().profileId}
                disabled={!editable()}
                onChange={(event: Event) => {
                  if (event.currentTarget instanceof HTMLSelectElement) {
                    changeDraft({ profileId: event.currentTarget.value });
                  }
                }}
              >
                {missingProfile() ? (
                  <option value={editorDraft().profileId} selected>
                    {editorDraft().profileId || t("cloudWorkersPage.selectProfile")}
                  </option>
                ) : null}
                {
                  <For each={profiles()}>
                    {(profile) => (
                      <option value={profile.id} selected={editorDraft().profileId === profile.id}>
                        {profile.id}
                      </option>
                    )}
                  </For>
                }
              </select>
            }
          />
          {missingProfile() ? (
            <div class="callout warning" role="alert">
              {t("cloudWorkersPage.errors.repositoryProfile")}
            </div>
          ) : null}
          <SettingsRow
            title={t("cloudWorkersPage.saveRepository")}
            control={
              <>
                {" "}
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={saveState().busy}
                  onClick={() => {
                    setView((draft) => {
                      draft.editor = null;
                    });
                    configSave.update({ error: null });
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  class="btn btn--sm primary"
                  type="button"
                  disabled={!editable()}
                  onClick={() => void saveRepository()}
                >
                  {t("cloudWorkersPage.saveRepository")}
                </button>
              </>
            }
          />
        </SettingsSection>
      );
    }

    const repositories = createMemo(() => readCloudWorkerRepositories(config()));
    const saveState = () => {
      saveRevision();
      return configSave.state;
    };
    return (
      <>
        <SettingsSection>
          <SettingsRow
            title={t("cloudWorkersPage.preparedPool")}
            description={t("cloudWorkersPage.preparedPoolHelp")}
            control={
              <>
                <input
                  class="settings-input"
                  type="number"
                  min="0"
                  step="1"
                  aria-label={t("cloudWorkersPage.preparedPool")}
                  value={view.poolDraft ?? readCloudWorkerPreparedPool(config())}
                  disabled={!editable()}
                  onInput={(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      const value = event.currentTarget.value;
                      setView((draft) => {
                        draft.poolDraft = value;
                      });
                      configSave.update({ error: null });
                    }
                  }}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void savePool();
                    }
                  }}
                />
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={!editable()}
                  onClick={() => void savePool()}
                >
                  {t("cloudWorkersPage.savePool")}
                </button>
              </>
            }
          />
        </SettingsSection>
        <SettingsSection
          title={t("cloudWorkersPage.repositories")}
          description={t("cloudWorkersPage.repositoriesHelp")}
          count={repositories().length}
          actions={
            <button
              class="btn btn--sm primary"
              type="button"
              disabled={!editable()}
              onClick={() => openEditor()}
            >
              {t("cloudWorkersPage.addRepository")}
            </button>
          }
        >
          {repositories().length ? (
            <For each={repositories()}>
              {(mapping) => (
                <SettingsRow
                  title={<code>{mapping.repository}</code>}
                  description={mapping.profileId}
                  control={
                    <>
                      {" "}
                      <button
                        class="btn btn--sm"
                        type="button"
                        aria-label={`${t("cloudWorkersPage.editAction")}: ${mapping.repository}`}
                        disabled={!editable()}
                        onClick={() => openEditor(mapping)}
                      >
                        {t("cloudWorkersPage.editAction")}
                      </button>
                      <button
                        class="btn btn--sm danger"
                        type="button"
                        aria-label={`${t("common.delete")}: ${mapping.repository}`}
                        disabled={!editable()}
                        onClick={() =>
                          void save((base) => buildCloudWorkerRepositoryDeletePatch(base, mapping))
                        }
                      >
                        {t("common.delete")}
                      </button>
                    </>
                  }
                />
              )}
            </For>
          ) : (
            <SettingsEmpty message={t("cloudWorkersPage.repositoriesEmpty")} />
          )}
        </SettingsSection>
        <Show when={view.editor} keyed>
          {(editor) => <RepositoryEditor editor={editor} />}
        </Show>
        {saveState().error ? (
          <div class="callout warning" role="alert">
            {saveState().error}
          </div>
        ) : null}
        {saveState().notice ? (
          <div class="callout" role="status">
            {saveState().notice}
          </div>
        ) : null}
      </>
    );
  },
  { properties: { canManage: { default: false, type: Boolean } } },
);
