import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { copyWithPathPatch, removePathValue, setPathValue } from "../lib/config-form-utils.ts";
import { ConfigFormArrayIdentity } from "./config-form-array-identity.ts";
import {
  openCollectionDraft,
  type ConfigFormCollectionDraftCommit,
  type ConfigFormCollectionDraftProps,
} from "./config-form-collection-draft.ts";
import { arrayItemSchema } from "./config-form.array-items.ts";
import {
  arrayConstraintCandidates,
  arrayInputConstraints,
  canApplyArrayCandidate,
  canApplyObjectCandidate,
  configValuesEqual,
  defaultValue,
  isSupportedConfigValueValid,
  isObjectPropertyNameValid,
  MAX_AUTO_ARRAY_DEFAULT_ITEMS,
  NO_SAFE_DEFAULT,
  objectAdditionalPropertiesSchema,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.constraints.ts";
import { renderMapField } from "./config-form.node.collection-map.ts";
import {
  configChildRenderOptions,
  getSensitiveRenderState,
  renderCollectionRemoveButton,
  renderFieldRow,
  renderSchemaDefaultDescription,
  type ConfigNodeRenderer,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSelf,
  resolveConfigFieldMeta as resolveFieldMeta,
} from "./config-form.search.ts";
import { configFieldId, hintForPath, type JsonSchema } from "./config-form.shared.ts";
import { renderSettingsEmpty } from "./settings-ui.ts";

const UNSET_ARRAY_SOURCE_IDENTITY = Symbol("unset-array-source");
const UNSET_MAP_SOURCE_IDENTITY = Symbol("unset-map-source");

export function resolveConfigObjectFields(params: ConfigNodeRenderParams) {
  const { schema, value, path, hints, onPatch, onRemove, searchCriteria } = params;
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;
  const inherited = value === undefined && schema.default !== undefined;
  const fallback = inherited ? schema.default : value;
  const objectSourceIdentity = fallback === undefined ? UNSET_MAP_SOURCE_IDENTITY : fallback;
  const objectValue = asNonArrayRecord(fallback);
  const entries = objectPropertyKeys(schema)
    .map((key) => [key, objectPropertySchema(schema, key)] as const)
    .filter((entry): entry is readonly [string, ConfigNodeRenderParams["schema"]] =>
      Boolean(entry[1]),
    );
  const requiredKeys = requiredPropertyKeys(schema);

  const sorted = entries.toSorted((left, right) => {
    const leftOrder = hintForPath([...path, left[0]], hints)?.order ?? 0;
    const rightOrder = hintForPath([...path, right[0]], hints)?.order ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left[0].localeCompare(right[0]);
  });

  const reservedKeys = new Set(entries.map(([key]) => key));
  const additionalProperties = objectAdditionalPropertiesSchema(schema);
  const allowExtra = Boolean(additionalProperties) && typeof additionalProperties === "object";
  const patchObjectChild = (childPath: Array<string | number>, childValue: unknown) => {
    if (
      childPath.length < path.length ||
      !path.every((segment, index) => segment === childPath[index])
    ) {
      return false;
    }
    let candidate: Record<string, unknown>;
    const relativePath = childPath.slice(path.length);
    if (relativePath.length === 0) {
      if (!isRecord(childValue)) {
        return false;
      }
      candidate = childValue;
    } else {
      try {
        candidate = structuredClone(objectValue);
      } catch {
        return false;
      }
      if (childValue === undefined) {
        removePathValue(candidate, relativePath);
      } else {
        setPathValue(candidate, relativePath, childValue);
      }
    }
    if (!canApplyObjectCandidate(schema, objectValue, candidate)) {
      return false;
    }
    if (inherited) {
      return onPatch(path, candidate) !== false;
    }
    const accepted =
      childValue === undefined && onRemove ? onRemove(childPath) : onPatch(childPath, childValue);
    return accepted !== false;
  };

  return {
    fields: sorted.map(([propertyKey, node]) => {
      const hasInheritedChild = inherited && Object.hasOwn(objectValue, propertyKey);
      return Object.assign(configChildRenderOptions(params), {
        schema: hasInheritedChild ? { ...node, default: objectValue[propertyKey] } : node,
        value: inherited ? undefined : objectValue[propertyKey],
        path: [...path, propertyKey],
        isRequired: requiredKeys.has(propertyKey),
        sourceIdentity: inherited ? undefined : objectValue[propertyKey],
        controlIdentity: params.controlIdentity ?? objectValue,
        searchCriteria: childSearchCriteria,
        onPatch: patchObjectChild,
      }) satisfies ConfigNodeRenderParams;
    }),
    additional: allowExtra
      ? {
          ...params,
          schema: additionalProperties,
          value: objectValue,
          sourceIdentity: objectSourceIdentity,
          reservedKeys,
          validateKey: (key: string) => isObjectPropertyNameValid(schema, key),
          searchCriteria: childSearchCriteria,
          onPatch: patchObjectChild,
        }
      : null,
  };
}

export function renderObject(
  params: ConfigNodeRenderParams,
  renderNode: ConfigNodeRenderer,
): TemplateResult {
  const { schema, path, hints } = params;
  const { label, help } = resolveFieldMeta(path, schema, hints);
  const object = resolveConfigObjectFields(params);
  const fields = html`
    ${object.fields.map((field) => renderNode(field))}
    ${object.additional ? renderMapField(object.additional, renderNode) : nothing}
  `;

  // Top-level objects and label-less contexts emit rows directly into the
  // surrounding settings-group so row dividers stay sibling-driven.
  if (path.length === 1 || params.showLabel === false) {
    return fields;
  }

  return html`
    <details class="cfg-object cfg-block" ?open=${path.length <= 2}>
      <summary class="settings-row cfg-object__summary">
        <div class="settings-row__text">
          <span class="settings-row__title">${label}</span>
          ${help ? html`<span class="settings-row__desc">${help}</span>` : nothing}
        </div>
        <div class="settings-row__control">
          <span class="settings-row__chevron cfg-object__chevron">${icons.chevronRight}</span>
        </div>
      </summary>
      <div class="settings-subrows">${fields}</div>
    </details>
  `;
}

class ConfigFormArrayDirective extends Directive {
  private rows = new ConfigFormArrayIdentity();
  private field = "";

  render(params: ConfigNodeRenderParams, renderNode: ConfigNodeRenderer): TemplateResult {
    // Keyed parents carry row identity. Indices still select patch destinations,
    // but moving a row must not retire its nested field editors.
    const field = JSON.stringify(params.path.filter((segment) => typeof segment === "string"));
    if (field !== this.field) {
      this.rows = new ConfigFormArrayIdentity();
      this.field = field;
    }
    return renderArrayContent(params, renderNode, this.rows);
  }
}

const arrayDirective = directive(ConfigFormArrayDirective);

export function renderArray(params: ConfigNodeRenderParams, renderNode: ConfigNodeRenderer) {
  return html`${arrayDirective(params, renderNode)}`;
}

function renderArrayContent(
  params: ConfigNodeRenderParams,
  renderNode: ConfigNodeRenderer,
  rows: ConfigFormArrayIdentity,
): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch, searchCriteria } = params;
  const showLabel = params.showLabel ?? true;
  const showHeaderMeta = params.showHeaderMeta ?? showLabel;
  const { label, help } = resolveFieldMeta(path, schema, hints);
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;

  const tupleItems = Array.isArray(schema.items) ? schema.items : undefined;
  const itemsSchema = Array.isArray(schema.items) ? (schema.items[0] ?? {}) : schema.items;
  if (!itemsSchema) {
    return renderFieldRow({
      label,
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedArray"),
    });
  }

  const inherited = value === undefined && Array.isArray(schema.default);
  const arraySource = Array.isArray(value)
    ? value
    : Array.isArray(schema.default)
      ? schema.default
      : undefined;
  const arrayValue = arraySource ?? [];
  const arraySourceIdentity = arraySource ?? UNSET_ARRAY_SOURCE_IDENTITY;
  const defaultDescription = getSensitiveRenderState({ ...params, value: arrayValue }).isRedacted
    ? nothing
    : renderSchemaDefaultDescription(schema, value);
  const rowIdentities = rows.read(arrayValue);
  const patch = (nextValue: unknown[], identities: readonly symbol[]) =>
    rows.patch(nextValue, identities, (next) => onPatch(path, next));
  const {
    minItems: minimumItems,
    maxItems: maximumItems,
    uniqueItems,
  } = arrayInputConstraints(schema);
  const itemSchemaAt = (index: number): JsonSchema =>
    arrayItemSchema(schema, index) ?? (tupleItems ? {} : itemsSchema);
  const requiredAppendCount = Math.max(1, minimumItems - arrayValue.length);
  const autoAppendCount =
    requiredAppendCount > MAX_AUTO_ARRAY_DEFAULT_ITEMS ? 1 : requiredAppendCount;
  const generatedItems: unknown[] = [];
  for (let offset = 0; offset < autoAppendCount; offset += 1) {
    const generatedDefault = defaultValue(itemSchemaAt(arrayValue.length + offset));
    if (generatedDefault === NO_SAFE_DEFAULT) {
      generatedItems.length = 0;
      break;
    }
    generatedItems.push(generatedDefault);
  }
  const generatedCandidate =
    generatedItems.length === autoAppendCount ? [...arrayValue, ...generatedItems] : undefined;
  const autoCandidate =
    generatedCandidate !== undefined &&
    !uniqueItems &&
    (maximumItems === undefined || generatedCandidate.length <= maximumItems) &&
    (generatedCandidate.length < minimumItems ||
      isSupportedConfigValueValid(schema, generatedCandidate))
      ? generatedCandidate
      : undefined;

  const currentValueValid = isSupportedConfigValueValid(schema, arrayValue);
  const constrainedCandidate = arrayConstraintCandidates(schema).find(
    (candidate) =>
      isSupportedConfigValueValid(schema, candidate) &&
      (value === undefined ||
        !currentValueValid ||
        (candidate.length > arrayValue.length &&
          arrayValue.every((entry, index) => configValuesEqual(entry, candidate[index])))),
  );
  const wholeArrayDefault =
    constrainedCandidate ??
    (value === undefined &&
    params.isRequired &&
    maximumItems === 0 &&
    isSupportedConfigValueValid(schema, [])
      ? []
      : undefined);
  const atomicCandidate = wholeArrayDefault && structuredClone(wholeArrayDefault);
  const canAppend = maximumItems === undefined || arrayValue.length < maximumItems;
  const requiresDraft = atomicCandidate === undefined && autoCandidate === undefined;
  const nextItemSchema = itemSchemaAt(arrayValue.length);
  const draftId = configFieldId(path, "array-draft");
  const draftProps: ConfigFormCollectionDraftProps = {
    schema: nextItemSchema,
    label,
    disabled: disabled || !canAppend,
    identity: JSON.stringify(path.filter((segment) => typeof segment === "string")),
    sourceIdentity: arraySourceIdentity,
    existingValues: uniqueItems ? arrayValue : undefined,
    validateValue: (candidate) => {
      const nextValue = [...arrayValue, candidate];
      return (
        (maximumItems === undefined || nextValue.length <= maximumItems) &&
        (nextValue.length < minimumItems || isSupportedConfigValueValid(schema, nextValue))
      );
    },
  };
  const patchArrayItem = (childPath: Array<string | number>, childValue: unknown) => {
    if (
      childPath.length <= path.length ||
      !path.every((segment, index) => segment === childPath[index])
    ) {
      return false;
    }
    const relativePath = childPath.slice(path.length);
    const itemIndex = relativePath[0];
    if (typeof itemIndex !== "number" || itemIndex < 0 || itemIndex >= arrayValue.length) {
      return false;
    }
    const nextValue = [...arrayValue];
    const itemPath = relativePath.slice(1);
    if (itemPath.length === 0) {
      if (childValue === undefined) {
        return false;
      }
      nextValue[itemIndex] = childValue;
    } else {
      const nextItem = copyWithPathPatch(arrayValue[itemIndex], itemPath, childValue);
      if (!nextItem.ok) {
        return false;
      }
      nextValue[itemIndex] = nextItem.value;
    }
    if (canApplyArrayCandidate(schema, arrayValue, nextValue, uniqueItems, true)) {
      return patch(nextValue, rowIdentities);
    }
    return false;
  };

  return html`
    <div class="cfg-block cfg-array">
      <div class="settings-row">
        <div class="settings-row__text">
          ${showLabel ? html`<span class="settings-row__title">${label}</span>` : nothing}
          ${
            showHeaderMeta && help ? html`<span class="settings-row__desc">${help}</span>` : nothing
          }
          ${
            showHeaderMeta && defaultDescription !== nothing
              ? html`<span class="settings-row__desc">${defaultDescription}</span>`
              : nothing
          }
        </div>
        <div class="settings-row__control">
          ${
            params.compact
              ? nothing
              : html`
                  <span class="settings-row__value"
                    >${t(
                      arrayValue.length === 1 ? "configForm.itemCountOne" : "configForm.itemCount",
                      {
                        count: String(arrayValue.length),
                      },
                    )}</span
                  >
                `
          }
          <button
            type="button"
            class=${params.compact ? "btn btn--sm btn--icon" : "btn btn--sm"}
            aria-label=${t("configForm.add")}
            aria-controls=${draftId}
            ?disabled=${disabled || (!canAppend && atomicCandidate === undefined)}
            @click=${(event: Event) => {
              if (atomicCandidate) {
                if (onPatch(path, atomicCandidate) === false) {
                  openCollectionDraft(event, draftId);
                }
              } else if (requiresDraft) {
                openCollectionDraft(event, draftId);
              } else if (autoCandidate) {
                const appended = Array.from(
                  { length: autoCandidate.length - arrayValue.length },
                  () => Symbol("array-row"),
                );
                if (!patch(autoCandidate, [...rowIdentities, ...appended])) {
                  openCollectionDraft(event, draftId);
                }
              }
            }}
          >
            ${params.compact ? icons.plus : t("configForm.add")}
          </button>
        </div>
      </div>
      <openclaw-config-form-collection-draft
        id=${draftId}
        .props=${draftProps}
        @config-collection-draft-commit=${(event: CustomEvent<ConfigFormCollectionDraftCommit>) => {
          const nextValue = [...arrayValue, event.detail.value];
          const canApply =
            !(
              uniqueItems && arrayValue.some((item) => configValuesEqual(item, event.detail.value))
            ) &&
            (maximumItems === undefined || arrayValue.length < maximumItems) &&
            isSupportedConfigValueValid(nextItemSchema, event.detail.value) &&
            (nextValue.length < minimumItems || isSupportedConfigValueValid(schema, nextValue));
          let accepted = false;
          if (canApply) {
            accepted = patch(nextValue, [...rowIdentities, Symbol("array-row")]);
          }
          if (!accepted) {
            event.preventDefault();
          }
        }}
      ></openclaw-config-form-collection-draft>
      ${
        arrayValue.length === 0
          ? params.compact
            ? nothing
            : renderSettingsEmpty(t("configForm.noItems"))
          : html`
              <div class="settings-subrows">
                ${repeat(
                  arrayValue,
                  (_item, index) => rowIdentities[index],
                  (item, index) => {
                    const itemSchema = itemSchemaAt(index);
                    const nextValue = arrayValue.toSpliced(index, 1);
                    const canRemove = canApplyArrayCandidate(
                      schema,
                      arrayValue,
                      nextValue,
                      uniqueItems,
                      false,
                    );
                    const removeControl = renderCollectionRemoveButton(
                      t("configForm.removeItem"),
                      disabled || arrayValue.length <= minimumItems || !canRemove,
                      () => canRemove && patch(nextValue, rowIdentities.toSpliced(index, 1)),
                    );
                    const valueControl = renderNode({
                      ...configChildRenderOptions(params),
                      schema: inherited ? { ...itemSchema, default: item } : itemSchema,
                      value: inherited ? undefined : item,
                      path: [...path, index],
                      isRequired: true,
                      sourceIdentity: inherited ? undefined : item,
                      controlIdentity: arrayValue,
                      searchCriteria: childSearchCriteria,
                      showLabel: false,
                      // Keep inherited source identity until an edit materializes the
                      // complete effective array through its parent owner.
                      onPatch: patchArrayItem,
                    });
                    if (params.compact) {
                      return html`<div class="cfg-array__item">
                        <div class="cfg-array__value">${valueControl}</div>
                        ${removeControl}
                      </div>`;
                    }
                    return html`
                      <div class="settings-row">
                        <div class="settings-row__text">
                          <span class="settings-row__title">#${index + 1}</span>
                        </div>
                        <div class="settings-row__control">${removeControl}</div>
                      </div>
                      ${valueControl}
                    `;
                  },
                )}
              </div>
            `
      }
    </div>
  `;
}
