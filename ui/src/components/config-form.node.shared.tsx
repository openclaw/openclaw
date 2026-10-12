import type { JSX } from "@solidjs/web";
import { createEffect, createMemo } from "solid-js";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { getLocale, registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import "../components/tooltip.ts";
import { configValuesEqual, isSupportedConfigValueValid } from "./config-form.constraints.ts";
import {
  configEnumOptionLabel,
  formatConfigValueText,
  type SensitiveRenderState,
} from "./config-form.node.shared.ts";
import { setControlValidity } from "./config-form.scalar-edit.ts";
import { configFieldId, type JsonSchema } from "./config-form.shared.ts";
import { Icon } from "./solid/icon.tsx";
import { SettingsDefaultDescription, SettingsSegmented } from "./solid/settings-ui.tsx";

export * from "./config-form.node.shared.ts";

registerEnglishCatalog(registerSettingsEnglish);

const jsonTextareaState = new WeakMap<
  HTMLTextAreaElement,
  { sourceValue: unknown; fallback: string; pathKey: string }
>();

export function SensitiveToggleButton(props: {
  path: Array<string | number>;
  state: SensitiveRenderState;
  disabled: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
}): JSX.Element {
  const label = createMemo(() =>
    props.state.canReveal
      ? props.state.isRevealed
        ? t("configForm.hideValue")
        : t("configForm.revealValue")
      : props.state.sentinelRedacted
        ? t("configForm.storedSecretNotRevealable")
        : t("configForm.disableStreamToReveal"),
  );
  return (
    <>
      {props.state.isSensitive && props.onToggleSensitivePath && (
        <openclaw-tooltip prop:content={label()}>
          <button
            type="button"
            class="settings-secret__toggle"
            aria-label={label()}
            aria-pressed={props.state.isRevealed ? "true" : "false"}
            disabled={props.disabled || !props.state.canReveal}
            onClick={() => props.onToggleSensitivePath?.(props.path)}
          >
            <Icon name={props.state.isRevealed ? "eye" : "eyeOff"} />
          </button>
        </openclaw-tooltip>
      )}
    </>
  );
}

export function FieldRow(props: {
  label: JSX.Element;
  help?: JSX.Element;
  helpId?: string;
  defaultDescription?: JSX.Element;
  showLabel: boolean;
  control: JSX.Element;
  stacked?: boolean;
  error?: JSX.Element;
  errorId?: string;
}): JSX.Element {
  // Collection item metadata belongs to the parent row, so unlabeled item rows
  // do not repeat its help or effective default.
  const help = createMemo(() => (props.showLabel ? props.help : undefined));
  const defaultDescription = createMemo(() =>
    props.showLabel ? props.defaultDescription : undefined,
  );
  const hasText = createMemo(
    () =>
      props.showLabel || Boolean(help()) || Boolean(defaultDescription()) || Boolean(props.error),
  );
  return (
    <div
      class={props.stacked || !hasText() ? "settings-row settings-row--stacked" : "settings-row"}
    >
      {hasText() && (
        <div class="settings-row__text">
          {props.showLabel && <span class="settings-row__title">{props.label}</span>}
          {help() && (
            <span class="settings-row__desc" id={props.helpId}>
              {help()}
            </span>
          )}
          {defaultDescription() && (
            <>
              {" "}
              <span class="settings-row__desc">{defaultDescription()}</span>
            </>
          )}
          {props.error && (
            <span class="cfg-field__error" role="alert">
              {props.error}
            </span>
          )}
        </div>
      )}
      {props.control != null && (
        <div class="settings-row__control">
          {props.control}
          {props.errorId && (
            <span
              id={props.errorId}
              class="cfg-field__error settings-control__sr-label"
              role="alert"
              hidden
            />
          )}
        </div>
      )}
    </div>
  );
}

export function CollectionRemoveButton(props: {
  label: string;
  disabled: boolean;
  remove: () => boolean;
}): JSX.Element {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        type="button"
        class="btn btn--icon"
        style={{ width: "28px", height: "28px", padding: "0" }}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={(event) => removeCollectionRow(event, props.remove)}
      >
        <Icon name="trash" />
      </button>
    </openclaw-tooltip>
  );
}

/** Keep keyboard focus in the collection when its focused Remove button retires. */
function removeCollectionRow(event: Event, remove: () => boolean) {
  const control = event.currentTarget;
  if (!(control instanceof HTMLButtonElement) || control !== document.activeElement) {
    remove();
    return;
  }
  const collection = control.closest(".cfg-array, .cfg-map");
  const own = (selector: string) =>
    Array.from(collection?.querySelectorAll<HTMLButtonElement>(selector) ?? []).filter(
      (button) => button.closest(".cfg-array, .cfg-map") === collection,
    );
  const label = control.getAttribute("aria-label");
  const rows = own("button").filter((button) => button.getAttribute("aria-label") === label);
  const index = rows.indexOf(control);
  const destinations = [rows[index + 1], rows[index - 1], own("button[aria-controls]")[0]];
  if (!remove()) {
    return;
  }
  queueMicrotask(() => {
    if (document.activeElement === document.body) {
      destinations.find((button) => button?.isConnected && !button.disabled)?.focus();
    }
  });
}

export function renderSchemaDefaultDescription(schema: JsonSchema, value: unknown): JSX.Element {
  return schema.default !== undefined && value !== undefined ? (
    <SettingsDefaultDescription value={formatConfigValueText(schema.default)} overridden />
  ) : undefined;
}

export function SegmentedControl(props: {
  options: unknown[];
  resolvedValue: unknown;
  disabled: boolean;
  ariaLabel: string;
  descriptionId?: string;
  onSelect: (value: unknown) => boolean | void;
}): JSX.Element {
  const selectedIndex = createMemo(() =>
    props.options.findIndex((option) => configValuesEqual(option, props.resolvedValue)),
  );
  const options = createMemo(() => {
    getLocale();
    return props.options.map((option, index) => ({
      value: String(index),
      label: configEnumOptionLabel(option, props.options),
    }));
  });
  return (
    <SettingsSegmented
      value={selectedIndex() < 0 ? "" : String(selectedIndex())}
      options={options()}
      disabled={props.disabled}
      ariaLabel={props.ariaLabel}
      descriptionId={props.descriptionId}
      onChange={(index: string) => {
        const option = props.options[Number(index)];
        if (option !== undefined) {
          return props.onSelect(option);
        }
      }}
    />
  );
}

export function JsonTextareaControl(props: {
  schema: JsonSchema;
  path: Array<string | number>;
  ariaLabel: string;
  descriptionId?: string;
  sourceValue: unknown;
  fallback: string;
  rows: number;
  sensitiveState: SensitiveRenderState;
  disabled: boolean;
  isRequired?: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
}): JSX.Element {
  let textarea!: HTMLTextAreaElement;
  const errorId = createMemo(() => configFieldId(props.path, "json-error"));
  const renderedFallback = createMemo(() =>
    props.sensitiveState.isRedacted ? "" : props.fallback,
  );
  const setValidity = (target: HTMLTextAreaElement, message: string) =>
    setControlValidity(target, message, ".cfg-json-editor");
  const updateValidity = (target: HTMLTextAreaElement) => {
    let message = "";
    const raw = target.value.trim();
    if (!raw && props.isRequired) {
      message = t("configForm.invalidJson");
    } else if (raw) {
      try {
        if (!isSupportedConfigValueValid(props.schema, JSON.parse(raw))) {
          message = t("configForm.invalidJson");
        }
      } catch {
        message = t("configForm.invalidJson");
      }
    }
    setValidity(target, message);
    return !message;
  };
  createEffect(
    () => ({
      sourceValue: props.sourceValue,
      fallback: renderedFallback(),
      pathKey: JSON.stringify(props.path.filter((segment) => typeof segment === "string")),
    }),
    (current) => {
      const previous = jsonTextareaState.get(textarea);
      // Equal autosave acknowledgments must not erase invalid JSON still being edited.
      if (
        !previous ||
        (!Object.is(previous.sourceValue, current.sourceValue) &&
          !configValuesEqual(previous.sourceValue, current.sourceValue)) ||
        previous.fallback !== current.fallback ||
        previous.pathKey !== current.pathKey
      ) {
        textarea.value = current.fallback;
        setValidity(textarea, "");
      }
      jsonTextareaState.set(textarea, current);
    },
  );
  const commitJsonValue = (target: HTMLTextAreaElement, candidate: unknown) => {
    if (props.onPatch(props.path, candidate) !== false) {
      return true;
    }
    target.value = renderedFallback();
    updateValidity(target);
    return false;
  };
  const control = (
    <textarea
      ref={(element) => {
        textarea = element;
      }}
      class={["settings-input", { "cfg-redacted": props.sensitiveState.isRedacted }]}
      aria-label={props.ariaLabel}
      aria-describedby={[props.descriptionId, errorId()].filter(Boolean).join(" ") || undefined}
      aria-invalid="false"
      placeholder={
        props.sensitiveState.isRedacted
          ? t("configForm.redactedPlaceholder")
          : t("configForm.jsonValue")
      }
      rows={props.rows}
      disabled={props.disabled}
      readonly={props.sensitiveState.isRedacted}
      onClick={() => {
        if (props.sensitiveState.isRedacted) {
          props.onToggleSensitivePath?.(props.path);
        }
      }}
      onInput={(event) => {
        if (!props.sensitiveState.isRedacted) {
          updateValidity(event.currentTarget);
        }
      }}
      onChange={(event) => {
        if (props.sensitiveState.isRedacted || !updateValidity(event.currentTarget)) {
          return;
        }
        const target = event.currentTarget;
        const raw = target.value.trim();
        if (!raw) {
          commitJsonValue(target, undefined);
          return;
        }
        try {
          commitJsonValue(target, JSON.parse(raw));
        } catch {
          // Preserve the draft until it is valid JSON.
        }
      }}
    />
  );
  return (
    <span class="cfg-json-editor">
      {(props.sensitiveState.isSensitiveField || props.sensitiveState.isSensitive) &&
      props.onToggleSensitivePath ? (
        <span class="settings-secret">
          {control}
          <SensitiveToggleButton
            path={props.path}
            state={props.sensitiveState}
            disabled={props.disabled}
            onToggleSensitivePath={props.onToggleSensitivePath}
          />
        </span>
      ) : (
        control
      )}
      <span id={errorId()} class="cfg-field__error" role="alert" hidden />
    </span>
  );
}
