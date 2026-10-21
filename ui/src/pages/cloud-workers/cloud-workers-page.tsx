import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createStore, onCleanup, onSettled, Show, For } from "solid-js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  DocsLink,
  SettingsEmpty,
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
type EditorState = { kind: "add" } | { kind: "edit"; profileId: string } | null;

export function CloudWorkersPage() {
  const context = useApplication();
  const [view, setView] = createStore<{ editor: EditorState; draft: CloudWorkerProfileDraft }>({
    editor: null,
    draft: createCloudWorkerDraft(),
  });
  const [saveRevision, setSaveRevision] = createSignal(0, { ownedWrite: true });
  const configSave = new CloudWorkerConfigSave(() => setSaveRevision((value) => value + 1));
  const saveState = () => {
    saveRevision();
    return configSave.state;
  };
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const [catalog, setCatalog] = createSignal<{
    pending: boolean;
    value?: Map<string, ProfileSummary>;
    error?: string;
  }>({ pending: false });
  let previousCatalogReceipt: ReturnType<typeof catalogReceipt> | undefined;
  let catalogRequest: AbortController | undefined;
  function clearPresentation() {
    setView((state) => {
      state.editor = null;
      state.draft = createCloudWorkerDraft();
    });
    setCatalog({ pending: false });
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
        configSave.update({ busy: false, error: null, notice: null });
        clearPresentation();
      }
      refreshCatalog();
    },
    invalidateRequests: () => configSave.update({ busy: false }),
  });
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
          setCatalog({ pending: false });
        } else {
          setCatalog((previous) => ({ ...previous, pending: false }));
        }
        return;
      }
      setCatalog((previous) => ({ ...previous, pending: true }));
      void scope.client
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
              setCatalog({
                pending: false,
                value: new Map((result.profiles ?? []).map((profile) => [profile.id, profile])),
              });
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted && gateway.isCurrent(scope)) {
              setCatalog((previous) => ({
                ...previous,
                pending: false,
                error: formatUiError(error),
              }));
            }
          },
        );
    });
  }
  onSettled(() => {
    // Applied-config receipts abort the prior catalog request before refreshing profiles.
    const stop = configProjection.subscribe(refreshCatalog);
    refreshCatalog();
    return stop;
  });
  onCleanup(() => catalogRequest?.abort());
  function editableConfig(): Record<string, unknown> | null {
    return resolveEditableSnapshotConfig(configProjection.read().state.configSnapshot);
  }

  const profiles = createMemo(() => readCloudWorkerProfiles(editableConfig()));

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
    if (profile && (profile.providerId !== "crabbox" || !profile.machineClass)) {
      context.navigate("advanced", { search: "?section=cloudWorkers" });
      return;
    }
    setView((state) => {
      state.editor = profile ? { kind: "edit", profileId: profile.id } : { kind: "add" };
      state.draft = createCloudWorkerDraft(profile);
    });
    configSave.update({ error: null, notice: null });
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
    await configSave.save(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerUpsertPatch(base, draft, editingId),
      note: `cloud workers: ${editingId ? "update" : "add"} ${profileId}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
      success: () => {
        setView((state) => {
          state.editor = null;
        });
        return t("cloudWorkersPage.profileSaved");
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
    await configSave.save(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerDeletePatch(base, profile.id),
      note: `cloud workers: delete ${profile.id}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.deleteFailed"),
      success: () => {
        if (view.editor?.kind === "edit" && view.editor.profileId === profile.id) {
          setView((state) => {
            state.editor = null;
          });
        }
        return t("cloudWorkersPage.settingsSaved");
      },
    });
  }

  function profileDescription(profile: ConfiguredCloudWorkerProfile): string {
    if (profile.providerId !== "crabbox") {
      return t("cloudWorkersPage.providerFact", {
        provider: profile.providerId || t("common.unknown"),
      });
    }
    return [
      t("cloudWorkersPage.backendFact", { backend: profile.backend || t("common.unknown") }),
      t("cloudWorkersPage.classFact", { value: profile.machineClass || t("common.unknown") }),
      ...(profile.target && profile.target !== "linux"
        ? [
            t("cloudWorkersPage.operatingSystemFact", {
              value:
                catalog()
                  .value?.get(profile.id)
                  ?.operatingSystems?.find((system) => system.id === profile.target)?.label ??
                profile.target,
            }),
          ]
        : []),
      t("cloudWorkersPage.ttlFact", { value: profile.ttl || t("common.unknown") }),
      t("cloudWorkersPage.idleFact", { value: profile.idleTimeout || t("common.unknown") }),
      t("cloudWorkersPage.desktopFact", {
        value: profile.desktop ? t("common.enabled") : t("common.disabled"),
      }),
    ].join(" · ");
  }

  function renderProfile(profile: ConfiguredCloudWorkerProfile) {
    const statusControl = () =>
      catalog().pending && !catalog().value ? (
        <SettingsStatus kind={"muted"} label={t("common.loading")} />
      ) : catalog().value?.has(profile.id) ? (
        <SettingsStatus kind={"ok"} label={t("cloudWorkersPage.advertised")} />
      ) : (
        <SettingsStatus kind={"warn"} label={t("cloudWorkersPage.unavailable")} />
      );

    return (
      <SettingsRow
        title={<code>{profile.id}</code>}
        description={profileDescription(profile)}
        control={
          <>
            {statusControl()}
            <button
              class="btn btn--sm"
              type="button"
              aria-label={`${t("cloudWorkersPage.editAction")}: ${profile.id}`}
              disabled={!canManage()}
              onClick={() => openEditor(profile)}
            >
              {t("cloudWorkersPage.editAction")}
            </button>
            <button
              class="btn btn--sm danger"
              type="button"
              aria-label={`${t("common.delete")}: ${profile.id}`}
              disabled={!canManage()}
              onClick={() => void deleteProfile(profile)}
            >
              {t("common.delete")}
            </button>
          </>
        }
      />
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
            disabled={saveState().busy}
            onInput={(event) => patchDraft({ [field]: event.currentTarget.value })}
          />
        }
      />
    );
  }

  function Editor() {
    const editing = () => view.editor?.kind === "edit";
    const systems = () =>
      editing() ? (catalog().value?.get(view.draft.id)?.operatingSystems ?? []) : [];
    const unadvertised = () =>
      Boolean(view.draft.target && !systems().some((system) => system.id === view.draft.target));
    return (
      <SettingsSection
        title={editing() ? t("cloudWorkersPage.editProfile") : t("cloudWorkersPage.addProfile")}
      >
        <Show when={editing()} fallback={renderDraftInput("id")}>
          <SettingsRow
            title={t("cloudWorkersPage.fields.profileId")}
            description={t("cloudWorkersPage.fields.profileIdHelp")}
            control={<SettingsValue value={view.draft.id} mono />}
          />
        </Show>
        {renderDraftInput("backend", {
          description: (
            <>
              {t("cloudWorkersPage.fields.backendHelp")}{" "}
              <DocsLink url={CLOUD_WORKERS_DOCS_URL}>{t("cloudWorkersPage.providerList")}</DocsLink>
            </>
          ),
          placeholder: t("cloudWorkersPage.fields.backendPlaceholder"),
        })}
        <Show when={systems().length >= 2 || unadvertised()}>
          <SettingsRow
            title={t("cloudWorkersPage.fields.operatingSystem")}
            description={t("cloudWorkersPage.fields.operatingSystemHelp")}
            control={
              <select
                class="settings-select"
                aria-label={t("cloudWorkersPage.fields.operatingSystem")}
                value={view.draft.target}
                disabled={saveState().busy}
                onChange={(event) => {
                  const target = event.currentTarget.value;
                  if (!systems().find((system) => system.id === target)?.disabledReason) {
                    patchDraft({ target });
                  }
                }}
              >
                <option value="" selected={!view.draft.target}>
                  {t("cloudWorkersPage.fields.providerDefault")}
                </option>
                <For each={systems()}>
                  {(system) => (
                    <option
                      value={system.id}
                      selected={view.draft.target === system.id}
                      disabled={Boolean(system.disabledReason)}
                    >
                      {system.label}
                      {system.disabledReason ? ` — ${system.disabledReason}` : ""}
                    </option>
                  )}
                </For>
                <Show when={unadvertised()}>
                  <option value={view.draft.target} selected>
                    {view.draft.target}
                  </option>
                </Show>
              </select>
            }
          />
        </Show>
        {renderDraftInput("machineClass")}
        {renderDraftInput("ttl", { placeholder: t("cloudWorkersPage.fields.ttlPlaceholder") })}
        {renderDraftInput("idleTimeout", {
          placeholder: t("cloudWorkersPage.fields.idleTimeoutPlaceholder"),
        })}
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
              disabled={saveState().busy}
              onInput={(event) => patchDraft({ setup: event.currentTarget.value })}
            />
          }
        />
        <SettingsToggleRow
          title={t("cloudWorkersPage.fields.desktop")}
          description={t("cloudWorkersPage.fields.desktopHelp")}
          checked={view.draft.desktop}
          disabled={saveState().busy}
          onChange={(desktop) => patchDraft({ desktop })}
        />
        {renderDraftInput("binary", {
          placeholder: t("cloudWorkersPage.fields.binaryPlaceholder"),
        })}
        <SettingsSection title={t("cloudWorkersPage.advanced")}>
          <SettingsSelectRow
            title={t("cloudWorkersPage.fields.warmImage")}
            description={t("cloudWorkersPage.fields.warmImageHelp")}
            value={view.draft.warmImage}
            disabled={saveState().busy}
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
          <For each={["setupEnv", "readyWorkers", "suspendAfter"] as const}>
            {(field) =>
              renderDraftInput(field, { type: field === "readyWorkers" ? "number" : "text" })
            }
          </For>
        </SettingsSection>
        <Show when={saveState().error}>
          <SettingsRow
            title={t("cloudWorkersPage.errors.title")}
            description={<span role="alert">{saveState().error}</span>}
          />
        </Show>
        <SettingsRow
          title={t("cloudWorkersPage.fields.actions")}
          description={t("cloudWorkersPage.fields.actionsHelp")}
          control={
            <>
              <button
                class="btn primary"
                type="button"
                disabled={!canManage()}
                onClick={() => void saveProfile({ ...view.draft })}
              >
                {saveState().busy ? t("common.saving") : t("common.save")}
              </button>
              <button class="btn" type="button" disabled={saveState().busy} onClick={closeEditor}>
                {t("common.cancel")}
              </button>
            </>
          }
        />
      </SettingsSection>
    );
  }

  return (
    <openclaw-cloud-workers-page>
      <SettingsPageHeader title={t("tabs.cloudWorkers")} />
      <SettingsWorkspace>
        <CloudWorkerEnvironments
          machines={() => (
            <>
              <Show when={!hasManageAccess()}>
                <div class="callout warning" role="note">
                  {t("cloudWorkersPage.adminRequired")}
                </div>
              </Show>
              <Show when={catalog().error}>
                <div class="callout warning" role="status">
                  {t("cloudWorkersPage.catalogFailed", { error: catalog().error ?? "" })}
                </div>
              </Show>
              <Show when={saveState().error && !view.editor}>
                <div class="callout warning" role="alert">
                  {saveState().error}
                </div>
              </Show>
              <Show when={saveState().notice}>
                <div class="callout" role="status">
                  {saveState().notice}
                </div>
              </Show>
              <SettingsSection
                title={t("cloudWorkersPage.environments.machines")}
                count={profiles().length}
                actions={
                  <Show when={canManage()}>
                    <button class="btn btn--sm primary" type="button" onClick={() => openEditor()}>
                      {t("cloudWorkersPage.addProfile")}
                    </button>
                  </Show>
                }
              >
                <For
                  each={profiles()}
                  fallback={<SettingsEmpty message={t("cloudWorkersPage.empty")} />}
                >
                  {(profile) => renderProfile(profile)}
                </For>
              </SettingsSection>
              <Show when={view.editor}>
                <Editor />
              </Show>
            </>
          )}
        />
      </SettingsWorkspace>
    </openclaw-cloud-workers-page>
  );
}
