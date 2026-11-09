import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { i18n } from "../i18n/index.ts";
import { isEnvPlaceholder, REDACTED_SENTINEL } from "../lib/config-form-utils.ts";
import { clearCompositionEnd, recordCompositionEnd } from "../lib/ime.ts";
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
  schemaDefaultValueText,
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
import {
  createSecretFieldHold,
  handleHeldSecretKey,
  SecretFieldFrame,
  secretInputProps,
  storedSecretState,
} from "./config-form.secret-field.tsx";
import { configFieldId, hintForPath, schemaType } from "./config-form.shared.ts";
import { SettingsSelect } from "./solid/settings-select.tsx";

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
  const hold = createSecretFieldHold(() => ({
    path: props.params.path,
    hints: props.params.hints,
    secretFields: props.stepped ? undefined : props.params.secretFields,
    stored: () => props.params.value === REDACTED_SENTINEL,
    reference: () => isSecretRefObject(props.params.value),
    label: () => resolveConfigFieldPresentation(props.params).label,
  }));
  let input: HTMLInputElement | HTMLTextAreaElement | undefined;
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
    const heldText = hold.text();
    const storedRedacted =
      (sensitiveState?.isRedacted && !masked) ||
      sensitiveState?.sentinelRedacted ||
      isStructuredSecretRef;
    // An explicit Save writes whatever replaces a stored secret, and an empty field keeps it. Only
    // plain text in the file can be replaced; a reference, or anything unproven, stays read-only,
    // since typing would swap it for plaintext in the config file.
    const { envVar, replaceable } = storedSecretState(hold, {
      stored: Boolean(sensitiveState?.sentinelRedacted),
      path,
      secretFields: params.secretFields,
      replaceStoredSecrets: params.replaceStoredSecrets,
    });
    const effectiveRedacted = storedRedacted && heldText === undefined && !replaceable;
    const placeholder = replaceable
      ? "••••••••"
      : effectiveRedacted
        ? envVar
          ? t("configForm.environmentSecret", { name: envVar })
          : isStructuredSecretRef
            ? rawAvailable
              ? t("configForm.structuredSecretRaw")
              : t("configForm.structuredSecretFile")
            : !masked && sensitiveState?.canReveal && params.onToggleSensitivePath
              ? t("configForm.redactedPlaceholder")
              : "••••••••"
        : (hint?.placeholder ??
          (!masked && schema.default !== undefined
            ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
            : props.stepped
              ? undefined
              : ""));
    const displayValue = storedRedacted
      ? ""
      : !props.stepped && isRecord(value)
        ? jsonValue(value)
        : (value ?? (params.compact ? schema.default : undefined) ?? "");
    const effectiveValue = value !== undefined ? value : schema.default;
    const initialBranch = scalarValueBranch(effectiveValue);
    const shownText = heldText ?? (typeof value === "string" ? value : "");
    // An env placeholder names a variable; it is not a secret to hide.
    const hidesText =
      hold.active() &&
      !params.revealSensitive &&
      !sensitiveState?.isRevealed &&
      !isEnvPlaceholder(shownText);
    const effectiveInputType = hold.revealed()
      ? "text"
      : masked || replaceable || hidesText
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
    const storedText = formatConfigValueText(displayValue);
    const renderedValue = heldText ?? storedText;
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
    const holdsEdit = hold.active();
    const textInputState = (raw: string, editHint: ScalarEditHint) => {
      // The sentinel only stands in for a stored secret; it is never a value to save.
      if (holdsEdit && raw.includes(REDACTED_SENTINEL)) {
        return { candidate: undefined, message: invalidString };
      }
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
      replaceable,
      hidesText,
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
      storedText,
      renderedValue,
      presentationIdentity,
      constraints,
      numericStep,
      textInputState,
      revalidate(this: void, target: HTMLInputElement | HTMLTextAreaElement): void {
        draft.setValidity(
          target,
          effectiveRedacted || (replaceable && target.value === "")
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
    onReconciled: (target, current) => {
      syncScalarEditIdentity(target, current.pathKey, current.presentationIdentity);
      if (hold.error()) {
        draft.setValidity(target, hold.error());
      }
    },
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
  const saveHeld = async () => {
    const target = input;
    if (!target) {
      return;
    }
    const next = state().textInputState(
      target.value,
      beginScalarEdit(target, state().initialBranch),
    );
    finishScalarEdit(target);
    if (!draft.setValidity(target, next.message)) {
      return;
    }
    if (await hold.save(next.candidate)) {
      target.focus();
    } else {
      draft.setValidity(target, hold.error());
    }
  };
  const onSave = () => void saveHeld();
  const cancelHeld = () => {
    hold.cancel();
    input?.focus();
  };
  const commitChange = (target: HTMLInputElement | HTMLTextAreaElement, allowClear = true) => {
    if (state().effectiveRedacted || hold.active()) {
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
          class="cfg-stepper__button"
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
    ref: (element: HTMLInputElement | HTMLTextAreaElement) => {
      input = element;
      draft.ref(element);
    },
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
    onCompositionEnd: recordCompositionEnd,
    onKeyUp: clearCompositionEnd,
    // A narrow field clips this copy, and the variable's name is what matters.
    get title() {
      return state().effectiveRedacted ? state().placeholder : undefined;
    },
    onClick: () => {
      if (
        !state().masked &&
        !state().replaceable &&
        state().sensitiveState?.canReveal &&
        state().sensitiveState?.isRedacted &&
        !state().isStructuredSecretRef
      ) {
        props.params.onToggleSensitivePath?.(props.params.path);
      }
    },
    onKeyDown: (event: KeyboardEvent) => {
      const multiline = state().multiline;
      if (handleHeldSecretKey(event, hold, { multiline, onSave, onCancel: cancelHeld })) {
        return;
      }
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
      if (hold.active()) {
        hold.edit(target.value, state().storedText);
        state().revalidate(target);
        return;
      }
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
      clearCompositionEnd(event);
      const target = event.currentTarget;
      if (props.params.commitOnBlur && target.value !== state().renderedValue) {
        commitChange(target);
      }
      if (!props.stepped) {
        finishScalarEdit(target);
      }
    },
  };
  // Secrets stay out of autofill, saved form state, spellcheck services and password managers.
  const secretProps = secretInputProps(
    () =>
      !props.stepped &&
      (hold.active() ||
        Boolean(state().sensitiveState?.isSensitiveField || state().sensitiveState?.isSensitive)),
  );
  const control = (
    <>
      {state().multiline ? (
        <textarea
          {...controlProps}
          {...secretProps}
          rows={6}
          style={{ "min-height": "8rem", resize: "vertical" }}
        />
      ) : (
        <input
          {...controlProps}
          {...secretProps}
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
      (hold.active() ||
        ((state().sensitiveState?.isSensitiveField || state().sensitiveState?.isSensitive) &&
          props.params.onToggleSensitivePath)) ? (
        <SecretFieldFrame
          hold={hold}
          control={control}
          eye={() => (
            <SensitiveToggleButton
              path={props.params.path}
              state={state().sensitiveState!}
              disabled={props.params.disabled}
              onToggleSensitivePath={props.params.onToggleSensitivePath}
            />
          )}
          hidesText={state().hidesText}
          label={state().field.label}
          disabled={props.params.disabled}
          onSave={onSave}
          onCancel={cancelHeld}
        />
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
      stacked={state().multiline}
      placement={props.stepped ? undefined : state().field.placement}
      errorId={state().errorId}
      errorRef={draft.errorRef}
      defaultValue={
        state().effectiveRedacted || state().masked
          ? undefined
          : schemaDefaultValueText(props.params.schema)
      }
      control={
        props.stepped ? (
          <span class="cfg-stepper">
            {stepButton(-1)}
            {control}
            {stepButton(1)}
          </span>
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
  const selectOptions = createMemo(() => {
    getLocale();
    const { schema, options, isRequired, path, hints } = props.params;
    return [
      {
        value: unset,
        disabled: isRequired && schema.default === undefined,
        label:
          schema.default !== undefined
            ? // A required field stores its default, so it can't promise to unset.
              t(isRequired ? "configForm.defaultOption" : "configForm.useDefaultValue", {
                value: configEnumOptionLabel(schema.default, options),
              })
            : (hintForPath(path, hints)?.placeholder ?? t("configForm.select")),
      },
      ...(canSelectNull() ? [{ value: nullValue, label: t("configForm.nullValue") }] : []),
      ...options.map((option, index) => ({
        value: String(index),
        label: configEnumOptionLabel(option, options),
      })),
    ];
  });
  return (
    <FieldRow
      {...field()}
      defaultValue={schemaDefaultValueText(props.params.schema)}
      control={
        <SettingsSelect
          aria-label={field().label}
          aria-required={field().required ? "true" : undefined}
          aria-describedby={field().helpId}
          disabled={props.params.disabled}
          value={selectedValue()}
          options={selectOptions()}
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
        />
      }
    />
  );
}
