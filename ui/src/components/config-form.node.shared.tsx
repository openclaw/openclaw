import type { JSX } from "@solidjs/web";
import { createMemo, onSettled } from "solid-js";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { getLocale, registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createNativeDraft } from "../lib/reactive/native-draft.ts";
import "../components/tooltip.ts";
import { configValuesEqual, isSupportedConfigValueValid } from "./config-form.constraints.ts";
import {
  configEnumOptionLabel,
  configFieldRequiresInput,
  formatConfigValueText,
  type SensitiveRenderState,
} from "./config-form.node.shared.ts";
import { configFieldId, type JsonSchema } from "./config-form.shared.ts";
import { Icon } from "./solid/icon.tsx";
import { SettingsDefaultDescription, SettingsSegmented } from "./solid/settings-ui.tsx";

export * from "./config-form.node.shared.ts";

registerEnglishCatalog(registerSettingsEnglish);

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
  required?: boolean;
  control: JSX.Element;
  stacked?: boolean;
  error?: JSX.Element;
  errorId?: string;
  errorRef?: (element: HTMLSpanElement) => void;
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
          {props.showLabel && (
            <span class="settings-row__title">
              {props.label}
              {props.required && (
                <span class="settings-row__desc" aria-hidden="true">
                  {" · "}
                  {t("configForm.required")}
                </span>
              )}
            </span>
          )}
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
          {!props.showLabel && props.required && (
            <span class="settings-row__desc" aria-hidden="true">
              {t("configForm.required")}
            </span>
          )}
          {props.control}
          {props.errorId && (
            <span
              ref={(element) => props.errorRef?.(element)}
              id={props.errorId}
              class="cfg-field__error"
              role="alert"
              hidden
            />
          )}
        </div>
      )}
    </div>
  );
}

export type CollectionRowFocus = {
  register(button: HTMLButtonElement): () => void;
  destinations(): Array<HTMLButtonElement | undefined>;
};

export function createCollectionFocus<Key>(keys: () => readonly Key[]) {
  let addButton: HTMLButtonElement;
  const buttons = new Map<Key, HTMLButtonElement>();
  return {
    addRef: (button: HTMLButtonElement) => (addButton = button),
    row(key: () => Key): CollectionRowFocus {
      return {
        register(button) {
          const initialKey = key();
          buttons.set(initialKey, button);
          return () => buttons.delete(initialKey);
        },
        destinations() {
          const order = keys();
          const index = order.indexOf(key());
          const next = order[index + 1];
          const previous = order[index - 1];
          return [
            next === undefined ? undefined : buttons.get(next),
            previous === undefined ? undefined : buttons.get(previous),
            addButton,
          ];
        },
      };
    },
  };
}

export function CollectionRemoveButton(props: {
  label: string;
  disabled: boolean;
  remove: () => boolean;
  focus: CollectionRowFocus;
}): JSX.Element {
  let button!: HTMLButtonElement;
  onSettled(() => props.focus.register(button));
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        ref={(element) => (button = element)}
        type="button"
        class="btn btn--icon"
        style={{ width: "28px", height: "28px", padding: "0" }}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={(event) => removeCollectionRow(event, props.remove, props.focus.destinations())}
      >
        <Icon name="trash" />
      </button>
    </openclaw-tooltip>
  );
}

/** Keep keyboard focus in the collection when its focused Remove button retires. */
function removeCollectionRow(
  event: Event,
  remove: () => boolean,
  destinations: Array<HTMLButtonElement | undefined>,
) {
  const control = event.currentTarget;
  if (!(control instanceof HTMLButtonElement) || control !== document.activeElement) {
    remove();
    return;
  }
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
  required?: boolean;
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
      ariaRequired={props.required}
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
  showRequiredCue?: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
}): JSX.Element {
  const errorId = createMemo(() => configFieldId(props.path, "json-error"));
  const renderedFallback = createMemo(() =>
    props.sensitiveState.isRedacted ? "" : props.fallback,
  );
  const draft = createNativeDraft(
    () => ({
      sourceIdentity: props.sourceValue,
      renderedValue: renderedFallback(),
      pathKey: JSON.stringify(props.path.filter((segment) => typeof segment === "string")),
      presentationIdentity: "json",
    }),
    // Equal autosave acknowledgments must not erase invalid JSON still being edited.
    { sourceEquals: configValuesEqual },
  );
  const updateValidity = (target: HTMLTextAreaElement) => {
    let message = "";
    let candidate: unknown;
    const raw = target.value.trim();
    if (!raw && props.isRequired) {
      message = t("configForm.invalidJson");
    } else if (raw) {
      try {
        candidate = JSON.parse(raw);
        if (!isSupportedConfigValueValid(props.schema, candidate)) {
          message = t("configForm.invalidJson");
        }
      } catch {
        message = t("configForm.invalidJson");
      }
    }
    draft.setValidity(target, message);
    return { valid: !message, candidate };
  };
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
      ref={draft.ref}
      class={["settings-input", { "cfg-redacted": props.sensitiveState.isRedacted }]}
      aria-label={props.ariaLabel}
      aria-required={configFieldRequiresInput(props) ? "true" : undefined}
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
        if (props.sensitiveState.isRedacted) {
          return;
        }
        const target = event.currentTarget;
        const next = updateValidity(target);
        if (next.valid) {
          commitJsonValue(target, next.candidate);
        }
      }}
    />
  );
  return (
    <span class="cfg-json-editor">
      {props.showRequiredCue !== false && configFieldRequiresInput(props) && (
        <span class="settings-row__desc" aria-hidden="true">
          {t("configForm.required")}
        </span>
      )}
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
      <span ref={draft.errorRef} id={errorId()} class="cfg-field__error" role="alert" hidden />
    </span>
  );
}
