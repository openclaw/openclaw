import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, createStore, For, Show } from "solid-js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { parseDurationMs } from "../../../../src/cli/parse-duration.js";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { isReadyPreparation } from "./cloud-worker-environment-model.ts";
import {
  buildCloudWorkerPreparedPoolPatch,
  readCloudWorkerPreparedPool,
} from "./cloud-worker-repositories-config.ts";
import { useCloudWorkerConfig } from "./use-cloud-worker-config.ts";

registerEnglishCatalog(registerSettingsEnglish);

type TextSetting = "maxTotal" | "refreshAfter" | "retainUnused";
type Setting = TextSetting | "keepPrevious";
const TEXT_SETTINGS: readonly TextSetting[] = ["maxTotal", "refreshAfter", "retainUnused"];
const MINIMUM_MS = { refreshAfter: 3_600_000, retainUnused: 86_400_000 } as const;

function warmImagesPatch(values: Record<string, string | number>) {
  return { plugins: { entries: { crabbox: { config: { warmImages: values } } } } };
}

function validDuration(key: keyof typeof MINIMUM_MS, value: string) {
  return (
    /^[1-9][0-9]{0,7}(m|h|d)(?![\s\S])/.test(value) && parseDurationMs(value) >= MINIMUM_MS[key]
  );
}

/** Reserve capacity and snapshot retention. Each field saves itself when committed. */
export function CloudWorkerPoolSettings(props: { inventory: EnvironmentsListResult | null }) {
  const [view, setView] = createStore<{
    drafts: Partial<Record<TextSetting, string>>;
    errors: Partial<Record<Setting, string>>;
  }>({ drafts: {}, errors: {} });
  const resetDrafts = () => {
    setView((state) => {
      state.drafts = {};
      state.errors = {};
    });
  };
  const inFlight = new Map<TextSetting, string>();
  const editor = useCloudWorkerConfig(resetDrafts, () => {
    inFlight.clear();
    for (const key of TEXT_SETTINGS) {
      void commit(key);
    }
  });
  void editor.ensureLoaded();
  const ready = () => props.inventory?.environments.filter(isReadyPreparation).length ?? 0;
  const saved = createMemo(() => {
    let value: unknown = editor.config();
    for (const key of ["plugins", "entries", "crabbox", "config", "warmImages"]) {
      value = isRecord(value) ? value[key] : undefined;
    }
    const configured = isRecord(value) ? value : {};
    return {
      maxTotal: readCloudWorkerPreparedPool(editor.config()),
      refreshAfter: typeof configured.refreshAfter === "string" ? configured.refreshAfter : "24h",
      retainUnused: typeof configured.retainUnused === "string" ? configured.retainUnused : "14d",
      keepPrevious: configured.keepPrevious === 1 ? "1" : "0",
    };
  });
  const value = (key: TextSetting) => view.drafts[key] ?? saved()[key];
  function edit(key: TextSetting, next: string) {
    setView((state) => {
      state.drafts[key] = next;
      delete state.errors[key];
    });
  }
  function fail(key: Setting, message: string) {
    setView((state) => {
      state.errors[key] = message;
    });
  }
  async function write(
    key: Setting,
    build: Parameters<typeof editor.save>[0]["build"],
    note: string,
    failed: () => string,
  ) {
    const draft = key === "keepPrevious" ? undefined : view.drafts[key];
    const accepted = await editor.save({ build, note, failed });
    if (accepted) {
      setView((state) => {
        delete state.errors[key];
        if (key !== "keepPrevious" && state.drafts[key] === draft) {
          delete state.drafts[key];
        }
      });
      return;
    }
    // A retired write has no error: its draft stays and is sent again after reconnect.
    const error = editor.state().error;
    if (error) {
      fail(key, error);
    }
  }
  async function commit(key: TextSetting) {
    const next = view.drafts[key];
    if (next === undefined || inFlight.get(key) === next) {
      return;
    }
    if (next === saved()[key]) {
      setView((state) => {
        delete state.drafts[key];
        delete state.errors[key];
      });
      return;
    }
    if (key === "maxTotal") {
      const pool = buildCloudWorkerPreparedPoolPatch(next);
      if ("error" in pool) {
        fail(key, t(`cloudWorkersPage.errors.${pool.error}`));
        return;
      }
      inFlight.set(key, next);
      await write(
        key,
        () => pool,
        "cloud environments: update pool cap",
        () => t("cloudWorkersPage.errors.settingsSaveFailed"),
      );
      inFlight.delete(key);
      return;
    }
    if (!validDuration(key, next)) {
      fail(key, t(`cloudWorkersPage.snapshots.${key}Invalid`));
      return;
    }
    inFlight.set(key, next);
    await write(
      key,
      () => ({ patch: warmImagesPatch({ [key]: next }) }),
      "cloud workers: update snapshot retention policy",
      () => t("cloudWorkersPage.snapshots.policySaveFailed"),
    );
    inFlight.delete(key);
  }
  function description(key: Setting, help?: JSX.Element) {
    const error = view.errors[key];
    if (error) {
      return (
        <span class="cloud-environments__error" role="alert">
          {error}
        </span>
      );
    }
    return editor.readOnly() ? undefined : help;
  }
  function textControl(key: TextSetting, label: string, placeholder?: string) {
    return (
      <Show
        when={!editor.readOnly()}
        fallback={<SettingsValue value={saved()[key] || placeholder} />}
      >
        <input
          class="settings-input"
          type={key === "maxTotal" ? "number" : "text"}
          min={key === "maxTotal" ? "0" : undefined}
          step={key === "maxTotal" ? "1" : undefined}
          aria-label={label}
          aria-invalid={view.errors[key] ? "true" : undefined}
          placeholder={placeholder}
          autocomplete="off"
          spellcheck="false"
          value={value(key)}
          disabled={!editor.writable()}
          onInput={(event) => edit(key, event.currentTarget.value)}
          onChange={() => void commit(key)}
          // Leaving a field that failed to save tries it again.
          onBlur={() => void commit(key)}
        />
      </Show>
    );
  }
  const keepOptions = () => [
    { value: "0", label: t("cloudWorkersPage.snapshots.keepNone") },
    { value: "1", label: t("cloudWorkersPage.snapshots.keepOne") },
  ];
  return (
    <openclaw-cloud-worker-snapshot-policy
      style={{ display: "contents" }}
      class="cloud-environments__refresh"
    >
      <SettingsSection title={t("cloudWorkersPage.environments.settings")}>
        <SettingsRow
          title={t("cloudWorkersPage.environments.poolCap")}
          description={description("maxTotal", t("cloudWorkersPage.preparedPoolHelp"))}
          control={
            <>
              <Show when={ready() > 0}>
                <SettingsStatus
                  kind="ok"
                  label={t("cloudWorkersPage.environments.pool", { count: String(ready()) })}
                />
              </Show>
              {textControl(
                "maxTotal",
                t("cloudWorkersPage.environments.poolCap"),
                String(props.inventory?.preparedPool?.maxTotal ?? 4),
              )}
            </>
          }
        />
        <For each={["refreshAfter", "retainUnused"] as const}>
          {(key) => (
            <SettingsRow
              title={t(`cloudWorkersPage.snapshots.${key}`)}
              description={description(key, t(`cloudWorkersPage.snapshots.${key}Help`))}
              control={textControl(key, t(`cloudWorkersPage.snapshots.${key}`))}
            />
          )}
        </For>
        <SettingsRow
          title={t("cloudWorkersPage.snapshots.keepPrevious")}
          description={description("keepPrevious")}
          control={
            <Show
              when={!editor.readOnly()}
              fallback={
                <SettingsValue
                  value={
                    keepOptions().find((option) => option.value === saved().keepPrevious)?.label
                  }
                />
              }
            >
              <SettingsSelect
                aria-label={t("cloudWorkersPage.snapshots.keepPrevious")}
                value={saved().keepPrevious}
                disabled={!editor.writable()}
                options={keepOptions()}
                onChange={(event) => {
                  const keepPrevious = event.currentTarget.value === "1" ? 1 : 0;
                  void write(
                    "keepPrevious",
                    () => ({ patch: warmImagesPatch({ keepPrevious }) }),
                    "cloud workers: update snapshot retention policy",
                    () => t("cloudWorkersPage.snapshots.policySaveFailed"),
                  );
                }}
              />
            </Show>
          }
        />
      </SettingsSection>
    </openclaw-cloud-worker-snapshot-policy>
  );
}
