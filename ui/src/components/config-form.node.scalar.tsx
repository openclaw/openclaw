import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { For, createMemo } from "solid-js";
import { i18n } from "../i18n/index.ts";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import { createNativeDraft } from "../lib/reactive/native-draft.ts";
import {
  configValuesEqual,
  isSupportedConfigValueValid,
  normalizeNumericValue,
  numericInputConstraints,
} from "./config-form.constraints.ts";
import {
  configEnumOptionLabel,
  formatConfigValueText,
  getSensitiveRenderState,
  isSecretRefObject,
  jsonValue,
  FieldRow,
  renderSchemaDefaultDescription,
  SensitiveToggleButton,
  resolveConfigFieldPresentation,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.tsx";
import {
  coerceConfigFormNumberString,
  isConfigFormDecimalNumberString,
  isConfigFormUnsafeIntegerString,
} from "./config-form.numeric.ts";
import {
  beginScalarEdit,
  finishScalarEdit,
  scalarEditHintForInput,
  scalarValueBranch,
  syncScalarEditIdentity,
  type ScalarEditHint,
} from "./config-form.scalar-edit.ts";
import { configFieldId, hintForPath, schemaType } from "./config-form.shared.ts";

function coerceTextInputValue(
  value: string,
  schema: ConfigNodeRenderParams["schema"],
  editHint: ScalarEditHint,
): string | number | boolean | undefined {
  const trimmed = value.trim();
  const variants = schema.anyOf ?? schema.oneOf ?? [];
  const stringCandidateValid = isSupportedConfigValueValid(schema, value);
  const currentBranch = editHint.branch;
  const booleanCandidate = trimmed === "true" ? true : trimmed === "false" ? false : undefined;
  if (booleanCandidate !== undefined && isSupportedConfigValueValid(schema, booleanCandidate)) {
    let booleanBranchValid = false;
    let explicitBooleanBranchValid = false;
    for (const variant of variants) {
      const booleanBranch =
        schemaType(variant) === "boolean" ||
        typeof variant.const === "boolean" ||
        variant.enum?.some((entry) => typeof entry === "boolean");
      if (!booleanBranch || !isSupportedConfigValueValid(variant, booleanCandidate)) {
        continue;
      }
      booleanBranchValid = true;
      explicitBooleanBranchValid ||=
        Object.is(variant.const, booleanCandidate) ||
        Boolean(variant.enum?.some((entry) => Object.is(entry, booleanCandidate)));
    }
    if (
      booleanBranchValid &&
      (currentBranch !== "string" || explicitBooleanBranchValid || !stringCandidateValid)
    ) {
      return booleanCandidate;
    }
  }
  let numberCandidate: number | undefined;
  for (const variant of variants) {
    const type = schemaType(variant);
    if (type !== "number" && type !== "integer") {
      continue;
    }
    const candidate = coerceConfigFormNumberString(value, type === "integer");
    if (typeof candidate === "number" && isSupportedConfigValueValid(schema, candidate)) {
      numberCandidate = candidate;
      break;
    }
  }
  if (currentBranch === "number") {
    if (numberCandidate !== undefined) {
      return numberCandidate;
    }
    if (isConfigFormDecimalNumberString(value)) {
      return stringCandidateValid && isConfigFormUnsafeIntegerString(trimmed) ? value : undefined;
    }
  }
  if (currentBranch === "string" && stringCandidateValid) {
    return value;
  }
  return numberCandidate ?? value;
}

type NumericInputState = { parsed?: number; message: string };

// Partial numeric text ("3.", "-", "1e") reports value === "" with
// validity.badInput set. Treating it as an intentional clear committed
// undefined mid-keystroke, wiping the stored value and the user's input.
function resolveNumericInputState(
  target: HTMLInputElement,
  { schema, isRequired }: Pick<ConfigNodeRenderParams, "schema" | "isRequired">,
  invalidMessage = t("configForm.invalidNumber"),
): NumericInputState {
  const raw = target.value;
  if (raw.trim() === "") {
    return {
      message: target.validity.badInput || isRequired === true ? invalidMessage : "",
    };
  }
  const parsed = coerceConfigFormNumberString(raw, schemaType(schema) === "integer");
  return typeof parsed === "number"
    ? { parsed, message: isSupportedConfigValueValid(schema, parsed) ? "" : invalidMessage }
    : { message: invalidMessage };
}

export function TextInput(props: {
  params: ConfigNodeRenderParams & { inputType: "text" | "number" };
}): JSX.Element {
  return <ScalarInput params={props.params} inputType={props.params.inputType} stepped={false} />;
}

export function NumberInput(props: { params: ConfigNodeRenderParams }): JSX.Element {
  return <ScalarInput params={props.params} inputType="number" stepped />;
}

function ScalarInput(props: {
  params: ConfigNodeRenderParams;
  inputType: "text" | "number";
  stepped: boolean;
}): JSX.Element {
  const state = createMemo(() => {
    const params = props.params;
    const { schema, value, path, hints, isRequired } = params;
    const hint = hintForPath(path, hints);
    const field = resolveConfigFieldPresentation(params);
    const errorId = configFieldId(path, "scalar-error");
    const sensitiveState = props.stepped ? undefined : getSensitiveRenderState(params);
    const isStructuredSecretRef = !props.stepped && isSecretRefObject(value);
    const rawAvailable = params.rawAvailable ?? true;
    const masked = sensitiveState?.isMasked;
    const effectiveRedacted =
      (sensitiveState?.isRedacted && !masked) ||
      sensitiveState?.sentinelRedacted ||
      isStructuredSecretRef;
    const placeholder = effectiveRedacted
      ? isStructuredSecretRef
        ? rawAvailable
          ? t("configForm.structuredSecretRaw")
          : t("configForm.structuredSecretFile")
        : masked
          ? "••••••••"
          : t("configForm.redactedPlaceholder")
      : (hint?.placeholder ??
        (!masked && schema.default !== undefined
          ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
          : props.stepped
            ? undefined
            : ""));
    const displayValue = effectiveRedacted
      ? ""
      : !props.stepped && isRecord(value)
        ? jsonValue(value)
        : (value ?? (params.compact ? schema.default : undefined) ?? "");
    const effectiveValue = value !== undefined ? value : schema.default;
    const initialBranch = scalarValueBranch(effectiveValue);
    const effectiveInputType = masked
      ? "password"
      : sensitiveState?.isSensitive && !effectiveRedacted
        ? "text"
        : props.inputType;
    const multiline =
      hint?.multiline === true &&
      props.inputType === "text" &&
      !sensitiveState?.isSensitive &&
      !sensitiveState?.isSensitiveField;
    const isPhonePresentation = !props.stepped && hint?.presentation === "phone-number";
    const phonePresentation =
      isPhonePresentation && !effectiveRedacted && !masked && typeof value === "string"
        ? formatInternationalPhoneNumberForDisplay(value, i18n.getLocale())
        : undefined;
    const controlIdentity = params.controlIdentity ?? params.sourceIdentity ?? value;
    const sourceIdentity = params.sourceIdentity ?? value;
    const pathKey = configFieldId(
      path.filter((segment) => typeof segment === "string"),
      "scalar-identity",
    );
    const renderedValue = formatConfigValueText(displayValue);
    const presentationIdentity = props.stepped
      ? "number"
      : [
          effectiveRedacted ? "redacted" : "visible",
          effectiveInputType,
          isPhonePresentation ? "phone" : "plain",
          isStructuredSecretRef ? (rawAvailable ? "secret-raw" : "secret-file") : "scalar",
        ].join(":");
    const constraints = props.stepped ? numericInputConstraints(schema) : undefined;
    const numericStep = typeof constraints?.step === "number" ? constraints.step : 1;
    const inputType = props.inputType;
    const invalidString = t("configForm.invalidString");
    const invalidNumber = t("configForm.invalidNumber");
    const textInputState = (raw: string, editHint: ScalarEditHint) => {
      const candidate = coerceTextInputValue(raw, schema, editHint);
      const valid = isSupportedConfigValueValid(schema, candidate);
      const clearOptional = raw === "" && !isRequired && !valid;
      return {
        candidate: clearOptional ? undefined : candidate,
        message: valid || clearOptional ? "" : invalidString,
      };
    };
    return {
      field,
      errorId,
      sensitiveState,
      isStructuredSecretRef,
      masked,
      effectiveRedacted,
      placeholder,
      effectiveValue,
      initialBranch,
      effectiveInputType,
      multiline,
      isPhonePresentation,
      phonePresentation,
      controlIdentity,
      sourceIdentity,
      pathKey,
      renderedValue,
      presentationIdentity,
      constraints,
      numericStep,
      textInputState,
      revalidate(this: void, target: HTMLInputElement | HTMLTextAreaElement): void {
        draft.setValidity(
          target,
          effectiveRedacted
            ? ""
            : inputType === "number" && target instanceof HTMLInputElement
              ? resolveNumericInputState(target, { schema, isRequired }, invalidNumber).message
              : textInputState(target.value, scalarEditHintForInput(target, initialBranch)).message,
        );
      },
    };
  });
  const draft = createNativeDraft(state, {
    preserveFocusedDraft: true,
    onReconciled: (target, current) =>
      syncScalarEditIdentity(target, current.pathKey, current.presentationIdentity),
  });
  let patchSource: unknown;
  let patchedValue: unknown;
  const commitScalarValue = (
    target: HTMLInputElement | HTMLTextAreaElement,
    candidate: unknown,
    skipUnchanged = false,
  ) => {
    if (!Object.is(patchSource, props.params.value)) {
      patchSource = props.params.value;
      patchedValue = patchSource;
    }
    if (skipUnchanged && configValuesEqual(patchedValue, candidate)) {
      return true;
    }
    if (props.params.onPatch(props.params.path, candidate) !== false) {
      patchedValue = candidate;
      return true;
    }
    target.value = state().renderedValue;
    state().revalidate(target);
    return false;
  };
  const commitChange = (target: HTMLInputElement | HTMLTextAreaElement, allowClear = true) => {
    if (state().effectiveRedacted) {
      return;
    }
    const commit = (candidate: unknown) => commitScalarValue(target, candidate, true);
    if (props.inputType === "number" && target instanceof HTMLInputElement) {
      const next = resolveNumericInputState(target, props.params);
      if (props.stepped && next.parsed !== undefined) {
        next.parsed = normalizeNumericValue(next.parsed, props.params.schema);
        next.message = isSupportedConfigValueValid(props.params.schema, next.parsed)
          ? ""
          : t("configForm.invalidNumber");
        target.value = formatConfigValueText(next.parsed);
      }
      if (draft.setValidity(target, next.message) && (allowClear || next.parsed !== undefined)) {
        commit(next.parsed);
      }
      return;
    }
    const editHint = beginScalarEdit(target, state().initialBranch);
    const raw = target.value;
    const rawState = state().textInputState(raw, editHint);
    let nextState = rawState;
    if (rawState.message || state().isPhonePresentation) {
      const normalized = raw.trim();
      nextState = state().textInputState(normalized, editHint);
      if (!nextState.message) {
        target.value = normalized;
      }
    }
    draft.setValidity(target, nextState.message ? rawState.message : "");
    if (!nextState.message) {
      commit(nextState.candidate);
    }
    finishScalarEdit(target);
  };
  const step = (direction: -1 | 1) => {
    if (props.params.disabled) {
      return;
    }
    const current = Number(state().effectiveValue);
    const base = Number.isFinite(current) ? current : 0;
    const candidate = normalizeNumericValue(
      base + direction * state().numericStep,
      props.params.schema,
    );
    if (isSupportedConfigValueValid(props.params.schema, candidate)) {
      props.params.onPatch(props.params.path, candidate);
    }
  };
  const stepButton = (direction: -1 | 1) => (
    <>
      {!props.params.compact && (
        <button
          type="button"
          class="btn btn--sm btn--icon"
          aria-label={`${state().field.label}: ${direction < 0 ? "-" : "+"}${state().numericStep}`}
          disabled={props.params.disabled}
          onClick={() => step(direction)}
        >
          {direction < 0 ? "−" : "+"}
        </button>
      )}
    </>
  );
  const controlProps = {
    ref: draft.ref,
    get class() {
      return ["settings-input", { "cfg-redacted": state().effectiveRedacted }];
    },
    get "aria-label"() {
      return state().field.label;
    },
    get "aria-required"() {
      return state().field.required ? ("true" as const) : undefined;
    },
    get "aria-describedby"() {
      return [state().field.helpId, state().errorId].filter(Boolean).join(" ");
    },
    "aria-invalid": "false" as const,
    get placeholder() {
      return state().placeholder;
    },
    get disabled() {
      return props.params.disabled;
    },
    get readonly() {
      return state().effectiveRedacted;
    },
    onClick: () => {
      if (!state().masked && state().sensitiveState?.isRedacted && !state().isStructuredSecretRef) {
        props.params.onToggleSensitivePath?.(props.params.path);
      }
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (
        props.stepped &&
        !props.params.compact &&
        props.params.value === undefined &&
        state().effectiveValue !== undefined &&
        event.currentTarget instanceof HTMLInputElement &&
        event.currentTarget.value === "" &&
        !event.currentTarget.validity.badInput &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        step(event.key === "ArrowUp" ? 1 : -1);
      }
    },
    onInput: (event: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      if (state().effectiveRedacted) {
        return;
      }
      const target = event.currentTarget;
      if (props.params.commitOnBlur) {
        if (!props.stepped) {
          beginScalarEdit(target, state().initialBranch);
        }
        state().revalidate(target);
        return;
      }
      if (props.inputType === "number" && target instanceof HTMLInputElement) {
        const next = resolveNumericInputState(target, props.params);
        if (draft.setValidity(target, next.message)) {
          commitScalarValue(target, next.parsed);
        }
        return;
      }
      const { textInputState, initialBranch } = state();
      const next = textInputState(target.value, beginScalarEdit(target, initialBranch));
      if (draft.setValidity(target, next.message)) {
        commitScalarValue(target, next.candidate);
      }
    },
    onChange: (event: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      if (!props.params.commitOnBlur && (props.stepped || props.inputType !== "number")) {
        commitChange(event.currentTarget, !props.stepped);
      }
    },
    onBlur: (event: FocusEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      const target = event.currentTarget;
      if (props.params.commitOnBlur && target.value !== state().renderedValue) {
        commitChange(target);
      }
      if (!props.stepped) {
        finishScalarEdit(target);
      }
    },
  };
  const control = (
    <>
      {state().multiline ? (
        <textarea {...controlProps} rows={6} style={{ "min-height": "8rem", resize: "vertical" }} />
      ) : (
        <input
          {...controlProps}
          type={state().effectiveInputType}
          min={state().constraints?.min}
          max={state().constraints?.max}
          step={state().constraints?.step}
        />
      )}
    </>
  );
  const wrappedInput = (
    <>
      {!props.stepped &&
      !state().isStructuredSecretRef &&
      (state().sensitiveState?.isSensitiveField || state().sensitiveState?.isSensitive) &&
      props.params.onToggleSensitivePath ? (
        <span class="settings-secret">
          {control}
          <SensitiveToggleButton
            path={props.params.path}
            state={state().sensitiveState!}
            disabled={props.params.disabled}
            onToggleSensitivePath={props.params.onToggleSensitivePath}
          />
        </span>
      ) : (
        control
      )}
    </>
  );
  const presentedInput = (
    <>
      {state().isPhonePresentation ? (
        <span class="settings-phone-presentation">
          {wrappedInput}
          {state().phonePresentation && (
            <span class="settings-phone-presentation__value">{state().phonePresentation}</span>
          )}
        </span>
      ) : (
        wrappedInput
      )}
    </>
  );
  return (
    <FieldRow
      {...state().field}
      errorId={state().errorId}
      errorRef={draft.errorRef}
      defaultDescription={
        state().effectiveRedacted || state().masked
          ? undefined
          : renderSchemaDefaultDescription(props.params.schema, props.params.value)
      }
      control={
        props.stepped ? (
          <>
            {stepButton(-1)}
            {control}
            {stepButton(1)}
          </>
        ) : (
          presentedInput
        )
      }
    />
  );
}

export function SelectInput(props: {
  params: ConfigNodeRenderParams & { options: unknown[] };
}): JSX.Element {
  const field = createMemo(() => {
    getLocale();
    return resolveConfigFieldPresentation(props.params);
  });
  const unset = "__unset__";
  const nullValue = "__null__";
  const canSelectNull = createMemo(
    () => props.params.schema.nullable && props.params.schema.enumIncludesNull,
  );
  const selectedValue = createMemo(() => {
    const params = props.params;
    const usingDefault = params.value === undefined && params.schema.default !== undefined;
    const resolvedValue = usingDefault ? params.schema.default : params.value;
    const currentIndex = params.options.findIndex((option) =>
      configValuesEqual(option, resolvedValue),
    );
    return usingDefault
      ? unset
      : resolvedValue === null && canSelectNull()
        ? nullValue
        : currentIndex >= 0
          ? String(currentIndex)
          : unset;
  });
  return (
    <FieldRow
      {...field()}
      defaultDescription={renderSchemaDefaultDescription(props.params.schema, props.params.value)}
      control={
        <select
          class="settings-select"
          aria-label={field().label}
          aria-required={field().required ? "true" : undefined}
          aria-describedby={field().helpId}
          disabled={props.params.disabled}
          value={selectedValue()}
          onChange={(event) => {
            const params = props.params;
            const target = event.currentTarget;
            const nextSelection = target.value;
            if (
              nextSelection === unset &&
              params.isRequired &&
              params.schema.default === undefined
            ) {
              target.value = selectedValue();
              return;
            }
            const accepted =
              nextSelection === unset
                ? params.isRequired && params.schema.default !== undefined
                  ? params.onPatch(params.path, params.schema.default)
                  : params.onRemove
                    ? params.onRemove(params.path)
                    : params.onPatch(params.path, undefined)
                : params.onPatch(
                    params.path,
                    nextSelection === nullValue ? null : params.options[Number(nextSelection)],
                  );
            if (accepted === false) {
              target.value = selectedValue();
            }
          }}
        >
          <option
            value={unset}
            disabled={props.params.isRequired && props.params.schema.default === undefined}
          >
            {props.params.schema.default !== undefined
              ? t("configForm.defaultValue", {
                  value: formatConfigValueText(props.params.schema.default),
                })
              : (hintForPath(props.params.path, props.params.hints)?.placeholder ??
                t("configForm.select"))}
          </option>
          {canSelectNull() && <option value={nullValue}>{t("configForm.nullValue")}</option>}
          <For each={props.params.options}>
            {(option, index) => (
              <option value={String(index())}>
                {configEnumOptionLabel(option, props.params.options)}
              </option>
            )}
          </For>
        </select>
      }
    />
  );
}
