import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, Switch } from "solid-js";
import { renderProviderBrandIcon, providerIdFromModelRef } from "../../components/provider-icon.ts";
import "../../components/select-picker.ts";
import type { PickerParams } from "../../components/select-picker.ts";
import {
  LearnMoreLink,
  SettingsDefaultDescription,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import {
  resolveConfiguredDreaming,
  type DreamingConfigPathSupport,
} from "../agents/memory/dreaming.ts";
import { resolveDreamingTimezoneDefault } from "./memory-defaults.ts";

registerEnglishCatalog(registerSettingsEnglish);

type DreamingNumberBounds = { integer: boolean; min: number; max?: number };

const COUNT_FROM_ZERO: DreamingNumberBounds = { integer: true, min: 0 };
const COUNT_FROM_ONE: DreamingNumberBounds = { integer: true, min: 1 };
const RATIO: DreamingNumberBounds = { integer: false, min: 0, max: 1 };

type DreamingFieldSpec = {
  path: readonly string[];
  labelKey: string;
  helpKey: string;
} & (
  | {
      kind: "text";
      placeholderKey?: string;
      defaultValue?: string;
    }
  | {
      kind: "number";
      bounds: DreamingNumberBounds;
      defaultValue: number;
    }
  | {
      kind: "toggle";
      /** Runtime value for an absent key; see resolveMemoryDreamingConfig. */
      fallback: boolean;
    }
);

// Mirrors the memory-core manifest configSchema/uiHints
// (extensions/memory-core/openclaw.plugin.json). `bounds` restates that manifest's
// integer/minimum/maximum constraints so a rejected value is caught at the input
// instead of after autosave hands it to the gateway.
//
// Toggle `fallback` and the storage-mode default below restate
// resolveMemoryDreamingConfig in src/memory-host-sdk/dreaming.ts: an absent
// key is not "off", so rendering `false` would report the opposite of what the
// sweep actually does. Keep the two in sync.
const DREAMING_SCHEDULE_FIELDS: readonly DreamingFieldSpec[] = [
  ...["frequency", "timezone", "model"].map((key): DreamingFieldSpec => ({
    kind: "text",
    path: [key],
    labelKey: `memoryPage.dreaming.${key}.label`,
    helpKey: `memoryPage.dreaming.${key}.help`,
    placeholderKey: `memoryPage.dreaming.${key}.placeholder`,
    defaultValue: key === "frequency" ? "0 3 * * *" : undefined,
  })),
  {
    kind: "toggle",
    path: ["verboseLogging"],
    labelKey: "memoryPage.dreaming.verboseLogging.label",
    helpKey: "memoryPage.dreaming.verboseLogging.help",
    // DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING
    fallback: false,
  },
];

const DREAMING_PHASE_NUMBERS: Record<
  string,
  readonly [key: string, bounds: DreamingNumberBounds, defaultValue: number][]
> = {
  light: [
    ["lookbackDays", COUNT_FROM_ZERO, 2],
    ["limit", COUNT_FROM_ZERO, 100],
    ["dedupeSimilarity", RATIO, 0.9],
  ],
  deep: [
    ["limit", COUNT_FROM_ZERO, 10],
    ["minScore", RATIO, 0.75],
    ["minRecallCount", COUNT_FROM_ZERO, 3],
    ["minUniqueQueries", COUNT_FROM_ZERO, 3],
    ["recencyHalfLifeDays", COUNT_FROM_ZERO, 14],
    ["maxAgeDays", COUNT_FROM_ONE, 30],
    ["maxPromotedSnippetTokens", COUNT_FROM_ONE, 160],
  ],
  rem: [
    ["lookbackDays", COUNT_FROM_ZERO, 7],
    ["limit", COUNT_FROM_ZERO, 10],
    ["minPatternStrength", RATIO, 0.75],
  ],
};

const STORAGE_MODES = ["inline", "separate", "both"] as const;
type StorageMode = (typeof STORAGE_MODES)[number];

// DEFAULT_MEMORY_DREAMING_STORAGE_MODE in src/memory-host-sdk/dreaming.ts.
const DEFAULT_STORAGE_MODE: StorageMode = "separate";

type DreamingSettingsProps = {
  /** `plugins.entries.<slot owner>.config.dreaming`, or null when unset. */
  dreaming: Record<string, unknown> | null;
  /** agents.defaults.userTimezone, which the runtime inherits when present. */
  timezoneDefault: string | null;
  disabled: boolean;
  onPatch: (path: readonly string[], value: unknown) => void;
};

function fieldAtPath(root: Record<string, unknown> | null, path: readonly string[]) {
  let value: unknown = root;
  let overridden = path.length > 0;
  for (const key of path) {
    const current = asConfigRecord(value);
    overridden &&= current !== null && Object.hasOwn(current, key);
    value = current?.[key];
  }
  return { value: path.length ? value : undefined, overridden };
}

function normalizeStorageMode(value: unknown): StorageMode {
  return STORAGE_MODES.find((mode) => mode === value) ?? DEFAULT_STORAGE_MODE;
}

function resolveDreamingModelDefault(dreaming: Record<string, unknown> | null): string {
  const { value: model } = fieldAtPath(dreaming, ["execution", "defaults", "model"]);
  return typeof model === "string" && model.trim()
    ? model.trim()
    : t("memoryPage.dreaming.model.default");
}

/** Parses an edited number against its manifest bounds; null means "do not write". */
function parseDreamingNumber(raw: string, bounds: DreamingNumberBounds): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return null;
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    return null;
  }
  return bounds.max !== undefined && parsed > bounds.max ? null : parsed;
}

function renderField(props: DreamingSettingsProps, spec: DreamingFieldSpec) {
  return <DreamingField settings={props} spec={spec} />;
}

function DreamingField(props: { settings: DreamingSettingsProps; spec: DreamingFieldSpec }) {
  const field = () => fieldAtPath(props.settings.dreaming, props.spec.path);
  const defaultValue = () => {
    const spec = props.spec;
    return spec.kind === "toggle"
      ? spec.fallback
        ? t("common.enabled")
        : t("common.disabled")
      : spec.kind === "number"
        ? String(spec.defaultValue)
        : spec.path[0] === "timezone"
          ? (props.settings.timezoneDefault ?? t("memoryPage.dreaming.timezone.default"))
          : spec.path[0] === "model"
            ? resolveDreamingModelDefault(props.settings.dreaming)
            : (spec.defaultValue ?? "");
  };
  const description = (
    <>
      {t(props.spec.helpKey)}{" "}
      <SettingsDefaultDescription value={defaultValue()} overridden={field().overridden} />
    </>
  );
  const row = {
    title: <>{t(props.spec.labelKey)}</>,
    description,
  };
  const checked = () => {
    const value = field().value;
    return typeof value === "boolean" ? value : props.spec.kind === "toggle" && props.spec.fallback;
  };
  const text = () => {
    const value = field().value;
    return props.spec.kind === "number"
      ? typeof value === "number"
        ? String(value)
        : ""
      : typeof value === "string"
        ? value
        : "";
  };
  const bounds = () => (props.spec.kind === "number" ? props.spec.bounds : null);
  return (
    <Switch>
      <Match when={props.spec.kind === "toggle"}>
        <SettingsToggleRow
          {...row}
          checked={checked()}
          disabled={props.settings.disabled}
          onChange={(enabled) => props.settings.onPatch(props.spec.path, enabled)}
        />
      </Match>
      <Match when={props.spec.kind === "text" && props.spec.path[0] === "model"}>
        <SettingsRow
          {...row}
          control={
            <DreamingModelPicker
              value={text()}
              defaultValue={defaultValue()}
              disabled={props.settings.disabled}
              placeholder={
                props.spec.kind === "text" && props.spec.placeholderKey
                  ? t(props.spec.placeholderKey)
                  : ""
              }
              onChange={(model) =>
                props.settings.onPatch(props.spec.path, model.trim() || undefined)
              }
            />
          }
        />
      </Match>
      <Match when={true}>
        <SettingsRow
          {...row}
          control={
            <input
              class="settings-input"
              type={props.spec.kind === "number" ? "number" : "text"}
              min={bounds()?.min.toString()}
              max={bounds()?.max?.toString()}
              step={bounds()?.integer ? "1" : bounds() ? "any" : undefined}
              spellcheck="false"
              aria-label={t(props.spec.labelKey)}
              disabled={props.settings.disabled}
              value={text()}
              placeholder={defaultValue()}
              onChange={(event) => {
                const input = event.currentTarget;
                const next = input.value.trim();
                if (!next) {
                  props.settings.onPatch(props.spec.path, undefined);
                  return;
                }
                const limits = bounds();
                if (limits) {
                  const parsed = parseDreamingNumber(next, limits);
                  if (parsed === null) {
                    // Invalid edits never reach autosave; restore the admitted value.
                    input.value = text();
                    return;
                  }
                  props.settings.onPatch(props.spec.path, parsed);
                  return;
                }
                props.settings.onPatch(props.spec.path, next);
              }}
            />
          }
        />
      </Match>
    </Switch>
  );
}

type DreamingModelOption = { value: string; label: string; provider?: string };
type DreamingModelPickerProps = {
  value: string;
  defaultValue: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
};

function DreamingModelPicker(props: DreamingModelPickerProps) {
  let input!: HTMLInputElement;
  const customValue = () =>
    props.value === "__openclaw_custom_model__"
      ? "__openclaw_custom_model___"
      : "__openclaw_custom_model__";
  const params = (): PickerParams<DreamingModelOption> => ({
    label: t("memoryPage.dreaming.model.label"),
    value: props.value,
    options: [
      {
        value: "",
        label: props.defaultValue,
        provider: providerIdFromModelRef(props.defaultValue) ?? undefined,
      },
      { value: customValue(), label: t("cron.form.customModel") },
    ],
    get disabled() {
      return props.disabled;
    },
    searchable: true,
    showOptionTooltips: false,
    className: "model-picker__select ",
    // The retained picker owns and renders its Lit option adornments.
    renderLeading: (option) =>
      option.provider
        ? renderProviderBrandIcon(option.provider, { className: "model-picker__provider-icon" })
        : undefined,
    onChange: props.onChange,
    onChangeTarget: (value) => {
      if (value === customValue()) {
        input.hidden = false;
        queueMicrotask(() => input.focus());
        return;
      }
      input.hidden = true;
      props.onChange(value);
    },
  });
  return (
    <div class="model-picker">
      <openclaw-select-picker
        class="settings-select picker-select model-picker__select "
        style={{ width: "100%", "min-width": "min(138px,100%)" }}
        prop:params={params()}
      />
      <input
        ref={(element) => {
          input = element;
        }}
        class="settings-input model-picker__custom"
        aria-label={t("cron.form.customModel")}
        aria-invalid="false"
        placeholder={props.placeholder}
        value={props.value}
        hidden={!props.value || props.value === customValue()}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </div>
  );
}

/** The global dreaming knobs, editable only when the slot owner stores them. */
export function DreamingSettings(props: DreamingSettingsProps): JSX.Element {
  const storage = () => fieldAtPath(props.dreaming, ["storage", "mode"]);
  const storageMode = () => normalizeStorageMode(storage().value);
  const storageDefaultDescription = (
    <SettingsDefaultDescription
      value={t("memoryPage.dreaming.storage.modes.separate")}
      overridden={storage().overridden}
    />
  );
  return (
    <>
      <SettingsSection
        title={t("memoryPage.dreaming.schedule.title")}
        description={t("memoryPage.dreaming.schedule.description")}
      >
        <For each={DREAMING_SCHEDULE_FIELDS} keyed={(spec) => spec.path.join(".")}>
          {(spec) => <DreamingField settings={props} spec={spec()} />}
        </For>
      </SettingsSection>
      <SettingsSection
        title={t("memoryPage.dreaming.storage.title")}
        description={t("memoryPage.dreaming.storage.description")}
      >
        <>
          <SettingsRow
            title={t("memoryPage.dreaming.storage.modeLabel")}
            description={
              <>
                {t("memoryPage.dreaming.storage.modeHelp")} {storageDefaultDescription}
              </>
            }
            stacked={true}
            control={
              <SettingsSegmented<StorageMode>
                value={storageMode()}
                options={STORAGE_MODES.map((mode) => ({
                  value: mode,
                  label: t(`memoryPage.dreaming.storage.modes.${mode}`),
                }))}
                ariaLabel={t("memoryPage.dreaming.storage.modeLabel")}
                disabled={props.disabled}
                onChange={(mode) => props.onPatch(["storage", "mode"], mode)}
              />
            }
          />
          {renderField(props, {
            kind: "toggle",
            path: ["storage", "separateReports"],
            labelKey: "memoryPage.dreaming.storage.separateReportsLabel",
            helpKey: "memoryPage.dreaming.storage.separateReportsHelp",
            // DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS
            fallback: false,
          })}
        </>
      </SettingsSection>
      <For each={Object.entries(DREAMING_PHASE_NUMBERS)} keyed={(entry) => entry[0]}>
        {(phaseEntry) => (
          <SettingsSection
            title={t(`memoryPage.dreaming.phases.${phaseEntry()[0]}.title`)}
            description={t(`memoryPage.dreaming.phases.${phaseEntry()[0]}.description`)}
          >
            <DreamingField
              settings={props}
              spec={{
                kind: "toggle",
                path: ["phases", phaseEntry()[0], "enabled"],
                labelKey: "memoryPage.dreaming.phaseFields.enabled",
                helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
                fallback: true,
              }}
            />
            <For each={phaseEntry()[1]} keyed={(field) => field[0]}>
              {(field) => (
                <DreamingField
                  settings={props}
                  spec={{
                    kind: "number",
                    path: ["phases", phaseEntry()[0], field()[0]],
                    labelKey: `memoryPage.dreaming.phaseFields.${field()[0]}`,
                    helpKey: `memoryPage.dreaming.phaseFields.${field()[0]}Help`,
                    bounds: field()[1],
                    defaultValue: field()[2],
                  }}
                />
              )}
            </For>
          </SettingsSection>
        )}
      </For>
    </>
  );
}

/**
 * Shown instead of the knobs when the slot-owning plugin's config schema has no
 * `dreaming` child: writing these fields would be rejected by the gateway, so
 * the page must not pretend they are editable.
 */
export function renderDreamingUnsupported(pluginId: string): JSX.Element {
  return (
    <SettingsSection title={t("memoryPage.dreaming.unsupported.title")}>
      <SettingsRow
        title={t("memoryPage.dreaming.unsupported.rowTitle")}
        description={t("memoryPage.dreaming.unsupported.description", { plugin: pluginId })}
      />
    </SettingsSection>
  );
}

export function renderDreamingSettings(props: DreamingSettingsProps): JSX.Element {
  return <DreamingSettings {...props} />;
}

export function MemoryDreamingControls(props: {
  config: Record<string, unknown> | null;
  support: DreamingConfigPathSupport;
  disabled: boolean;
  onPatch: (path: readonly string[], value: unknown) => void;
}) {
  const configured = createMemo(() => {
    const { pluginId } = resolveConfiguredDreaming(props.config);
    const plugins = asConfigRecord(props.config?.plugins);
    const entry = asConfigRecord(asConfigRecord(plugins?.entries)?.[pluginId]);
    return { pluginId, dreaming: asConfigRecord(asConfigRecord(entry?.config)?.dreaming) };
  });
  return (
    <>
      <p class="settings-page__intro">
        {t("memoryPage.dreaming.intro", { plugin: configured().pluginId })}{" "}
        <LearnMoreLink url="https://docs.openclaw.ai/concepts/dreaming" />
      </p>
      {props.support === "unsupported" ? (
        renderDreamingUnsupported(configured().pluginId)
      ) : (
        <DreamingSettings
          dreaming={configured().dreaming}
          timezoneDefault={resolveDreamingTimezoneDefault(props.config)}
          disabled={props.disabled}
          onPatch={props.onPatch}
        />
      )}
    </>
  );
}
