import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { ConfigUiHints } from "../api/types.ts";
import { isSecretConfigField } from "../lib/config-form-utils.ts";
import type {
  ConfigSecretFields,
  StoredSecretSources,
} from "../lib/config/config-secret-fields.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isComposingKeyboardEvent } from "../lib/ime.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";

const SAVED_VISIBLE_MS = 2500;

type SecretFieldSource = {
  path: Array<string | number>;
  hints: ConfigUiHints;
  secretFields: ConfigSecretFields | undefined;
  /** The Gateway redacted this value, so it is a secret whatever its marking says. */
  stored: () => boolean;
  /** The value is a SecretRef, which no form writes over. */
  reference: () => boolean;
  label: () => string;
};

/** A secret field keeps its edit to itself until its own Save writes that one value. */
export function createSecretFieldHold(read: () => SecretFieldSource) {
  const active = createMemo(() => {
    const source = read();
    return (
      source.secretFields !== undefined &&
      (source.stored() || isSecretConfigField(source.path, source.hints))
    );
  });
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [showsTyped, setShowsTyped] = createSignal(false);
  // Only a stored secret proven to be plain text in the file can be typed over. A reference, a
  // SecretRef or anything unproven stays read-only, even if an edit was held before it arrived.
  // Re-read whenever the saved config changes, since a value's source can change under it.
  const writable = createMemo(() => {
    revision();
    const source = read();
    return (
      !source.reference() &&
      (!source.stored() || source.secretFields?.source(source.path).kind === "literal")
    );
  });
  const text = createMemo(() => {
    revision();
    const source = read();
    return active() && writable() ? source.secretFields?.read(source.path) : undefined;
  });
  let error = "";
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const clearSaved = () => {
    clearTimeout(savedTimer);
    setSaved(false);
  };
  onSettled(() => {
    const stop = read().secretFields?.subscribe(() => setRevision((value) => value + 1));
    return () => {
      stop?.();
      clearTimeout(savedTimer);
    };
  });
  return {
    active,
    writable,
    text,
    saving,
    saved,
    /** The latest refusal; the field shows it and clears it on the next edit. */
    error: () => error,
    /** Typed text can be shown; a new edit always starts hidden. */
    revealed: () => text() !== undefined && showsTyped(),
    toggleRevealed: () => setShowsTyped((value) => !value),
    edit(next: string, stored: string) {
      const source = read();
      error = "";
      if (text() === undefined) {
        setShowsTyped(false);
      }
      clearSaved();
      if (next === stored) {
        source.secretFields?.release(source.path);
      } else {
        source.secretFields?.hold(source.path, next, source.label());
      }
    },
    cancel() {
      const source = read();
      error = "";
      source.secretFields?.release(source.path);
    },
    async save(value: unknown): Promise<boolean> {
      const source = read();
      const secretFields = source.secretFields;
      const path = source.path;
      if (!secretFields || saving()) {
        return false;
      }
      error = "";
      setSaving(true);
      const result = await secretFields
        .save(path, value)
        .catch((cause: unknown) => ({ ok: false as const, error: formatUiError(cause) }));
      setSaving(false);
      if (!result.ok) {
        error = result.error;
        return false;
      }
      secretFields.release(path);
      setSaved(true);
      savedTimer = setTimeout(() => setSaved(false), SAVED_VISIBLE_MS);
      return true;
    },
  };
}

export type SecretFieldHold = ReturnType<typeof createSecretFieldHold>;

/**
 * Save and Cancel sit beside the field, within the field's own width, so the row keeps its
 * height. They keep their place through Saving and Saved, so the field doesn't move twice.
 */
function SecretFieldActions(props: {
  hold: SecretFieldHold;
  label: string;
  disabled: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const held = () => props.hold.text() !== undefined;
  return (
    <Show when={held() || props.hold.saved()}>
      <span class="cfg-secret-actions" data-saved={held() ? undefined : ""}>
        <span class="cfg-secret-actions__buttons">
          <button
            type="button"
            class="btn btn--sm primary"
            aria-label={`${t("common.save")}: ${props.label}`}
            aria-busy={props.hold.saving() ? "true" : undefined}
            disabled={!held() || props.disabled || props.hold.saving()}
            onClick={() => props.onSave()}
          >
            <span
              class="cfg-secret-actions__label"
              data-shown={props.hold.saving() ? undefined : ""}
            >
              {t("common.save")}
            </span>
            <span
              class="cfg-secret-actions__label"
              data-shown={props.hold.saving() ? "" : undefined}
              aria-hidden="true"
            >
              {t("common.saving")}
            </span>
          </button>
          <button
            type="button"
            class="btn btn--sm"
            aria-label={`${t("common.cancel")}: ${props.label}`}
            disabled={!held() || props.hold.saving()}
            onClick={() => props.onCancel()}
          >
            {t("common.cancel")}
          </button>
        </span>
        <Show when={!held()}>
          <span class="cfg-secret-actions__saved" role="status">
            {t("configForm.secretSaved")}
          </span>
        </Show>
      </span>
    </Show>
  );
}

/**
 * The eye inside the field. While an edit is held it shows only what was typed here, never a
 * stored value; otherwise the field's own toggle, if any, takes its place.
 */
function HeldSecretToggle(props: {
  hold: SecretFieldHold;
  hidesText: boolean;
  fallback: JSX.Element;
}) {
  const label = () => t(props.hold.revealed() ? "configForm.hideValue" : "configForm.revealValue");
  return (
    <Show when={props.hold.text() !== undefined} fallback={props.fallback}>
      <Show when={props.hidesText}>
        <openclaw-tooltip prop:content={label()}>
          <button
            type="button"
            class="settings-secret__toggle"
            aria-label={label()}
            aria-pressed={props.hold.revealed() ? "true" : "false"}
            onClick={() => props.hold.toggleRevealed()}
          >
            <Icon name={props.hold.revealed() ? "eye" : "eyeOff"} />
          </button>
        </openclaw-tooltip>
      </Show>
    </Show>
  );
}

/**
 * What a form may do with a stored secret: replace it only where the hold proved it plain text in
 * the file (or a form-level Save owns the edit), and name the variable behind a whole ${VAR}.
 */
export function storedSecretState(
  hold: SecretFieldHold,
  params: {
    stored: boolean;
    path: Array<string | number>;
    secretFields: StoredSecretSources | undefined;
    replaceStoredSecrets: StoredSecretSources | undefined;
  },
) {
  const source = params.stored
    ? (params.secretFields ?? params.replaceStoredSecrets)?.source(params.path)
    : undefined;
  return {
    envVar: source?.kind === "environment" ? source.name : null,
    replaceable:
      params.stored &&
      (hold.active()
        ? hold.writable()
        : params.replaceStoredSecrets !== undefined && source?.kind === "literal"),
  };
}

/** Keeps a secret out of autofill, saved form state, spellcheck services and password managers. */
export function secretInputProps(isSecret: () => boolean) {
  const when = <T,>(value: T) => (isSecret() ? value : undefined);
  return {
    get autocomplete() {
      return when("off");
    },
    get spellcheck() {
      return when(false);
    },
    get autocapitalize() {
      return when("off");
    },
    get "data-1p-ignore"() {
      return when("");
    },
    get "data-lpignore"() {
      return when("true");
    },
    get "data-bwignore"() {
      return when("");
    },
    get "data-form-type"() {
      return when("other");
    },
  };
}

/** Enter saves a held one-line edit and Escape cancels it. Returns whether the key was taken. */
export function handleHeldSecretKey(
  event: KeyboardEvent,
  hold: SecretFieldHold,
  options: { multiline: boolean; onSave: () => void; onCancel: () => void },
): boolean {
  if (hold.text() === undefined || (event.key !== "Enter" && event.key !== "Escape")) {
    return false;
  }
  if (isComposingKeyboardEvent(event)) {
    return false;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    options.onCancel();
  } else if (!options.multiline && !hold.saving()) {
    event.preventDefault();
    options.onSave();
  }
  return true;
}

/** A secret's input and eye, with Save and Cancel beside the field while it holds an edit. */
export function SecretFieldFrame(props: {
  hold: SecretFieldHold;
  control: JSX.Element;
  /** The field's own toggle, shown while nothing is held. */
  eye: () => JSX.Element;
  hidesText: boolean;
  label: string;
  disabled: boolean;
  multiline?: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const field = () => (
    <span class="settings-secret">
      {props.control}
      <HeldSecretToggle hold={props.hold} hidesText={props.hidesText} fallback={props.eye()} />
    </span>
  );
  return (
    <Show when={props.hold.active()} fallback={field()}>
      <span class={props.multiline ? "cfg-secret cfg-secret--multiline" : "cfg-secret"}>
        {field()}
        <SecretFieldActions
          hold={props.hold}
          label={props.label}
          disabled={props.disabled}
          onSave={props.onSave}
          onCancel={props.onCancel}
        />
      </span>
    </Show>
  );
}
