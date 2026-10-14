import type { JSX as SolidJSX } from "@solidjs/web";
import { Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";
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
  let host!: HTMLElement;
  const [draftOpen, setDraftOpen] = createSignal(false);
  const [draftKey, setDraftKey] = createSignal("");
  const [draftValue, setDraftValue] = createSignal("");
  const [draftIsNull, setDraftIsNull] = createSignal(false);
  const [error, setError] = createSignal("");
  const [invalidTarget, setInvalidTarget] = createSignal<"key" | "value" | null>(null);
  const [focusRequest, setFocusRequest] = createSignal<{ target: "key" | "value" }>();
  const visible = createMemo(() => draftOpen() && !props.disabled);
  const valueType = createMemo(() => schemaType(props.schema));
  const canUseNull = createMemo(() => isSupportedConfigValueValid(props.schema, null));
  const usesTextInput = createMemo(() =>
    ["string", "number", "integer"].includes(valueType() ?? ""),
  );
  const errorId = () => `${props.id}-error`;
  const valueLabel = () => `${t("configForm.add")}: ${props.label}`;

  onSettled(() => {
    props.ref({
      openDraft() {
        if (!props.disabled) {
          setDraftOpen(true);
        }
      },
    });
  });

  function clearError() {
    setError("");
    setInvalidTarget(null);
  }

  function closeDraft() {
    setDraftOpen(false);
    setDraftKey("");
    setDraftValue("");
    setDraftIsNull(false);
    setFocusRequest(undefined);
    clearError();
  }

  function fail(target: "key" | "value", message: string) {
    setInvalidTarget(target);
    setError(message);
    setFocusRequest({ target });
  }

  function commit() {
    const current = props;
    if (current.disabled) {
      return;
    }
    const parsed = parseValue(current.schema, draftValue(), draftIsNull());
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
    const key = draftKey().trim();
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

  createEffect(
    () => [props.identity, props.sourceIdentity] as const,
    (next, previous) => {
      if (
        previous &&
        (previous[0] !== next[0] ||
          // Autosave acknowledgements clone unchanged values; keep their in-progress draft.
          (!Object.is(previous[1], next[1]) && !configValuesEqual(previous[1], next[1])))
      ) {
        closeDraft();
      }
    },
  );

  createEffect(
    () => ({
      visible: visible(),
      request: focusRequest(),
      error: error(),
      invalidTarget: invalidTarget(),
    }),
    (next, previous) => {
      if (!next.visible) {
        return;
      }
      const keyInput = host.querySelector<HTMLInputElement>("[data-collection-draft-key]");
      const valueInput = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "[data-collection-draft-value]",
      );
      keyInput?.setCustomValidity(next.invalidTarget === "key" ? next.error : "");
      valueInput?.setCustomValidity(next.invalidTarget === "value" ? next.error : "");
      if (next.request && next.request !== previous?.request) {
        (next.request.target === "key" ? keyInput : valueInput)?.focus();
      } else if (!previous?.visible) {
        valueInput?.focus();
      }
    },
  );

  const onValueInput = (
    event: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement },
  ) => {
    setDraftValue(event.currentTarget.value);
    clearError();
  };
  return (
    <openclaw-config-form-collection-draft id={props.id} ref={(element) => (host = element)}>
      <Show when={visible()}>
        <div class="settings-row settings-row--stacked cfg-collection-draft">
          <div class="settings-row__control">
            <div class="cfg-collection-draft__controls">
              <Show when={props.existingKeys}>
                <input
                  data-collection-draft-key
                  type="text"
                  class="settings-input"
                  aria-label={t("configForm.key")}
                  aria-describedby={errorId()}
                  aria-invalid={invalidTarget() === "key" ? "true" : "false"}
                  placeholder={t("configForm.key")}
                  value={draftKey()}
                  onInput={(event) => {
                    setDraftKey(event.currentTarget.value);
                    clearError();
                  }}
                />
              </Show>
              <Show when={canUseNull()}>
                <label class="field checkbox">
                  <input
                    data-collection-draft-null
                    type="checkbox"
                    checked={draftIsNull()}
                    onChange={(event) => {
                      setDraftIsNull(event.currentTarget.checked);
                      clearError();
                    }}
                  />
                  <span>{t("configForm.nullValue")}</span>
                </label>
              </Show>
              <Show
                when={usesTextInput()}
                fallback={
                  <textarea
                    data-collection-draft-value
                    class="settings-input"
                    aria-label={valueLabel()}
                    aria-describedby={errorId()}
                    aria-invalid={invalidTarget() === "value" ? "true" : "false"}
                    placeholder={t("configForm.jsonValue")}
                    rows={2}
                    value={draftValue()}
                    disabled={draftIsNull()}
                    onInput={onValueInput}
                  />
                }
              >
                <input
                  data-collection-draft-value
                  type={valueType() === "string" ? "text" : "number"}
                  class="settings-input"
                  aria-label={valueLabel()}
                  aria-describedby={errorId()}
                  aria-invalid={invalidTarget() === "value" ? "true" : "false"}
                  value={draftValue()}
                  disabled={draftIsNull()}
                  onInput={onValueInput}
                />
              </Show>
              <span id={errorId()} class="cfg-field__error" role="alert" hidden={!error()}>
                {error()}
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
