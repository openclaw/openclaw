import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createStore, For } from "solid-js";
import { parseDurationMs } from "../../../../src/cli/parse-duration.js";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "../config/settings-select-row.tsx";
import { useCloudWorkerConfig } from "./use-cloud-worker-config.ts";

registerEnglishCatalog(registerSettingsEnglish);

type PolicyDraft = { refreshAfter: string; retainUnused: string; keepPrevious: "0" | "1" };

export function CloudWorkerSnapshotPolicy() {
  const [draft, setDraft] = createStore<{ value: PolicyDraft | null }>({ value: null });
  const resetDraft = () => {
    setDraft((state) => {
      state.value = null;
    });
  };
  const editor = useCloudWorkerConfig(resetDraft);
  void editor.ensureLoaded();
  const saveState = editor.state;
  const policy = createMemo<PolicyDraft>(() => {
    let value: unknown = editor.config();
    for (const key of ["plugins", "entries", "crabbox", "config", "warmImages"]) {
      value = isRecord(value) ? value[key] : undefined;
    }
    const configured = isRecord(value) ? value : {};
    return {
      refreshAfter: typeof configured.refreshAfter === "string" ? configured.refreshAfter : "24h",
      retainUnused: typeof configured.retainUnused === "string" ? configured.retainUnused : "14d",
      keepPrevious: configured.keepPrevious === 1 ? "1" : "0",
    };
  });
  const values = () => draft.value ?? policy();
  const canSave = () => editor.editable() && !editor.loading();
  function edit(patch: Partial<PolicyDraft>) {
    setDraft((state) => {
      state.value ??= { ...policy() };
      Object.assign(state.value, patch);
    });
    editor.update({ error: null, notice: null });
  }
  async function save() {
    if (!canSave()) {
      return;
    }
    const current = { ...values() };
    for (const [key, minimum] of [
      ["refreshAfter", 3_600_000],
      ["retainUnused", 86_400_000],
    ] as const) {
      if (
        !/^[1-9][0-9]{0,7}(m|h|d)(?![\s\S])/.test(current[key]) ||
        parseDurationMs(current[key]) < minimum
      ) {
        editor.update({ error: t(`cloudWorkersPage.snapshots.${key}Invalid`) });
        return;
      }
    }
    await editor.save({
      build: () => ({
        patch: {
          plugins: {
            entries: {
              crabbox: {
                config: {
                  warmImages: {
                    refreshAfter: current.refreshAfter,
                    retainUnused: current.retainUnused,
                    keepPrevious: Number(current.keepPrevious),
                  },
                },
              },
            },
          },
        },
      }),
      note: "cloud workers: update snapshot retention policy",
      failed: () => t("cloudWorkersPage.snapshots.policySaveFailed"),
      success: () => {
        resetDraft();
        return t("cloudWorkersPage.snapshots.policySaved");
      },
    });
  }
  return (
    <openclaw-cloud-worker-snapshot-policy
      style={{ display: "contents" }}
      class="cloud-environments__refresh"
    >
      <SettingsSection title={t("cloudWorkersPage.environments.retention")}>
        <For each={["refreshAfter", "retainUnused"] as const}>
          {(key) => (
            <SettingsRow
              title={t(`cloudWorkersPage.snapshots.${key}`)}
              control={
                <input
                  title={t(`cloudWorkersPage.snapshots.${key}Help`)}
                  class="settings-input"
                  aria-label={t(`cloudWorkersPage.snapshots.${key}`)}
                  value={values()[key]}
                  disabled={!canSave()}
                  onInput={(event) => edit({ [key]: event.currentTarget.value })}
                />
              }
            />
          )}
        </For>
        <SettingsSelectRow
          title={t("cloudWorkersPage.snapshots.keepPrevious")}
          value={values().keepPrevious}
          disabled={!canSave()}
          onChange={(value) => edit({ keepPrevious: value === "1" ? "1" : "0" })}
          options={[
            { value: "0", label: t("cloudWorkersPage.snapshots.keepNone") },
            { value: "1", label: t("cloudWorkersPage.snapshots.keepOne") },
          ]}
        />
        <SettingsRow
          title=""
          control={
            <button
              class="btn btn--sm"
              type="button"
              disabled={!canSave()}
              onClick={() => void save()}
            >
              {t("cloudWorkersPage.snapshots.savePolicy")}
            </button>
          }
        />
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
      </SettingsSection>
    </openclaw-cloud-worker-snapshot-policy>
  );
}
