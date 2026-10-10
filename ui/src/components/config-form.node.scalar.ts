import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { i18n, t } from "../i18n/index.ts";
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
  renderFieldRow,
  renderSchemaDefaultDescription,
  renderSensitiveToggleButton,
  resolveConfigFieldPresentation,
  wrapSensitiveControl,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
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

function createScalarValueCommitter(
  { value, path, onPatch }: Pick<ConfigNodeRenderParams, "value" | "path" | "onPatch">,
  renderedValue: string,
  revalidate: (target: HTMLInputElement) => void,
) {
  // Input and change may run before the patched draft is rendered.
  let patchedValue = value;
  return (target: HTMLInputElement, candidate: unknown, skipUnchanged = false): boolean => {
    if (skipUnchanged && configValuesEqual(patchedValue, candidate)) {
      return true;
    }
    if (onPatch(path, candidate) !== false) {
      patchedValue = candidate;
      return true;
    }
    target.value = renderedValue;
    revalidate(target);
    return false;
  };
}

export function renderTextInput(
  params: ConfigNodeRenderParams & { inputType: "text" | "number" },
): TemplateResult {
  const { schema, value, path, hints, disabled, inputType } = params;
  const hint = hintForPath(path, hints);
  const field = resolveConfigFieldPresentation(params);
  const { label, helpId } = field;
  const errorId = configFieldId(path, "scalar-error");
  const sensitiveState = getSensitiveRenderState(params);
  const isStructuredSecretRef = isSecretRefObject(value);
  const rawAvailable = params.rawAvailable ?? true;
  const masked = sensitiveState.isMasked;
  const effectiveRedacted =
    (sensitiveState.isRedacted && !masked) ||
    sensitiveState.sentinelRedacted ||
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
        : ""));
  const displayValue = effectiveRedacted
    ? ""
    : isRecord(value)
      ? jsonValue(value)
      : (value ?? (params.compact ? schema.default : undefined) ?? "");
  const effectiveValue = value !== undefined ? value : schema.default;
  const initialBranch = scalarValueBranch(effectiveValue);
  const effectiveInputType = masked
    ? "password"
    : sensitiveState.isSensitive && !effectiveRedacted
      ? "text"
      : inputType;
  const isPhonePresentation = hint?.presentation === "phone-number";
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
  const presentationIdentity = [
    effectiveRedacted ? "redacted" : "visible",
    effectiveInputType,
    isPhonePresentation ? "phone" : "plain",
    isStructuredSecretRef ? (rawAvailable ? "secret-raw" : "secret-file") : "scalar",
  ].join(":");
  const textInputState = (raw: string, editHint: ScalarEditHint) => {
    const candidate = coerceTextInputValue(raw, schema, effectiveValue, editHint);
    const valid = isSupportedConfigValueValid(schema, candidate);
    const clearOptional = raw === "" && !params.isRequired && !valid;
    return {
      candidate: clearOptional ? undefined : candidate,
      message: valid || clearOptional ? "" : t("configForm.invalidString"),
    };
  };
  const revalidate = (target: HTMLInputElement) => {
    setControlValidity(
      target,
      effectiveRedacted
        ? ""
        : inputType === "number"
          ? resolveNumericInputState(target, params).message
          : textInputState(target.value, scalarEditHintForInput(target, initialBranch)).message,
    );
  };
  const commitScalarValue = createScalarValueCommitter(params, renderedValue, revalidate);

  const commitChange = (target: HTMLInputElement) => {
    if (effectiveRedacted) {
      return;
    }
    // Change follows input on blur; only a newly normalized value needs another patch.
    const commit = (candidate: unknown) => commitScalarValue(target, candidate, true);
    if (inputType === "number") {
      applyNumericInputState(target, resolveNumericInputState(target, params), commit);
      return;
    }
    const editHint = beginScalarEdit(target, initialBranch);
    const raw = target.value;
    const rawState = textInputState(raw, editHint);
    let nextState = rawState;
    if (rawState.message || isPhonePresentation) {
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

  const inputControl = html`
    <input
      ${ref((element) => {
        syncScalarEditIdentity(element, controlPathKey, presentationIdentity);
        syncScalarInputIdentity(
          element,
          controlIdentity,
          sourceIdentity,
          controlPathKey,
          presentationIdentity,
          renderedValue,
          revalidate,
        );
      })}
      type=${effectiveInputType}
      class="settings-input${effectiveRedacted ? " cfg-redacted" : ""}"
      aria-label=${label}
      aria-describedby=${[helpId, errorId].filter(Boolean).join(" ")}
      aria-invalid="false"
      placeholder=${placeholder}
      .value=${renderedValue}
      ?disabled=${disabled}
      ?readonly=${effectiveRedacted}
      @click=${() => {
        if (
          !masked &&
          sensitiveState.isRedacted &&
          !isStructuredSecretRef &&
          params.onToggleSensitivePath
        ) {
          params.onToggleSensitivePath(path);
        }
      }}
      @input=${(event: Event) => {
        if (effectiveRedacted) {
          return;
        }
        const target = event.target as HTMLInputElement;
        if (params.commitOnBlur) {
          beginScalarEdit(target, initialBranch);
          revalidate(target);
          return;
        }
        if (inputType === "number") {
          applyNumericInputState(target, resolveNumericInputState(target, params), (candidate) =>
            commitScalarValue(target, candidate),
          );
          return;
        }
        const state = textInputState(target.value, beginScalarEdit(target, initialBranch));
        if (setControlValidity(target, state.message)) {
          commitScalarValue(target, state.candidate);
        }
      }}
      @change=${(event: Event) => {
        if (!params.commitOnBlur && inputType !== "number") {
          // SAFETY: Lit binds this handler directly to the native input.
          commitChange(event.target as HTMLInputElement);
        }
      }}
      @blur=${(event: FocusEvent) => {
        // SAFETY: Lit binds this handler directly to the native input.
        const target = event.target as HTMLInputElement;
        if (params.commitOnBlur && target.value !== renderedValue) {
          commitChange(target);
        }
        finishScalarEdit(target);
      }}
    />
  `;
  const revealToggle = isStructuredSecretRef
    ? nothing
    : renderSensitiveToggleButton({
        path,
        state: sensitiveState,
        disabled,
        onToggleSensitivePath: params.onToggleSensitivePath,
      });
  const wrappedInput = wrapSensitiveControl(
    inputControl,
    revealToggle,
    sensitiveState.isSensitiveField && params.onToggleSensitivePath !== undefined,
  );
  const presentedInput = isPhonePresentation
    ? html`
        <span class="settings-phone-presentation">
          ${wrappedInput}
          ${
            phonePresentation
              ? html`<span class="settings-phone-presentation__value">${phonePresentation}</span>`
              : nothing
          }
        </span>
      `
    : wrappedInput;
  return renderFieldRow({
    ...field,
    defaultDescription:
      effectiveRedacted || masked ? nothing : renderSchemaDefaultDescription(schema, value),
    control: presentedInput,
    errorId,
  });
}

export function renderNumberInput(params: ConfigNodeRenderParams): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const field = resolveConfigFieldPresentation(params);
  const { label, helpId } = field;
  const errorId = configFieldId(path, "scalar-error");
  const displayValue = value ?? (params.compact ? schema.default : undefined) ?? "";
  const effectiveValue = value !== undefined ? value : schema.default;
  const constraints = numericInputConstraints(schema);
  const numericStep = typeof constraints.step === "number" ? constraints.step : 1;
  const controlIdentity = params.controlIdentity ?? params.sourceIdentity ?? value;
  const sourceIdentity = params.sourceIdentity ?? value;
  const controlPathKey = configFieldId(
    path.filter((segment) => typeof segment === "string"),
    "scalar-identity",
  );
  const renderedValue = formatConfigValueText(displayValue);
  const revalidate = (target: HTMLInputElement) => {
    setControlValidity(target, resolveNumericInputState(target, params).message);
  };
  const commitScalarValue = createScalarValueCommitter(params, renderedValue, revalidate);

  const commitChange = (target: HTMLInputElement, allowClear: boolean) => {
    const state = resolveNumericInputState(target, params);
    if (state.parsed !== undefined) {
      state.parsed = normalizeNumericValue(state.parsed, schema);
      state.message = numericConstraintMessage(state.parsed, schema);
      target.value = formatConfigValueText(state.parsed);
    }
    if (setControlValidity(target, state.message) && (allowClear || state.parsed !== undefined)) {
      commitScalarValue(target, state.parsed, true);
    }
  };

  // Touch devices and some browsers hide native number spinners; keep explicit
  // adjust buttons so schema-sized edits stay possible without typing.
  const step = (direction: -1 | 1) => {
    if (disabled) {
      return;
    }
    const current = Number(effectiveValue);
    const base = Number.isFinite(current) ? current : 0;
    const candidate = normalizeNumericValue(base + direction * numericStep, schema);
    if (isSupportedConfigValueValid(schema, candidate)) {
      onPatch(path, candidate);
    }
  };
  const renderStepButton = (direction: -1 | 1) =>
    params.compact
      ? nothing
      : html` <button
          type="button"
          class="btn btn--sm btn--icon"
          aria-label=${`${label}: ${direction < 0 ? "-" : "+"}${numericStep}`}
          ?disabled=${disabled}
          @click=${() => step(direction)}
        >
          ${direction < 0 ? "−" : "+"}
        </button>`;
  const control = html`
    ${renderStepButton(-1)}
    <input
      ${ref((element) =>
        syncScalarInputIdentity(
          element,
          controlIdentity,
          sourceIdentity,
          controlPathKey,
          "number",
          renderedValue,
          revalidate,
        ),
      )}
      type="number"
      class="settings-input"
      aria-label=${label}
      aria-describedby=${[helpId, errorId].filter(Boolean).join(" ")}
      aria-invalid="false"
      placeholder=${
        hintForPath(path, hints)?.placeholder ??
        (schema.default !== undefined
          ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
          : nothing)
      }
      min=${constraints.min ?? nothing}
      max=${constraints.max ?? nothing}
      step=${constraints.step}
      .value=${renderedValue}
      ?disabled=${disabled}
      @keydown=${(event: KeyboardEvent) => {
        // Compact inputs display the default as their value, so native stepping
        // owns the current draft; only placeholder defaults need manual stepping.
        if (
          !params.compact &&
          value === undefined &&
          effectiveValue !== undefined &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          step(event.key === "ArrowUp" ? 1 : -1);
        }
      }}
      @input=${(event: Event) => {
        const target = event.target as HTMLInputElement;
        if (params.commitOnBlur) {
          revalidate(target);
          return;
        }
        applyNumericInputState(target, resolveNumericInputState(target, params), (candidate) =>
          commitScalarValue(target, candidate),
        );
      }}
      @change=${(event: Event) => {
        if (!params.commitOnBlur) {
          commitChange(event.target as HTMLInputElement, false);
        }
      }}
      @blur=${(event: FocusEvent) => {
        // SAFETY: Lit binds this handler directly to the native number input.
        const target = event.target as HTMLInputElement;
        if (params.commitOnBlur && target.value !== renderedValue) {
          commitChange(target, true);
        }
      }}
    />
    ${renderStepButton(1)}
  `;

  return renderFieldRow({
    ...field,
    defaultDescription: renderSchemaDefaultDescription(schema, value),
    control,
    errorId,
  });
}

export function renderSelect(
  params: ConfigNodeRenderParams & { options: unknown[] },
): TemplateResult {
  const { schema, value, path, hints, disabled, options, onPatch } = params;
  const field = resolveConfigFieldPresentation(params);
  const { label, helpId } = field;
  const usingDefault = value === undefined && schema.default !== undefined;
  const resolvedValue = usingDefault ? schema.default : value;
  const currentIndex = options.findIndex((option) => configValuesEqual(option, resolvedValue));
  const unset = "__unset__";
  const nullValue = "__null__";
  const canSelectNull = schema.nullable && schema.enumIncludesNull;
  const selectedValue = usingDefault
    ? unset
    : resolvedValue === null && canSelectNull
      ? nullValue
      : currentIndex >= 0
        ? String(currentIndex)
        : unset;

  const control = html`
    <select
      class="settings-select"
      aria-label=${label}
      aria-describedby=${helpId ?? nothing}
      ?disabled=${disabled}
      .value=${selectedValue}
      @change=${(event: Event) => {
        const target = event.target as HTMLSelectElement;
        const nextSelection = target.value;
        if (nextSelection === unset && params.isRequired && schema.default === undefined) {
          target.value = selectedValue;
          return;
        }
        const accepted =
          nextSelection === unset
            ? params.isRequired && schema.default !== undefined
              ? onPatch(path, structuredClone(schema.default))
              : params.onRemove
                ? params.onRemove(path)
                : onPatch(path, undefined)
            : onPatch(path, nextSelection === nullValue ? null : options[Number(nextSelection)]);
        if (accepted === false) {
          target.value = selectedValue;
        }
      }}
    >
      <option
        value=${unset}
        ?selected=${selectedValue === unset}
        ?disabled=${params.isRequired && schema.default === undefined}
      >
        ${
          schema.default !== undefined
            ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
            : (hintForPath(path, hints)?.placeholder ?? t("configForm.select"))
        }
      </option>
      ${
        canSelectNull
          ? html`
              <option value=${nullValue} ?selected=${selectedValue === nullValue}>
                ${t("configForm.nullValue")}
              </option>
            `
          : nothing
      }
      ${options.map(
        (option, index) => html`
          <option value=${String(index)} ?selected=${selectedValue === String(index)}>
            ${configEnumOptionLabel(option, options)}
          </option>
        `,
      )}
    </select>
  `;

  return renderFieldRow({
    ...field,
    defaultDescription: renderSchemaDefaultDescription(schema, value),
    control,
  });
}
