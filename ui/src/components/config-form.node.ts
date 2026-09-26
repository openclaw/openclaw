import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import {
  resolveStructuredDraftInitialValue,
  type ConfigFormStructuredDraftProps,
} from "./config-form-structured-draft.ts";
import { renderArray, renderObject } from "./config-form.node.collection.ts";
import { renderJsonTextarea } from "./config-form.node.json.ts";
import { renderNumberInput, renderSelect, renderTextInput } from "./config-form.node.scalar.ts";
import {
  renderFieldRow,
  isAnySchema,
  isSecretRefObject,
  renderSchemaDefaultDescription,
  renderSegmentedControl,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSearch,
  resolveConfigFieldMeta as resolveFieldMeta,
} from "./config-form.search.ts";
import { hintForPath, pathKey, schemaType } from "./config-form.shared.ts";
import { renderSettingsToggle, renderSettingsToggleRow } from "./settings-ui.ts";

export function renderNode(params: ConfigNodeRenderParams): TemplateResult | typeof nothing {
  const { schema, value, path, hints, unsupported, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const type = schemaType(schema);
  const { label, help } = resolveFieldMeta(path, schema, hints);
  const key = pathKey(path);
  const criteria = params.searchCriteria;

  if (
    unsupported.has(key) ||
    [...unsupported].some((pattern) => {
      if (!pattern.includes("*")) {
        return false;
      }
      const segments = pattern.split(".");
      // Use the original segments: dynamic model/provider keys may contain dots.
      return (
        segments.length === path.length &&
        segments.every((segment, index) => segment === "*" || segment === String(path[index]))
      );
    })
  ) {
    return renderFieldRow({
      label,
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedNode"),
    });
  }
  if (
    criteria &&
    hasSearchCriteria(criteria) &&
    !matchesNodeSearch({ schema, value, path, hints, criteria })
  ) {
    return nothing;
  }
  const structuredDraftValue = resolveStructuredDraftInitialValue(params);
  if (structuredDraftValue !== undefined) {
    const props: ConfigFormStructuredDraftProps = {
      identity: JSON.stringify(path.filter((segment) => typeof segment === "string")),
      sourceIdentity: params.sourceIdentity ?? value,
      initialValue: structuredDraftValue,
      params,
      renderNode,
    };
    return html`
      <openclaw-config-form-structured-draft
        class="cfg-structured-draft"
        .props=${props}
      ></openclaw-config-form-structured-draft>
    `;
  }

  const renderOptions = (options: unknown[], nullable = false) =>
    options.length > 5 || nullable
      ? renderSelect({ ...params, options })
      : renderFieldRow({
          label,
          help,
          defaultDescription: renderSchemaDefaultDescription(schema, value),
          showLabel,
          control: renderSegmentedControl({
            options,
            resolvedValue: value !== undefined ? value : schema.default,
            disabled,
            ariaLabel: label,
            descriptionId: params.descriptionId,
            onSelect: (option) => onPatch(path, option),
          }),
        });

  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf ?? schema.oneOf ?? [];
    const nonNull = variants.filter(
      (variant) =>
        !(
          variant.type === "null" ||
          (Array.isArray(variant.type) && variant.type.includes("null"))
        ),
    );

    if (nonNull.length === 1) {
      const selectedSchema = nonNull[0];
      return selectedSchema ? renderNode({ ...params, schema: selectedSchema }) : nothing;
    }

    const extractLiteral = (variant: (typeof nonNull)[number]): unknown => {
      if (variant.const !== undefined) {
        return variant.const;
      }
      if (variant.enum && variant.enum.length === 1) {
        return variant.enum[0];
      }
      return undefined;
    };
    const literals = nonNull.map(extractLiteral);
    const allLiterals = literals.every((literal) => literal !== undefined);

    if (allLiterals && literals.length > 0) {
      return renderOptions(literals);
    }

    const primitiveTypes = new Set(nonNull.map((variant) => schemaType(variant)).filter(Boolean));
    const normalizedTypes = new Set(
      [...primitiveTypes].map((variantType) =>
        variantType === "integer" ? "number" : variantType,
      ),
    );

    if (
      params.maskSensitive === true &&
      Array.isArray(schema.type) &&
      normalizedTypes.size === 2 &&
      normalizedTypes.has("string") &&
      normalizedTypes.has("object") &&
      (value === undefined || typeof value === "string" || isSecretRefObject(value))
    ) {
      return renderTextInput({ ...params, inputType: "text" });
    }

    if (
      [...normalizedTypes].every((variantType) =>
        ["string", "number", "boolean"].includes(variantType as string),
      )
    ) {
      const hasString = normalizedTypes.has("string");
      const hasNumber = normalizedTypes.has("number");
      const hasBoolean = normalizedTypes.has("boolean");

      if (hasBoolean && normalizedTypes.size === 1) {
        return renderNode({
          ...params,
          schema: { ...schema, type: "boolean", anyOf: undefined, oneOf: undefined },
        });
      }

      if (hasString || hasNumber) {
        return renderTextInput({
          ...params,
          inputType: hasNumber && !hasString ? "number" : "text",
        });
      }
    }

    // Complex union (e.g. array | object) — render as JSON textarea
    return renderJsonTextarea(params);
  }

  // Nullable enums use the dropdown's distinct null and unset choices.
  if (schema.enum) {
    return renderOptions(schema.enum, schema.nullable && schema.enumIncludesNull);
  }

  if (type === "object") {
    return renderObject(params, renderNode);
  }

  if (type === "array") {
    return renderArray(params, renderNode);
  }

  if (type === "boolean") {
    // A placeholder names an optional boolean's inherited state; a toggle
    // cannot distinguish an unset override from an explicit false.
    if (!params.isRequired && hintForPath(path, hints)?.placeholder) {
      return renderSelect({ ...params, options: [true, false] });
    }
    const displayValue =
      typeof value === "boolean"
        ? value
        : typeof schema.default === "boolean"
          ? schema.default
          : false;
    const onChange = (checked: boolean) => onPatch(path, checked);
    if (params.compact) {
      return renderFieldRow({
        label,
        help,
        showLabel,
        control: html`<input
          type="checkbox"
          aria-label=${label}
          aria-describedby=${params.descriptionId ?? nothing}
          .checked=${displayValue}
          ?disabled=${disabled}
          @change=${(event: Event) => {
            // SAFETY: Lit binds this handler directly to the native checkbox.
            const input = event.currentTarget as HTMLInputElement;
            if (onChange(input.checked) === false) {
              input.checked = displayValue;
            }
          }}
        />`,
      });
    }
    if (!showLabel) {
      // Control-only contexts (array items, map values) have no visible title,
      // so the switch keeps its accessible name from the field label.
      return renderFieldRow({
        label,
        help,
        showLabel,
        control: renderSettingsToggle({
          checked: displayValue,
          disabled,
          ariaLabel: label,
          onChange,
        }),
      });
    }
    const description =
      help || schema.default !== undefined
        ? html`
            ${help ?? nothing} ${help && schema.default !== undefined ? html`<br />` : nothing}
            ${renderSchemaDefaultDescription(schema, value)}
          `
        : undefined;
    return renderSettingsToggleRow({
      title: label,
      description,
      checked: displayValue,
      disabled,
      onChange,
    });
  }

  if (type === "number" || type === "integer") {
    return renderNumberInput(params);
  }

  if (type === "string") {
    return renderTextInput({ ...params, inputType: "text" });
  }

  if (isAnySchema(schema)) {
    return renderJsonTextarea(params);
  }

  return renderFieldRow({
    label,
    showLabel: true,
    control: nothing,
    error: t("configForm.unsupportedType", { type: String(type) }),
  });
}
