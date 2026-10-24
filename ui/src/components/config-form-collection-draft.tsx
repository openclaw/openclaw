import { dynamic, type JSX as SolidJSX } from "@solidjs/web";
import { Show, createMemo, createStore, onSettled } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { configValuesEqual, isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { coerceConfigFormNumberString } from "./config-form.numeric.ts";
import { schemaMayAcceptString, schemaType, type JsonSchema } from "./config-form.shared.ts";

export type ConfigFormCollectionDraftProps = {
  schema: JsonSchema;
  label: string;
  disabled: boolean;
  identity: string;
  sourceIdentity: unknown;
  existingKeys?: readonly string[];
  validateKey?: (key: string) => boolean;
  existingValues?: readonly unknown[];
  validateValue?: (value: unknown) => boolean;
};

export type ConfigFormCollectionDraftCommit = {
  key?: string;
  value: unknown;
};

export type ConfigCollectionDraftHandle = {
  openDraft(): void;
};

function emptyDraft(): {
  open: boolean;
  key: string;
  value: string;
  isNull: boolean;
  error: string;
  invalidTarget: "key" | "value" | null;
} {
  return {
    open: false,
    key: "",
    value: "",
    isNull: false,
    error: "",
    invalidTarget: null,
  };
}

function parseValue(
  schema: JsonSchema,
  draftValue: string,
  draftIsNull: boolean,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (draftIsNull) {
    return { ok: true, value: null };
  }
  const valueType = schemaType(schema);
  const variants = schema.anyOf ?? schema.oneOf ?? [];
  const stringNumberUnion =
    variants.some(schemaMayAcceptString) &&
    variants.some((variant) => ["number", "integer"].includes(schemaType(variant) ?? ""));
  if (valueType === "string") {
    return { ok: true, value: draftValue };
  }
  if (valueType === "number" || valueType === "integer") {
    const coerced = coerceConfigFormNumberString(draftValue, valueType === "integer");
    return typeof coerced === "number"
      ? { ok: true, value: coerced }
      : { ok: false, message: t("configForm.invalidNumber") };
  }
  try {
    const parsed = JSON.parse(draftValue) as unknown;
    if (typeof parsed === "number") {
      const coerced = coerceConfigFormNumberString(draftValue, false);
      if (typeof coerced === "number") {
        return { ok: true, value: coerced };
      }
      // JSON.parse has already rounded unsafe integer spellings. Preserve
      // the source text only when the union accepts it as a string.
      return stringNumberUnion && isSupportedConfigValueValid(schema, draftValue)
        ? { ok: true, value: draftValue }
        : { ok: false, message: t("configForm.invalidNumber") };
    }
    return { ok: true, value: parsed };
  } catch {
    return stringNumberUnion && isSupportedConfigValueValid(schema, draftValue)
      ? { ok: true, value: draftValue }
      : { ok: false, message: t("configForm.invalidJson") };
  }
}

export function ConfigCollectionDraft(
  props: ConfigFormCollectionDraftProps & {
    id: string;
    ref: (handle: ConfigCollectionDraftHandle) => void;
    onCommit: (draft: ConfigFormCollectionDraftCommit) => boolean;
  },
): SolidJSX.Element {
  let keyInput: HTMLInputElement | undefined;
  let valueInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  const scope = createMemo(() => [props.identity, props.sourceIdentity] as const, {
    // Autosave acknowledgements clone unchanged values; keep their in-progress draft.
    equals: (previous, next) =>
      previous[0] === next[0] &&
      (Object.is(previous[1], next[1]) || configValuesEqual(previous[1], next[1])),
  });
  const [draft, setDraft] = createStore((current) => {
    scope();
    Object.assign(current, emptyDraft());
  }, emptyDraft());
  const visible = () => draft.open && !props.disabled;
  const valueType = createMemo(() => schemaType(props.schema));
  const canUseNull = createMemo(() => isSupportedConfigValueValid(props.schema, null));
  const usesTextInput = createMemo(() =>
    ["string", "number", "integer"].includes(valueType() ?? ""),
  );
  const ValueInput = dynamic(() => (usesTextInput() ? "input" : "textarea"));
  const errorId = () => `${props.id}-error`;
  const valueLabel = () => `${t("configForm.add")}: ${props.label}`;

  onSettled(() => {
    props.ref({
      openDraft() {
        if (!props.disabled) {
          setDraft((current) => {
            current.open = true;
          });
        }
      },
    });
  });

  function editDraft(patch: Partial<ReturnType<typeof emptyDraft>>) {
    keyInput?.setCustomValidity("");
    valueInput?.setCustomValidity("");
    setDraft((current) => ({ ...current, ...patch, error: "", invalidTarget: null }));
  }

  function closeDraft() {
    setDraft(() => emptyDraft());
  }

  function fail(target: "key" | "value", message: string) {
    setDraft((current) => {
      current.invalidTarget = target;
      current.error = message;
    });
    keyInput?.setCustomValidity(target === "key" ? message : "");
    valueInput?.setCustomValidity(target === "value" ? message : "");
    (target === "key" ? keyInput : valueInput)?.focus();
  }

  function commit() {
    const current = props;
    if (current.disabled) {
      return;
    }
    const parsed = parseValue(current.schema, draft.value, draft.isNull);
    if (!parsed.ok) {
      fail("value", parsed.message);
      return;
    }
    if (!isSupportedConfigValueValid(current.schema, parsed.value)) {
      fail(
        "value",
        ["number", "integer"].includes(schemaType(current.schema) ?? "")
          ? t("configForm.invalidNumber")
          : t("configForm.invalidString"),
      );
      return;
    }
    if (
      current.existingValues?.some((value) => configValuesEqual(value, parsed.value)) ||
      current.validateValue?.(parsed.value) === false
    ) {
      fail("value", t("configForm.invalidString"));
      return;
    }
    const key = draft.key.trim();
    if (
      current.existingKeys &&
      (!key || current.existingKeys.includes(key) || current.validateKey?.(key) === false)
    ) {
      fail("key", t("configForm.invalidString"));
      return;
    }

    const accepted = props.onCommit({
      ...(current.existingKeys ? { key } : {}),
      value: parsed.value,
    });
    if (accepted) {
      closeDraft();
    } else {
      fail("value", t("configForm.invalidString"));
    }
  }

  const onValueInput = (event: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
    editDraft({ value: event.currentTarget.value });
  return (
    <openclaw-config-form-collection-draft id={props.id}>
      <Show when={visible()}>
        {(_visible) => {
          onSettled(() => {
            keyInput?.setCustomValidity(draft.invalidTarget === "key" ? draft.error : "");
            valueInput?.setCustomValidity(draft.invalidTarget === "value" ? draft.error : "");
            valueInput?.focus();
          });
          return (
            <div class="settings-row settings-row--stacked cfg-collection-draft">
              <div class="settings-row__control">
                <div class="cfg-collection-draft__controls">
                  <Show when={props.existingKeys}>
                    <input
                      ref={(element) => (keyInput = element)}
                      data-collection-draft-key
                      type="text"
                      class="settings-input"
                      aria-label={t("configForm.key")}
                      aria-describedby={errorId()}
                      aria-invalid={draft.invalidTarget === "key" ? "true" : "false"}
                      placeholder={t("configForm.key")}
                      value={draft.key}
                      onInput={(event) => editDraft({ key: event.currentTarget.value })}
                    />
                  </Show>
                  <Show when={canUseNull()}>
                    <label class="field checkbox">
                      <input
                        data-collection-draft-null
                        type="checkbox"
                        checked={draft.isNull}
                        onChange={(event) => editDraft({ isNull: event.currentTarget.checked })}
                      />
                      <span>{t("configForm.nullValue")}</span>
                    </label>
                  </Show>
                  <ValueInput
                    ref={(element: HTMLInputElement | HTMLTextAreaElement) =>
                      (valueInput = element)
                    }
                    data-collection-draft-value
                    type={
                      usesTextInput() ? (valueType() === "string" ? "text" : "number") : undefined
                    }
                    class="settings-input"
                    aria-label={valueLabel()}
                    aria-describedby={errorId()}
                    aria-invalid={draft.invalidTarget === "value" ? "true" : "false"}
                    placeholder={usesTextInput() ? undefined : t("configForm.jsonValue")}
                    rows={usesTextInput() ? undefined : 2}
                    value={draft.value}
                    disabled={draft.isNull}
                    onInput={onValueInput}
                  />
                  <span id={errorId()} class="cfg-field__error" role="alert" hidden={!draft.error}>
                    {draft.error}
                  </span>
                  <div class="cfg-collection-draft__actions">
                    <button type="button" class="btn btn--sm" onClick={commit}>
                      {props.existingKeys ? t("configForm.addEntry") : t("configForm.add")}
                    </button>
                    <button type="button" class="btn btn--sm" onClick={closeDraft}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        }}
      </Show>
    </openclaw-config-form-collection-draft>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-config-form-collection-draft": HTMLAttributes<HTMLElement>;
    }
  }
}
