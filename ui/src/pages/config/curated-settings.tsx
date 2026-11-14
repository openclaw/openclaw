import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, onSettled, Switch, untrack } from "solid-js";
import { providerIdFromModelRef } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import {
  LearnMoreLink,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import {
  curatedSettingsConfigPath,
  type CuratedSettingsDefault,
  type CuratedSettingsDisclosure,
  type CuratedSettingsField,
  type CuratedSettingsPresentation,
} from "./curated-settings-presentation.ts";

registerEnglishCatalog(registerSettingsEnglish);
registerEnglishCatalog(registerCronEnglish);

type CuratedSettingsProps = {
  document: Record<string, unknown> | null;
  values: Record<string, unknown> | null;
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

function displayDefault(
  spec: CuratedSettingsDefault,
  settings: CuratedSettingsProps,
): string | number | boolean {
  if (typeof spec !== "object") {
    return spec;
  }
  const { value } = fieldAtPath(
    spec.scope === "document" ? settings.document : settings.values,
    spec.path,
  );
  return typeof value === "string" && value.trim() ? value.trim() : t(spec.fallbackKey);
}

/** Parses an edited number against its manifest bounds; null means "do not write". */
function parseCuratedNumber(
  raw: string,
  bounds: { integer: boolean; min: number; max?: number },
): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return null;
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    return null;
  }
  return bounds.max !== undefined && parsed > bounds.max ? null : parsed;
}

function CuratedField(props: {
  settings: CuratedSettingsProps;
  spec: CuratedSettingsField;
  /** A disclosure's switch speaks for the whole row instead of its own field. */
  row?: { titleKey: string; descriptionKey: string; actions: JSX.Element };
}) {
  const field = () => fieldAtPath(props.settings.values, props.spec.path);
  const fallbackValue = () => displayDefault(props.spec.displayDefault, props.settings);
  const defaultValue = () => {
    const value = fallbackValue();
    if (props.spec.kind === "segmented") {
      const option = props.spec.options.find((item) => item.value === value);
      return option ? t(option.labelKey) : String(value);
    }
    return typeof value === "boolean"
      ? t(value ? "common.enabled" : "common.disabled")
      : String(value);
  };
  const row = {
    title: <>{t(props.row?.titleKey ?? props.spec.labelKey)}</>,
    description: <>{t(props.row?.descriptionKey ?? props.spec.helpKey)}</>,
  };
  const checked = () => {
    const value = field().value;
    return typeof value === "boolean"
      ? value
      : props.spec.kind === "toggle" && props.spec.displayDefault;
  };
  const text = createMemo(() => {
    const value = field().value;
    return props.spec.kind === "number"
      ? typeof value === "number"
        ? String(value)
        : ""
      : typeof value === "string"
        ? value
        : "";
  });
  const bounds = () => (props.spec.kind === "number" ? props.spec.bounds : null);
  return (
    <Switch>
      <Match when={props.spec.kind === "toggle"}>
        <SettingsToggleRow
          {...row}
          checked={checked()}
          disabled={props.settings.disabled}
          actions={props.row?.actions}
          onChange={(enabled) => props.settings.onPatch(props.spec.path, enabled)}
        />
      </Match>
      <Match when={props.spec.kind === "model"}>
        <SettingsRow
          {...row}
          control={
            <ModelPicker
              label={t(props.spec.labelKey)}
              value={text()}
              disabled={props.settings.disabled}
              options={[
                {
                  value: "",
                  label: defaultValue(),
                  provider: providerIdFromModelRef(defaultValue()) ?? undefined,
                },
              ]}
              custom={{
                label: props.spec.kind === "model" ? t(props.spec.customLabelKey) : "",
                placeholder:
                  props.spec.kind === "model" && props.spec.placeholderKey
                    ? t(props.spec.placeholderKey)
                    : "",
                commit: "change",
              }}
              onChange={(model) =>
                props.settings.onPatch(props.spec.path, model.trim() || undefined)
              }
            />
          }
        />
      </Match>
      <Match when={props.spec.kind === "segmented"}>
        <SettingsRow
          {...row}
          stacked={true}
          control={
            <SettingsSegmented<string>
              value={
                props.spec.kind === "segmented" &&
                props.spec.options.some((option) => option.value === field().value)
                  ? String(field().value)
                  : String(fallbackValue())
              }
              options={
                props.spec.kind === "segmented"
                  ? props.spec.options.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey),
                    }))
                  : []
              }
              ariaLabel={t(props.spec.labelKey)}
              disabled={props.settings.disabled}
              onChange={(value) => props.settings.onPatch(props.spec.path, value)}
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
              ref={liveValue(text)}
              placeholder={defaultValue()}
              onChange={(event) => {
                const input = event.currentTarget;
                if (input.validity.badInput) {
                  // Browsers sanitize unfinished numbers to empty, not a deliberate clear.
                  input.value = text();
                  return;
                }
                const next = input.value.trim();
                if (!next) {
                  props.settings.onPatch(props.spec.path, undefined);
                  return;
                }
                const limits = bounds();
                if (limits) {
                  const parsed = parseCuratedNumber(next, limits);
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

function CuratedDisclosureRow(props: {
  settings: CuratedSettingsProps;
  spec: CuratedSettingsDisclosure;
}) {
  const [open, setOpen] = createSignal(false);
  const fields = () => props.spec.fields.slice(1);
  return (
    <>
      <CuratedField
        settings={props.settings}
        spec={props.spec.fields[0]!}
        row={{
          titleKey: props.spec.titleKey,
          descriptionKey: props.spec.descriptionKey,
          actions: (
            <button
              type="button"
              class="btn btn--icon btn--ghost curated-settings__disclosure"
              aria-expanded={open() ? "true" : "false"}
              aria-label={t(props.spec.titleKey)}
              onClick={() => setOpen((value) => !value)}
            >
              <Icon name="chevronRight" />
            </button>
          ),
        }}
      />
      {/* Stays mounted while closed so an unsaved draft survives closing the row. */}
      <div class="curated-settings__details" hidden={!open()}>
        <For each={fields()} keyed={(field) => field.path.join(".")}>
          {(field) => <CuratedField settings={props.settings} spec={field()} />}
        </For>
      </div>
    </>
  );
}

function CuratedSections(props: {
  intro: JSX.Element;
  presentation: CuratedSettingsPresentation;
  config: Record<string, unknown> | null;
  path: readonly string[];
  disabled: boolean;
  onPatch: (sectionPath: readonly string[], path: readonly string[], value: unknown) => void;
}) {
  // A retained handler belongs to this mounted config target, not a later owner.
  const initialSectionPath = untrack(() => props.path);
  let active = false;
  onSettled(() => {
    active = true;
    return () => {
      active = false;
    };
  });
  const settings: CuratedSettingsProps = {
    get document() {
      return props.config;
    },
    get values() {
      return asConfigRecord(fieldAtPath(props.config, initialSectionPath).value);
    },
    get disabled() {
      return props.disabled;
    },
    onPatch: (path, value) => {
      if (active && !props.disabled) {
        props.onPatch(initialSectionPath, path, value);
      }
    },
  };
  return (
    <For each={props.presentation.sections} keyed={(section) => section.titleKey}>
      {(section) => (
        <SettingsSection
          title={t(section().titleKey)}
          description={
            section() === props.presentation.sections[0]
              ? props.intro
              : section().descriptionKey
                ? t(section().descriptionKey!)
                : undefined
          }
        >
          <For each={section().fields ?? []} keyed={(field) => field.path.join(".")}>
            {(field) => <CuratedField settings={settings} spec={field()} />}
          </For>
          <For each={section().disclosures ?? []} keyed={(spec) => spec.titleKey}>
            {(spec) => <CuratedDisclosureRow settings={settings} spec={spec()} />}
          </For>
        </SettingsSection>
      )}
    </For>
  );
}

/** A plugin-owned host-placement template; config ownership remains with the host. */
export function CuratedSettingsPanel(props: {
  presentation: CuratedSettingsPresentation;
  config: Record<string, unknown> | null;
  parameters: Readonly<Record<string, string>>;
  messageParameters: Readonly<Record<string, string>>;
  support: "supported" | "unsupported" | "unknown";
  disabled: boolean;
  onPatch: (sectionPath: readonly string[], path: readonly string[], value: unknown) => void;
}) {
  const path = () => curatedSettingsConfigPath(props.presentation, props.parameters);
  const intro = (
    <>
      {t(props.presentation.intro.messageKey, props.messageParameters)}{" "}
      <LearnMoreLink url={props.presentation.intro.url} />
    </>
  );
  return (
    <>
      {props.support === "unsupported" ? (
        <SettingsSection title={t(props.presentation.unsupported.titleKey)} description={intro}>
          <SettingsRow
            title={t(props.presentation.unsupported.rowTitleKey)}
            description={t(props.presentation.unsupported.descriptionKey, props.messageParameters)}
          />
        </SettingsSection>
      ) : (
        <For each={[path()]} keyed={(item) => item.join("\0")}>
          {(item) => (
            <CuratedSections
              intro={intro}
              presentation={props.presentation}
              config={props.config}
              path={item()}
              disabled={props.disabled}
              onPatch={props.onPatch}
            />
          )}
        </For>
      )}
    </>
  );
}
