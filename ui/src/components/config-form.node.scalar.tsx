import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { For, createEffect, createMemo, untrack } from "solid-js";
import { i18n } from "../i18n/index.ts";
import { getLocale, t } from "../lib/reactive/i18n.ts";
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
  syncScalarInputIdentity,
  setControlValidity,
  type ScalarEditHint,
} from "./config-form.scalar-edit.ts";
import { configFieldId, hintForPath, schemaType } from "./config-form.shared.ts";

function coerceTextInputValue(
  value: string,
  schema: ConfigNodeRenderParams["schema"],
  currentValue?: unknown,
  editHint?: ScalarEditHint,
): string | number | boolean | undefined {
  const trimmed = value.trim();
  const variants = schema.anyOf ?? schema.oneOf ?? [];
  const stringCandidateValid = isSupportedConfigValueValid(schema, value);
  const currentBranch = editHint ? editHint.branch : scalarValueBranch(currentValue);
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

function numericConstraintMessage(value: number, schema: ConfigNodeRenderParams["schema"]): string {
  return isSupportedConfigValueValid(schema, value) ? "" : t("configForm.invalidNumber");
}

type NumericInputState = { parsed?: number; message: string };

// Partial numeric text ("3.", "-", "1e") reports value === "" with
// validity.badInput set. Treating it as an intentional clear committed
// undefined mid-keystroke, wiping the stored value and the user's input.
function resolveNumericInputState(
  target: HTMLInputElement,
  { schema, isRequired }: Pick<ConfigNodeRenderParams, "schema" | "isRequired">,
): NumericInputState {
  const raw = target.value;
  if (raw.trim() === "") {
    return {
      message: target.validity.badInput || isRequired === true ? t("configForm.invalidNumber") : "",
    };
  }
  const parsed = coerceConfigFormNumberString(raw, schemaType(schema) === "integer");
  return typeof parsed === "number"
    ? { parsed, message: numericConstraintMessage(parsed, schema) }
    : { message: t("configForm.invalidNumber") };
}

function applyNumericInputState(
  target: HTMLInputElement,
  state: NumericInputState,
  commit: (candidate: unknown) => unknown,
): void {
  if (setControlValidity(target, state.message)) {
    commit(state.parsed);
  }
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
  let input!: HTMLInputElement;
  let initialized = false;
  const state = createMemo(() => {
    getLocale();
    const params = props.params;
    const { schema, value, path, hints } = params;
    const hint = hintForPath(path, hints);
    const field = resolveConfigFieldPresentation(params);
    const errorId = configFieldId(path, "scalar-error");
    const sensitiveState = props.stepped ? undefined : getSensitiveRenderState(params);
    const isStructuredSecretRef = !props.stepped && isSecretRefObject(value);
    const rawAvailable = params.rawAvailable ?? true;
    const masked = sensitiveState?.isMasked;
    const effectiveRedacted = Boolean(
      (sensitiveState?.isRedacted && !masked) ||
      sensitiveState?.sentinelRedacted ||
      isStructuredSecretRef,
    );
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
    const isPhonePresentation = !props.stepped && hint?.presentation === "phone-number";
    const phonePresentation =
      isPhonePresentation && !effectiveRedacted && !masked && typeof value === "string"
        ? formatInternationalPhoneNumberForDisplay(value, i18n.getLocale())
        : undefined;
    const controlIdentity = params.controlIdentity ?? params.sourceIdentity ?? value;
    const sourceIdentity = params.sourceIdentity ?? value;
    const controlPathKey = configFieldId(
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
      isPhonePresentation,
      phonePresentation,
      controlIdentity,
      sourceIdentity,
      controlPathKey,
      renderedValue,
      presentationIdentity,
      constraints,
      numericStep,
    };
  });
  const textInputState = (raw: string, editHint: ScalarEditHint) => {
    const candidate = coerceTextInputValue(
      raw,
      props.params.schema,
      state().effectiveValue,
      editHint,
    );
    const valid = isSupportedConfigValueValid(props.params.schema, candidate);
    const clearOptional = raw === "" && !props.params.isRequired && !valid;
    return {
      candidate: clearOptional ? undefined : candidate,
      message: valid || clearOptional ? "" : t("configForm.invalidString"),
    };
  };
  const revalidate = (target: HTMLInputElement) => {
    setControlValidity(
      target,
      state().effectiveRedacted
        ? ""
        : props.inputType === "number"
          ? resolveNumericInputState(target, props.params).message
          : textInputState(target.value, scalarEditHintForInput(target, state().initialBranch))
              .message,
    );
  };
  createEffect(
    () => ({ current: state(), stepped: props.stepped }),
    ({ current, stepped }) => {
      if (!stepped) {
        syncScalarEditIdentity(input, current.controlPathKey, current.presentationIdentity);
      }
      // The first value is set only once; subsequent updates are owned by the
      // existing draft-preserving scalar identity contract.
      if (!initialized) {
        input.value = current.renderedValue;
        initialized = true;
      }
      syncScalarInputIdentity(
        input,
        current.controlIdentity,
        current.sourceIdentity,
        current.controlPathKey,
        current.presentationIdentity,
        current.renderedValue,
        revalidate,
      );
    },
  );
  let patchSource = untrack(() => props.params.value);
  let patchedValue = patchSource;
  const commitScalarValue = (
    target: HTMLInputElement,
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
    revalidate(target);
    return false;
  };
  const commitChange = (target: HTMLInputElement, allowClear = true) => {
    if (state().effectiveRedacted) {
      return;
    }
    const commit = (candidate: unknown) => commitScalarValue(target, candidate, true);
    if (props.inputType === "number") {
      const next = resolveNumericInputState(target, props.params);
      if (props.stepped && next.parsed !== undefined) {
        next.parsed = normalizeNumericValue(next.parsed, props.params.schema);
        next.message = numericConstraintMessage(next.parsed, props.params.schema);
        target.value = formatConfigValueText(next.parsed);
      }
      if (setControlValidity(target, next.message) && (allowClear || next.parsed !== undefined)) {
        commit(next.parsed);
      }
      return;
    }
    const editHint = beginScalarEdit(target, state().initialBranch);
    const raw = target.value;
    const rawState = textInputState(raw, editHint);
    let nextState = rawState;
    if (rawState.message || state().isPhonePresentation) {
      const normalized = raw.trim();
      nextState = textInputState(normalized, editHint);
      if (!nextState.message) {
        target.value = normalized;
      }
    }
    setControlValidity(target, nextState.message ? rawState.message : "");
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
  const control = (
    <input
      ref={(element) => {
        input = element;
      }}
      type={state().effectiveInputType}
      class={["settings-input", { "cfg-redacted": state().effectiveRedacted }]}
      aria-label={state().field.label}
      aria-describedby={[state().field.helpId, state().errorId].filter(Boolean).join(" ")}
      aria-invalid="false"
      placeholder={state().placeholder}
      min={state().constraints?.min}
      max={state().constraints?.max}
      step={state().constraints?.step}
      disabled={props.params.disabled}
      readOnly={state().effectiveRedacted}
      onClick={() => {
        if (
          !state().masked &&
          state().sensitiveState?.isRedacted &&
          !state().isStructuredSecretRef
        ) {
          props.params.onToggleSensitivePath?.(props.params.path);
        }
      }}
      onKeyDown={(event) => {
        if (
          props.stepped &&
          !props.params.compact &&
          props.params.value === undefined &&
          state().effectiveValue !== undefined &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          step(event.key === "ArrowUp" ? 1 : -1);
        }
      }}
      onInput={(event) => {
        if (state().effectiveRedacted) {
          return;
        }
        const target = event.currentTarget;
        if (props.params.commitOnBlur) {
          if (!props.stepped) {
            beginScalarEdit(target, state().initialBranch);
          }
          revalidate(target);
          return;
        }
        if (props.inputType === "number") {
          applyNumericInputState(
            target,
            resolveNumericInputState(target, props.params),
            (candidate) => commitScalarValue(target, candidate),
          );
          return;
        }
        const next = textInputState(target.value, beginScalarEdit(target, state().initialBranch));
        if (setControlValidity(target, next.message)) {
          commitScalarValue(target, next.candidate);
        }
      }}
      onChange={(event) => {
        if (!props.params.commitOnBlur && (props.stepped || props.inputType !== "number")) {
          commitChange(event.currentTarget, !props.stepped);
        }
      }}
      onBlur={(event) => {
        const target = event.currentTarget;
        if (props.params.commitOnBlur && target.value !== state().renderedValue) {
          commitChange(target);
        }
        if (!props.stepped) {
          finishScalarEdit(target);
        }
      }}
    />
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
      label={state().field.label}
      help={state().field.help}
      helpId={state().field.helpId}
      showLabel={state().field.showLabel}
      errorId={state().errorId}
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
      label={field().label}
      help={field().help}
      helpId={field().helpId}
      showLabel={field().showLabel}
      defaultDescription={renderSchemaDefaultDescription(props.params.schema, props.params.value)}
      control={
        <select
          class="settings-select"
          aria-label={field().label}
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
                  ? params.onPatch(params.path, structuredClone(params.schema.default))
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
