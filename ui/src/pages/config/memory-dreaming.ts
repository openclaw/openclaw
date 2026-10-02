import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { renderModelPicker } from "../../components/model-picker.ts";
import { providerIdFromModelRef } from "../../components/provider-icon.ts";
import {
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";

registerSettingsEnglish();

/** Manifest bounds for a numeric field; `count` is `{integer, minimum}`, `ratio` is `0..1`. */
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
// (extensions/memory-core/openclaw.plugin.json). Everything here previously
// required hand-editing openclaw.json. `bounds` restates that manifest's
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

function readAtPath(root: Record<string, unknown> | null, path: readonly string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    value = asConfigRecord(value)?.[key];
  }
  return path.length ? value : undefined;
}

function hasAtPath(root: Record<string, unknown> | null, path: readonly string[]): boolean {
  let current: Record<string, unknown> | null = root;
  for (const [index, key] of path.entries()) {
    if (!current || !Object.hasOwn(current, key)) {
      return false;
    }
    if (index === path.length - 1) {
      return true;
    }
    current = asConfigRecord(current[key]);
  }
  return false;
}

function normalizeStorageMode(value: unknown): StorageMode {
  return STORAGE_MODES.find((mode) => mode === value) ?? DEFAULT_STORAGE_MODE;
}

function resolveDreamingModelDefault(dreaming: Record<string, unknown> | null): string {
  const model = readAtPath(dreaming, ["execution", "defaults", "model"]);
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
  const value = readAtPath(props.dreaming, spec.path);
  const overridden = hasAtPath(props.dreaming, spec.path);
  const defaultValue =
    spec.kind === "toggle"
      ? spec.fallback
        ? t("common.enabled")
        : t("common.disabled")
      : spec.kind === "number"
        ? String(spec.defaultValue)
        : spec.path[0] === "timezone"
          ? (props.timezoneDefault ?? t("memoryPage.dreaming.timezone.default"))
          : spec.path[0] === "model"
            ? resolveDreamingModelDefault(props.dreaming)
            : (spec.defaultValue ?? "");
  const defaultDescription = renderSettingsDefaultDescription(defaultValue, overridden);
  if (spec.kind === "toggle") {
    return renderSettingsToggleRow({
      title: t(spec.labelKey),
      description: html`${t(spec.helpKey)} ${defaultDescription}`,
      checked: typeof value === "boolean" ? value : spec.fallback,
      disabled: props.disabled,
      onChange: (checked) => props.onPatch(spec.path, checked),
    });
  }
  const text =
    spec.kind === "number"
      ? typeof value === "number"
        ? String(value)
        : ""
      : typeof value === "string"
        ? value
        : "";
  const bounds = spec.kind === "number" ? spec.bounds : null;
  if (spec.kind === "text" && spec.path[0] === "model") {
    const provider = providerIdFromModelRef(defaultValue);
    return renderSettingsRow({
      title: t(spec.labelKey),
      description: html`${t(spec.helpKey)} ${defaultDescription}`,
      control: renderModelPicker({
        label: t(spec.labelKey),
        value: text,
        options: [
          {
            value: "",
            label: defaultValue,
            ...(provider ? { provider } : {}),
          },
        ],
        disabled: props.disabled,
        custom: {
          label: t("cron.form.customModel"),
          placeholder: spec.placeholderKey ? t(spec.placeholderKey) : "",
          commit: "change",
        },
        onChange: (model) => props.onPatch(spec.path, model.trim() || undefined),
      }),
    });
  }
  return renderSettingsRow({
    title: t(spec.labelKey),
    description: html`${t(spec.helpKey)} ${defaultDescription}`,
    control: html`
      <input
        class="settings-input"
        type=${spec.kind === "number" ? "number" : "text"}
        min=${bounds ? String(bounds.min) : nothing}
        max=${bounds?.max !== undefined ? String(bounds.max) : nothing}
        step=${bounds ? (bounds.integer ? "1" : "any") : nothing}
        spellcheck="false"
        aria-label=${t(spec.labelKey)}
        ?disabled=${props.disabled}
        .value=${text}
        placeholder=${defaultValue}
        @change=${(event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const next = input.value.trim();
          if (!next) {
            props.onPatch(spec.path, undefined);
            return;
          }
          if (bounds) {
            const parsed = parseDreamingNumber(next, bounds);
            if (parsed === null) {
              // Autosave would write this straight into a config the gateway
              // rejects, leaving a failed save and no field to correct.
              input.value = text;
              return;
            }
            props.onPatch(spec.path, parsed);
            return;
          }
          props.onPatch(spec.path, next);
        }}
      />
    `,
  });
}

/** The global dreaming knobs, editable only when the slot owner stores them. */
export function renderDreamingSettings(props: DreamingSettingsProps): TemplateResult {
  const storageModeValue = readAtPath(props.dreaming, ["storage", "mode"]);
  const storageMode = normalizeStorageMode(storageModeValue);
  const storageDefaultDescription = renderSettingsDefaultDescription(
    t("memoryPage.dreaming.storage.modes.separate"),
    hasAtPath(props.dreaming, ["storage", "mode"]),
  );
  return html`
    ${renderSettingsSection(
      {
        title: t("memoryPage.dreaming.schedule.title"),
        description: t("memoryPage.dreaming.schedule.description"),
      },
      DREAMING_SCHEDULE_FIELDS.map((spec) => renderField(props, spec)),
    )}
    ${renderSettingsSection(
      {
        title: t("memoryPage.dreaming.storage.title"),
        description: t("memoryPage.dreaming.storage.description"),
      },
      html`
        ${renderSettingsRow({
          title: t("memoryPage.dreaming.storage.modeLabel"),
          description: html`
            ${t("memoryPage.dreaming.storage.modeHelp")} ${storageDefaultDescription}
          `,
          stacked: true,
          control: renderSettingsSegmented<StorageMode>({
            value: storageMode,
            options: STORAGE_MODES.map((mode) => ({
              value: mode,
              label: t(`memoryPage.dreaming.storage.modes.${mode}`),
            })),
            ariaLabel: t("memoryPage.dreaming.storage.modeLabel"),
            disabled: props.disabled,
            onChange: (mode) => props.onPatch(["storage", "mode"], mode),
          }),
        })}
        ${renderField(props, {
          kind: "toggle",
          path: ["storage", "separateReports"],
          labelKey: "memoryPage.dreaming.storage.separateReportsLabel",
          helpKey: "memoryPage.dreaming.storage.separateReportsHelp",
          // DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS
          fallback: false,
        })}
      `,
    )}
    ${Object.entries(DREAMING_PHASE_NUMBERS).map(([phase, fields]) =>
      renderSettingsSection(
        {
          title: t(`memoryPage.dreaming.phases.${phase}.title`),
          description: t(`memoryPage.dreaming.phases.${phase}.description`),
        },
        [
          renderField(props, {
            kind: "toggle",
            path: ["phases", phase, "enabled"],
            labelKey: "memoryPage.dreaming.phaseFields.enabled",
            helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
            fallback: true,
          }),
          ...fields.map(([key, bounds, defaultValue]) =>
            renderField(props, {
              kind: "number",
              path: ["phases", phase, key],
              labelKey: `memoryPage.dreaming.phaseFields.${key}`,
              helpKey: `memoryPage.dreaming.phaseFields.${key}Help`,
              bounds,
              defaultValue,
            }),
          ),
        ],
      ),
    )}
  `;
}

/**
 * Shown instead of the knobs when the slot-owning plugin's config schema has no
 * `dreaming` child: writing these fields would be rejected by the gateway, so
 * the page must not pretend they are editable.
 */
export function renderDreamingUnsupported(pluginId: string): TemplateResult {
  return renderSettingsSection(
    { title: t("memoryPage.dreaming.unsupported.title") },
    renderSettingsRow({
      title: t("memoryPage.dreaming.unsupported.rowTitle"),
      description: t("memoryPage.dreaming.unsupported.description", { plugin: pluginId }),
    }),
  );
}
