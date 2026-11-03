import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { ConfigUiHints } from "../api/types.ts";
import type { ConfigSecretFields } from "../lib/config/config-secret-fields.ts";
import { t } from "../lib/reactive/i18n.ts";
import { hintForPath } from "./config-form.shared.ts";

const SAVED_VISIBLE_MS = 2500;

/** The schema marks some array rows as list[].field rather than list.*.field. */
function arrayHintKey(path: Array<string | number>): string {
  return path.reduce<string>(
    (key, segment) =>
      typeof segment === "number" ? `${key}[]` : key ? `${key}.${segment}` : segment,
    "",
  );
}

/** The schema's own marking decides; the nearest explicit hint on the path wins. */
export function isSecretConfigField(path: Array<string | number>, hints: ConfigUiHints): boolean {
  for (let end = path.length; end > 0; end -= 1) {
    const prefix = path.slice(0, end);
    const sensitive =
      hintForPath(prefix, hints)?.sensitive ?? hints[arrayHintKey(prefix)]?.sensitive;
    if (sensitive !== undefined) {
      return sensitive;
    }
  }
  return false;
}

type SecretFieldSource = {
  path: Array<string | number>;
  hints: ConfigUiHints;
  secretFields: ConfigSecretFields | undefined;
  /** False while the saved value is one a form never writes over, such as a stored secret. */
  writable: () => boolean;
  label: () => string;
};

/** A secret field keeps its edit to itself until its own Save writes that one value. */
export function createSecretFieldHold(read: () => SecretFieldSource) {
  const active = createMemo(() => {
    const source = read();
    return source.secretFields !== undefined && isSecretConfigField(source.path, source.hints);
  });
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const text = createMemo(() => {
    revision();
    const source = read();
    return active() && source.writable() ? source.secretFields?.read(source.path) : undefined;
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
    text,
    saving,
    saved,
    /** The latest refusal; the field shows it and clears it on the next edit. */
    error: () => error,
    edit(next: string, stored: string) {
      const source = read();
      error = "";
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
        .catch((cause: unknown) => ({ ok: false as const, error: String(cause) }));
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
export function SecretFieldActions(props: {
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
