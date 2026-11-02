import type { JSX } from "@solidjs/web";
import {
  action,
  createOptimistic,
  createMemo,
  createSignal,
  createStore,
  Errored,
  Loading,
  onSettled,
  Show,
  For,
} from "solid-js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import "../../components/modal-dialog.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  DocsLink,
  SettingsLoadingSkeleton,
  SettingsNavRow,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { SettingsSelectRow } from "../config/settings-select-row.tsx";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  createCloudWorkerDraft,
  readCloudWorkerProfiles,
  validateCloudWorkerDraft,
  type CloudWorkerProfileDraft,
  type ConfiguredCloudWorkerProfile,
} from "./cloud-worker-config.ts";
import { CloudWorkerEnvironments } from "./cloud-worker-environments.tsx";

registerEnglishCatalog(registerSettingsEnglish);
const CLOUD_WORKERS_DOCS_URL = "https://docs.openclaw.ai/gateway/cloud-workers";
type ProfileSummary = NonNullable<EnvironmentsListResult["profiles"]>[number];
/** `external` profiles aren't editable here: another provider, or no machine class to edit. */
type EditorState = { kind: "add" } | { kind: "edit" | "external"; profileId: string } | null;

export function CloudWorkersPage() {
  const context = useApplication();
  const [view, setView] = createStore<{ editor: EditorState; draft: CloudWorkerProfileDraft }>({
    editor: null,
    draft: createCloudWorkerDraft(),
  });
  const configSave = new CloudWorkerConfigSave(() => saveProjection.publish());
  const saveProjection = projectMutableSource(configSave, (owner) => owner.state);
  const saveState = saveProjection.read;
  let saveLifetime = Promise.withResolvers<void>();
  function retireSavePresentation() {
    saveLifetime.resolve();
    saveLifetime = Promise.withResolvers<void>();
  }
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const [catalog, setCatalog] = createSignal<Map<string, ProfileSummary>>();
  const [catalogLoad, setCatalogLoad] = createSignal<{ promise: Promise<void> } | null>(null);
  const catalogCompletion = createMemo(() => catalogLoad()?.promise.then(() => null) ?? null);
  let previousCatalogReceipt: ReturnType<typeof catalogReceipt> | undefined;
  let catalogRequest: AbortController | undefined;
  function clearPresentation() {
    retireSavePresentation();
    setView((state) => {
      state.editor = null;
      state.draft = createCloudWorkerDraft();
    });
    setCatalog(undefined);
    setCatalogLoad(null);
  }
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: clearPresentation,
    onSnapshot: ({ snapshot }) => {
      if (
        snapshot.phase === "connected" &&
        !canCallGatewayMethod(snapshot, "config.patch", "operator.admin")
      ) {
        gateway.invalidate();
        configSave.update({ busy: false, error: null });
        clearPresentation();
      }
      refreshCatalog();
    },
    invalidateRequests: () => {
      retireSavePresentation();
      catalogRequest?.abort();
      configSave.update({ busy: false });
    },
  });
  const saveScope = createMemo(() => {
    saveState();
    return saveLifetime;
  });
  const savePresentation = createMemo(() => {
    const retired = saveScope().promise;
    const [saving, setSaving] = createOptimistic(false);
    return { retired, saving, setSaving };
  });
  const saving = () => savePresentation().saving() || saveState().busy;
  const presentSave = action(function* (
    current: ReturnType<typeof savePresentation>,
    pending: Promise<boolean>,
  ) {
    if (current.retired === saveLifetime.promise) {
      current.setSaving(true);
    }
    yield Promise.race([pending, current.retired]);
  });
  async function saveConfig(...args: Parameters<CloudWorkerConfigSave["save"]>) {
    const current = savePresentation();
    const pending = configSave.save(...args);
    // The plain owner admits the patch before Solid presents its progress.
    await Promise.resolve();
    return presentSave(current, pending);
  }
  void context.runtimeConfig.ensureLoaded();
  function catalogReceipt() {
    const snapshot = context.gateway.snapshot;
    return [
      snapshot.client,
      snapshot.phase,
      gateway.readEpoch(),
      context.runtimeConfig.state.configSnapshot?.appliedConfigHash,
    ] as const;
  }
  function refreshCatalog() {
    const key = catalogReceipt();
    if (previousCatalogReceipt?.every((value, index) => value === key[index])) {
      return;
    }
    previousCatalogReceipt = key;
    catalogRequest?.abort();
    const appliedHash = key[3];
    const controller = (catalogRequest = new AbortController());
    // A nested bridge can flush effects while its parent is still rendering.
    queueMicrotask(() => {
      if (controller.signal.aborted) {
        return;
      }
      const scope = gateway.capture();
      if (
        !scope ||
        !canCallGatewayMethod(gateway.snapshot, "environments.list", "operator.admin")
      ) {
        if (gateway.connected) {
          setCatalog(undefined);
        }
        setCatalogLoad(null);
        return;
      }
      const promise = scope.client
        .request<EnvironmentsListResult>(
          "environments.list",
          { projection: "profiles" },
          { signal: controller.signal },
        )
        .then(
          (result) => {
            if (
              !controller.signal.aborted &&
              gateway.isCurrent(scope) &&
              context.runtimeConfig.state.configSnapshot?.appliedConfigHash === appliedHash
            ) {
              setCatalog(new Map((result.profiles ?? []).map((profile) => [profile.id, profile])));
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted && gateway.isCurrent(scope)) {
              throw error;
            }
          },
        );
      setCatalogLoad({ promise });
      // The async memo owns feedback; retired and unobserved tasks still settle safely.
      void promise.catch(() => undefined);
    });
  }
  onSettled(() => {
    // Applied-config receipts abort the prior catalog request before refreshing profiles.
    const stop = configProjection.subscribe(refreshCatalog);
    const stopRoute = context.router.subscribe(() => {
      retireSavePresentation();
      saveProjection.publish();
    });
    refreshCatalog();
    return () => {
      stop();
      stopRoute();
      saveLifetime.resolve();
    };
  });
  function editableConfig(): Record<string, unknown> | null {
    return resolveEditableSnapshotConfig(configProjection.read().state.configSnapshot);
  }

  const profiles = createMemo(() => readCloudWorkerProfiles(editableConfig()));

  /** Connected without write access. A dropped connection keeps its rows and actions. */
  const readOnly = () => gateway.connected && !hasManageAccess();

  function hasManageAccess(): boolean {
    return canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin");
  }

  function canManage(): boolean {
    const configState = configProjection.read().state;
    return Boolean(
      hasManageAccess() &&
      configState.configSnapshot?.hash &&
      !configState.configLoading &&
      !configState.configSaving &&
      !saveState().busy,
    );
  }

  function openEditor(profile?: ConfiguredCloudWorkerProfile) {
    if (!canManage()) {
      return;
    }
    setView((state) => {
      state.editor = !profile
        ? { kind: "add" }
        : {
            kind: profile.providerId === "crabbox" && profile.machineClass ? "edit" : "external",
            profileId: profile.id,
          };
      state.draft = createCloudWorkerDraft(profile);
    });
    configSave.update({ error: null });
  }

  function closeEditor() {
    if (saveState().busy) {
      return;
    }
    setView((state) => {
      state.editor = null;
    });
    configSave.update({ error: null });
  }

  function patchDraft(patch: Partial<CloudWorkerProfileDraft>) {
    setView((state) => {
      Object.assign(state.draft, patch);
    });
    configSave.update({ error: null });
  }

  async function saveProfile(draft: CloudWorkerProfileDraft) {
    const scope = gateway.capture();
    const runtimeConfig = context.runtimeConfig;
    const editingId = view.editor?.kind === "edit" ? view.editor.profileId : null;
    const config = editableConfig();
    if (!scope || !view.editor || !config || !canManage()) {
      return;
    }
    const currentProfiles = Object.fromEntries(
      readCloudWorkerProfiles(config).map((profile) => [profile.id, true]),
    );
    const validationError = validateCloudWorkerDraft(draft, currentProfiles, editingId);
    if (validationError) {
      configSave.update({ error: t(`cloudWorkersPage.errors.${validationError}`) });
      return;
    }
    const profileId = editingId ?? draft.id;
    const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
    await saveConfig(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerUpsertPatch(base, draft, editingId),
      note: `cloud workers: ${editingId ? "update" : "add"} ${profileId}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
      success: () => {
        setView((state) => {
          state.editor = null;
        });
      },
    });
  }

  async function deleteProfile(profile: ConfiguredCloudWorkerProfile) {
    const capturedGateway = context.gateway;
    const client = capturedGateway.snapshot.client;
    const gatewayUrl = capturedGateway.connection.gatewayUrl;
    const runtimeConfig = context.runtimeConfig;
    if (
      !canManage() ||
      !(await showConfirmDialog({
        title: t("cloudWorkersPage.deleteTitle"),
        message: t("cloudWorkersPage.deleteConfirm", { profile: profile.id }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    const scope = gateway.capture();
    if (
      !scope ||
      scope.client !== client ||
      context.gateway !== capturedGateway ||
      capturedGateway.connection.gatewayUrl !== gatewayUrl ||
      context.runtimeConfig !== runtimeConfig ||
      !canManage()
    ) {
      configSave.update({ error: t("cloudWorkersPage.errors.deleteFailed") });
      return;
    }
    const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
    await saveConfig(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerDeletePatch(base, profile.id),
      note: `cloud workers: delete ${profile.id}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.deleteFailed"),
      success: () => {
        if (editorProfileId() === profile.id) {
          setView((state) => {
            state.editor = null;
          });
        }
      },
    });
  }

  const editorProfileId = () =>
    view.editor && view.editor.kind !== "add" ? view.editor.profileId : null;

  /** What the machine is; how long it lives and the rest is one click away, in its editor. */
  function profileDescription(profile: ConfiguredCloudWorkerProfile): string {
    if (profile.providerId !== "crabbox") {
      return t("cloudWorkersPage.providerFact", {
        provider: profile.providerId || t("common.unknown"),
      });
    }
    const operatingSystem =
      profile.target && profile.target !== "linux"
        ? (catalog()
            ?.get(profile.id)
            ?.operatingSystems?.find((system) => system.id === profile.target)?.label ??
          profile.target)
        : "";
    return [profile.backend, profile.machineClass, operatingSystem].filter(Boolean).join(" · ");
  }

  function renderProfile(profile: ConfiguredCloudWorkerProfile) {
    const status = () => (
      <Show
        when={catalog()}
        fallback={
          <Show when={catalogLoad()} keyed>
            {(request) => (
              <Errored fallback={null}>
                <Loading
                  on={request}
                  fallback={<SettingsStatus kind={"muted"} label={t("common.loading")} />}
                >
                  {catalogCompletion()}
                </Loading>
              </Errored>
            )}
          </Show>
        }
      >
        <Show
          when={catalog()?.has(profile.id)}
          fallback={<SettingsStatus kind={"warn"} label={t("cloudWorkersPage.unavailable")} />}
        >
          <SettingsStatus kind={"ok"} label={t("cloudWorkersPage.available")} />
        </Show>
      </Show>
    );
    return (
      <Show
        when={!readOnly()}
        fallback={<SettingsRow title={profile.id} description={profileDescription(profile)} />}
      >
        <SettingsNavRow
          title={profile.id}
          description={profileDescription(profile)}
          control={status()}
          onClick={() => openEditor(profile)}
        />
      </Show>
    );
  }

  function renderDraftInput(
    field:
      | "id"
      | "backend"
      | "machineClass"
      | "ttl"
      | "idleTimeout"
      | "binary"
      | "setupEnv"
      | "readyWorkers"
      | "suspendAfter",
    options: {
      description?: JSX.Element;
      placeholder?: string;
      type?: "text" | "number";
    } = {},
  ) {
    const label = field === "id" ? "profileId" : field;
    return (
      <SettingsRow
        stacked
        title={t(`cloudWorkersPage.fields.${label}`)}
        description={options.description ?? t(`cloudWorkersPage.fields.${label}Help`)}
        control={
          <input
            class="settings-input mono"
            aria-label={t(`cloudWorkersPage.fields.${label}`)}
            placeholder={options.placeholder}
            type={options.type}
            min={field === "readyWorkers" ? "0" : undefined}
            step={field === "readyWorkers" ? "1" : undefined}
            autocomplete="off"
            spellcheck="false"
            value={view.draft[field]}
            disabled={saving()}
            onInput={(event) => patchDraft({ [field]: event.currentTarget.value })}
          />
        }
      />
    );
  }

  function Editor() {
    const editing = () => view.editor?.kind === "edit";
    const external = () => view.editor?.kind === "external";
    const title = () =>
      view.editor?.kind === "add"
        ? t("cloudWorkersPage.addProfile")
        : t("cloudWorkersPage.editProfile");
    const systems = () =>
      editing() ? (catalog()?.get(view.draft.id)?.operatingSystems ?? []) : [];
    const unadvertised = () =>
      Boolean(view.draft.target && !systems().some((system) => system.id === view.draft.target));
    const existing = () => profiles().find((profile) => profile.id === editorProfileId());
    const draftHasAdvanced = Boolean(
      view.draft.setup ||
      view.draft.setupEnv ||
      view.draft.binary ||
      view.draft.desktop ||
      view.draft.readyWorkers ||
      view.draft.suspendAfter ||
      view.draft.warmImage !== "auto",
    );
    return (
      <openclaw-modal-dialog
        label={title()}
        description={external() ? "" : t("cloudWorkersPage.fields.actionsHelp")}
        onModal-cancel={closeEditor}
      >
        <section class="oc-dialog cloud-environments__editor">
          <header class="oc-dialog__header">
            <h2 class="oc-dialog__title">{title()}</h2>
            <button
              class="oc-dialog__close"
              type="button"
              aria-label={t("common.dismiss")}
              onClick={closeEditor}
            >
              <Icon name="x" />
            </button>
            <Show when={!external()}>
              <div class="oc-dialog__description">
                <p>{t("cloudWorkersPage.fields.actionsHelp")}</p>
              </div>
            </Show>
          </header>
          <div class="oc-dialog__body">
            <Show
              when={!external()}
              fallback={
                <SettingsRow
                  title={view.draft.id}
                  description={existing() ? profileDescription(existing()!) : undefined}
                />
              }
            >
              <Show when={editing()} fallback={renderDraftInput("id")}>
                <SettingsRow
                  title={t("cloudWorkersPage.fields.profileId")}
                  control={<SettingsValue value={view.draft.id} mono />}
                />
              </Show>
              {renderDraftInput("backend", {
                description: (
                  <>
                    {t("cloudWorkersPage.fields.backendHelp")}{" "}
                    <DocsLink url={CLOUD_WORKERS_DOCS_URL}>
                      {t("cloudWorkersPage.providerList")}
                    </DocsLink>
                  </>
                ),
                placeholder: t("cloudWorkersPage.fields.backendPlaceholder"),
              })}
              <Show when={systems().length >= 2 || unadvertised()}>
                <SettingsRow
                  stacked
                  title={t("cloudWorkersPage.fields.operatingSystem")}
                  description={t("cloudWorkersPage.fields.operatingSystemHelp")}
                  control={
                    <SettingsSelect
                      aria-label={t("cloudWorkersPage.fields.operatingSystem")}
                      value={view.draft.target}
                      options={[
                        { value: "", label: t("cloudWorkersPage.fields.providerDefault") },
                        ...systems().map((system) => ({
                          value: system.id,
                          label: `${system.label}${system.disabledReason ? ` — ${system.disabledReason}` : ""}`,
                          disabled: Boolean(system.disabledReason),
                        })),
                        ...(unadvertised()
                          ? [{ value: view.draft.target, label: view.draft.target }]
                          : []),
                      ]}
                      disabled={saving()}
                      onChange={(event) => {
                        const target = event.currentTarget.value;
                        if (!systems().find((system) => system.id === target)?.disabledReason) {
                          patchDraft({ target });
                        }
                      }}
                    />
                  }
                />
              </Show>
              {renderDraftInput("machineClass")}
              {renderDraftInput("ttl", {
                placeholder: t("cloudWorkersPage.fields.ttlPlaceholder"),
              })}
              {renderDraftInput("idleTimeout", {
                placeholder: t("cloudWorkersPage.fields.idleTimeoutPlaceholder"),
              })}
              <SettingsDisclosure
                nested
                title={t("cloudWorkersPage.advanced")}
                open={draftHasAdvanced}
              >
                <SettingsRow
                  title={t("cloudWorkersPage.fields.setup")}
                  description={t("cloudWorkersPage.fields.setupHelp")}
                  stacked
                  control={
                    <textarea
                      class="settings-input mono"
                      aria-label={t("cloudWorkersPage.fields.setup")}
                      placeholder={t("cloudWorkersPage.fields.setupPlaceholder")}
                      autocomplete="off"
                      spellcheck="false"
                      value={view.draft.setup}
                      disabled={saving()}
                      onInput={(event) => patchDraft({ setup: event.currentTarget.value })}
                    />
                  }
                />
                {renderDraftInput("setupEnv")}
                <SettingsSelectRow
                  title={t("cloudWorkersPage.fields.warmImage")}
                  description={t("cloudWorkersPage.fields.warmImageHelp")}
                  value={view.draft.warmImage}
                  disabled={saving()}
                  onChange={(value) => {
                    if (value === "auto" || value === "on" || value === "off") {
                      patchDraft({ warmImage: value });
                    }
                  }}
                  options={(["auto", "on", "off"] as const).map((value) => ({
                    value,
                    label: t(`cloudWorkersPage.warmImage.${value}`),
                  }))}
                />
                {renderDraftInput("readyWorkers", { type: "number" })}
                {renderDraftInput("suspendAfter")}
                <SettingsToggleRow
                  title={t("cloudWorkersPage.fields.desktop")}
                  description={t("cloudWorkersPage.fields.desktopHelp")}
                  checked={view.draft.desktop}
                  disabled={saving()}
                  onChange={(desktop) => patchDraft({ desktop })}
                />
                {renderDraftInput("binary", {
                  placeholder: t("cloudWorkersPage.fields.binaryPlaceholder"),
                })}
              </SettingsDisclosure>
            </Show>
          </div>
          <openclaw-modal-actions class="oc-dialog__footer">
            <Show when={saveState().error}>
              <p class="cloud-environments__editor-error" role="alert">
                {saveState().error}
              </p>
            </Show>
            <Show when={existing()}>
              {(profile) => (
                <button
                  class="btn danger cloud-environments__editor-delete"
                  type="button"
                  disabled={saving() || !canManage()}
                  onClick={() => void deleteProfile(profile())}
                >
                  {t("common.delete")}
                </button>
              )}
            </Show>
            <button class="btn" type="button" disabled={saving()} onClick={closeEditor}>
              {t("common.cancel")}
            </button>
            <Show
              when={!external()}
              fallback={
                <button
                  class="btn primary"
                  type="button"
                  onClick={() => context.navigate("advanced", { search: "?section=cloudWorkers" })}
                >
                  {t("cloudWorkersPage.editAction")}
                </button>
              }
            >
              <button
                class="btn primary"
                type="button"
                disabled={saving() || !canManage()}
                onClick={() => void saveProfile({ ...view.draft })}
              >
                {saving() ? t("common.saving") : t("common.save")}
              </button>
            </Show>
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    );
  }

  const configLoaded = () => Boolean(configProjection.read().state.configSnapshot);

  return (
    <openclaw-cloud-workers-page>
      <SettingsPageHeader title={t("tabs.cloudWorkers")} />
      <SettingsWorkspace>
        <CloudWorkerEnvironments
          machines={() => (
            <SettingsSection
              title={t("cloudWorkersPage.environments.machines")}
              notice={
                <>
                  <Errored
                    fallback={(error) => (
                      <div class="callout warning" role="status">
                        {t("cloudWorkersPage.catalogFailed", { error: formatUiError(error()) })}
                      </div>
                    )}
                  >
                    <Loading on={catalogLoad()}>{catalogCompletion()}</Loading>
                  </Errored>
                  <Show when={saveState().error && !view.editor}>
                    <div class="callout warning" role="alert">
                      {saveState().error}
                    </div>
                  </Show>
                </>
              }
              actions={
                <Show when={!readOnly()}>
                  <button
                    class="btn btn--sm primary"
                    type="button"
                    disabled={saving() || !canManage()}
                    onClick={() => openEditor()}
                  >
                    {t("cloudWorkersPage.addProfile")}
                  </button>
                </Show>
              }
            >
              <Show when={configLoaded()} fallback={<SettingsLoadingSkeleton rows={1} />}>
                <For
                  each={profiles()}
                  fallback={
                    <SettingsRow
                      title={
                        <span class="cloud-environments__empty">{t("cloudWorkersPage.empty")}</span>
                      }
                    />
                  }
                >
                  {(profile) => renderProfile(profile)}
                </For>
              </Show>
            </SettingsSection>
          )}
        />
        <Show when={view.editor}>
          <Editor />
        </Show>
      </SettingsWorkspace>
    </openclaw-cloud-workers-page>
  );
}
