import "./config-form.css";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { ConfigUiHints } from "../api/types.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { REDACTED_SENTINEL } from "../lib/config-form-utils.ts";
import type { ConfigSecretFields } from "../lib/config/config-secret-fields.ts";
import { getLocale, registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createNativeDraft } from "../lib/reactive/native-draft.ts";
import "../components/tooltip.ts";
import { configValuesEqual, isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { summarizeConfigHelp } from "./config-form.help.ts";
import {
  configEnumOptionLabel,
  configFieldRequiresInput,
  formatConfigValueText,
  isSecretRefObject,
  type SensitiveRenderState,
} from "./config-form.node.shared.ts";
import {
  createSecretFieldHold,
  SecretFieldFrame,
  secretInputProps,
  storedSecretState,
} from "./config-form.secret-field.tsx";
import { configFieldId, type JsonSchema } from "./config-form.shared.ts";
import { Icon } from "./solid/icon.tsx";
import { Popover } from "./solid/popover.tsx";
import { SettingsSegmented } from "./solid/settings-ui.tsx";

export * from "./config-form.node.shared.ts";

registerEnglishCatalog(registerSettingsEnglish);

export function SensitiveToggleButton(props: {
  path: Array<string | number>;
  state: SensitiveRenderState;
  disabled: boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
}): JSX.Element {
  const label = createMemo(() =>
    props.state.isRevealed ? t("configForm.hideValue") : t("configForm.revealValue"),
  );
  return (
    <>
      {props.state.canReveal && props.onToggleSensitivePath && (
        <openclaw-tooltip prop:content={label()}>
          <button
            type="button"
            class="settings-secret__toggle"
            aria-label={label()}
            aria-pressed={props.state.isRevealed ? "true" : "false"}
            disabled={props.disabled}
            onClick={() => props.onToggleSensitivePath?.(props.path)}
          >
            <Icon name={props.state.isRevealed ? "eye" : "eyeOff"} />
          </button>
        </openclaw-tooltip>
      )}
    </>
  );
}

/**
 * Every word of a setting's help stays one click away. The popover mounts on first use so
 * long generated forms do not pay for an overlay per row.
 */
export function ConfigFieldHelp(props: {
  path: Array<string | number>;
  label: string;
  help?: string;
  context?: readonly string[];
  defaultValue?: string;
}): JSX.Element {
  const [mounted, setMounted] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  return (
    <span
      class="config-field-help"
      // A help button lives in toggle rows and disclosure summaries, which act on any click.
      onClick={(event) => {
        event.stopPropagation();
        if (!(event.target instanceof Node && button.contains(event.target))) {
          event.preventDefault();
        }
      }}
    >
      <button
        ref={(node) => (button = node)}
        type="button"
        class="settings-section__help-button"
        aria-label={t("configForm.sectionHelp", { section: props.label })}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={mounted() ? configFieldId(props.path, "help") : undefined}
        onClick={() => {
          setMounted(true);
          setOpen(!open());
        }}
      >
        <span aria-hidden="true">
          <Icon name="circleQuestionMark" />
        </span>
      </button>
      <Show when={mounted()}>
        <Popover
          id={configFieldId(props.path, "help")}
          label={t("configForm.sectionHelp", { section: props.label })}
          class="settings-section__help-popover config-field-help__popover"
          anchor={button}
          placement="top-start"
          lazy="while-open"
          open={open()}
          onOpenChange={setOpen}
        >
          <div class="settings-section__help-panel">
            <Show when={props.help}>
              <p>{props.help}</p>
            </Show>
            <For each={props.context ?? []}>{(text) => <p>{text}</p>}</For>
            <Show when={props.defaultValue !== undefined}>
              <p>{t("configForm.defaultValue", { value: props.defaultValue! })}</p>
            </Show>
          </div>
        </Popover>
      </Show>
    </span>
  );
}

/** One sentence in the row; the rest, and the default, on demand. */
export function configRowCopy(row: {
  label?: string;
  help?: string;
  context?: readonly string[];
  defaultValue?: string;
  width?: "beside" | "full";
}) {
  const { summary, clipped } = summarizeConfigHelp(row.help, row.width, row.label);
  return {
    summary,
    hasHelp: clipped || Boolean(row.context?.length) || row.defaultValue !== undefined,
  };
}

/** Says a setting is edited elsewhere. Nothing is wrong with it, so it is not an error. */
function ConfigUnsupportedNote(props: { message: string; onOpenRaw?: () => void }): JSX.Element {
  const parts = () => props.message.split(t("configView.raw"));
  return (
    <span class="settings-row__desc">
      <Show when={props.onOpenRaw && parts().length === 2} fallback={props.message}>
        {parts()[0]}
        <button type="button" class="config-field__raw-link" onClick={() => props.onOpenRaw?.()}>
          {t("configView.raw")}
        </button>
        {parts()[1]}
      </Show>
    </span>
  );
}

export function FieldRow(props: {
  label: string;
  path?: Array<string | number>;
  help?: string;
  /** What the row shows when its heading already names part of the label. */
  title?: JSX.Element;
  helpId?: string;
  helpContext?: readonly string[];
  defaultValue?: string;
  showLabel: boolean;
  required?: boolean;
  control: JSX.Element;
  stacked?: boolean;
  /** Field controls share the form's control column; a stepper hugs the edge like a toggle. */
  placement?: "column";
  error?: JSX.Element;
  unsupported?: string;
  onOpenRaw?: () => void;
  errorId?: string;
  errorRef?: (element: HTMLSpanElement) => void;
}): JSX.Element {
  // Collection item metadata belongs to the parent row, so unlabeled item rows
  // do not repeat its help or effective default.
  const copy = createMemo(() =>
    props.showLabel
      ? configRowCopy({
          label: props.label,
          help: props.help,
          context: props.helpContext,
          defaultValue: props.defaultValue,
          width: props.stacked ? "full" : "beside",
        })
      : { summary: "", hasHelp: false },
  );
  const hasText = createMemo(
    () => props.showLabel || Boolean(props.error) || Boolean(props.unsupported),
  );
  return (
    <div
      class={[
        "settings-row",
        {
          "settings-row--stacked": props.stacked || !hasText(),
          "settings-row--field": props.placement === "column",
        },
      ]}
    >
      {hasText() && (
        <div class="settings-row__text">
          {props.showLabel && (
            <span class="settings-row__title">
              {props.title ?? props.label}
              {props.required && (
                <span class="settings-row__desc" aria-hidden="true">
                  {" · "}
                  {t("configForm.required")}
                </span>
              )}
              {copy().hasHelp && props.path && (
                <ConfigFieldHelp
                  path={props.path}
                  label={props.label}
                  help={props.help}
                  context={props.helpContext}
                  defaultValue={props.defaultValue}
                />
              )}
            </span>
          )}
          {copy().summary && (
            <span class="settings-row__desc config-field__summary" id={props.helpId}>
              {copy().summary}
            </span>
          )}
          {props.error && (
            <span class="cfg-field__error" role="alert">
              {props.error}
            </span>
          )}
          {props.unsupported && (
            <ConfigUnsupportedNote message={props.unsupported} onOpenRaw={props.onOpenRaw} />
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

export function schemaDefaultValueText(schema: JsonSchema): string | undefined {
  return schema.default === undefined
    ? undefined
    : schema.enum
      ? configEnumOptionLabel(schema.default, schema.enum)
      : formatConfigValueText(schema.default);
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
  hints?: ConfigUiHints;
  secretFields?: ConfigSecretFields;
  onPatch: (path: Array<string | number>, value: unknown) => boolean | void;
}): JSX.Element {
  const errorId = createMemo(() => configFieldId(props.path, "json-error"));
  const hold = createSecretFieldHold(() => ({
    path: props.path,
    hints: props.hints ?? {},
    secretFields: props.secretFields,
    stored: () => props.sensitiveState.sentinelRedacted,
    reference: () => isSecretRefObject(props.sourceValue),
    label: () => props.ariaLabel,
  }));
  const stored = createMemo(() =>
    storedSecretState(hold, {
      stored: props.sensitiveState.sentinelRedacted,
      path: props.path,
      secretFields: props.secretFields,
      replaceStoredSecrets: undefined,
    }),
  );
  const envVar = () => stored().envVar;
  const replaceable = () => stored().replaceable;
  const lockedRedacted = () => props.sensitiveState.isRedacted && !replaceable();
  // Secrets stay out of autofill, saved form state, spellcheck services and password managers.
  const secretProps = secretInputProps(
    () =>
      hold.active() || props.sensitiveState.isSensitiveField || props.sensitiveState.isSensitive,
  );
  let textarea: HTMLTextAreaElement | undefined;
  const storedFallback = createMemo(() => (props.sensitiveState.isRedacted ? "" : props.fallback));
  const renderedFallback = createMemo(() => hold.text() ?? storedFallback());
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
    } else if (hold.active() && raw.includes(REDACTED_SENTINEL)) {
      // The sentinel only stands in for a stored secret; it is never a value to save.
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
  const saveHeld = async () => {
    const target = textarea;
    if (!target) {
      return;
    }
    const next = updateValidity(target);
    if (next.valid && !(await hold.save(next.candidate))) {
      draft.setValidity(target, hold.error());
    }
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
      ref={(element) => {
        textarea = element;
        draft.ref(element);
      }}
      class={["settings-input", { "cfg-redacted": lockedRedacted() }]}
      aria-label={props.ariaLabel}
      aria-required={configFieldRequiresInput(props) ? "true" : undefined}
      aria-describedby={[props.descriptionId, errorId()].filter(Boolean).join(" ") || undefined}
      aria-invalid="false"
      placeholder={
        replaceable()
          ? "••••••••"
          : envVar()
            ? t("configForm.environmentSecret", { name: envVar()! })
            : props.sensitiveState.isRedacted
              ? props.sensitiveState.canReveal && props.onToggleSensitivePath
                ? t("configForm.redactedPlaceholder")
                : "••••••••"
              : t("configForm.jsonValue")
      }
      rows={props.rows}
      disabled={props.disabled}
      readonly={lockedRedacted()}
      {...secretProps}
      onClick={() => {
        if (lockedRedacted() && props.sensitiveState.canReveal) {
          props.onToggleSensitivePath?.(props.path);
        }
      }}
      onInput={(event) => {
        if (!lockedRedacted()) {
          if (hold.active()) {
            hold.edit(event.currentTarget.value, storedFallback());
          }
          updateValidity(event.currentTarget);
        }
      }}
      onChange={(event) => {
        if (props.sensitiveState.isRedacted || hold.active()) {
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
      {hold.active() ||
      ((props.sensitiveState.isSensitiveField || props.sensitiveState.isSensitive) &&
        props.onToggleSensitivePath) ? (
        <SecretFieldFrame
          hold={hold}
          control={control}
          eye={() => (
            <SensitiveToggleButton
              path={props.path}
              state={props.sensitiveState}
              disabled={props.disabled}
              onToggleSensitivePath={props.onToggleSensitivePath}
            />
          )}
          hidesText={false}
          label={props.ariaLabel}
          disabled={props.disabled}
          multiline
          onSave={() => void saveHeld()}
          onCancel={() => {
            hold.cancel();
            textarea?.focus();
          }}
        />
      ) : (
        control
      )}
      <span ref={draft.errorRef} id={errorId()} class="cfg-field__error" role="alert" hidden />
    </span>
  );
}
