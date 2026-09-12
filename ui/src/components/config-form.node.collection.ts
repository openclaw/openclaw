// Control UI renderers for structured config form nodes.
import { html, nothing, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { removePathValue, setPathValue } from "../lib/config-form-utils.ts";
import { arrayAddCandidates } from "./config-form-array-candidates.ts";
import { ConfigFormArrayIdentity } from "./config-form-array-identity.ts";
import {
  openCollectionDraft,
  type ConfigFormCollectionDraftCommit,
  type ConfigFormCollectionDraftProps,
} from "./config-form-collection-draft.ts";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";
import { arrayItemSchema } from "./config-form.array-items.ts";
import {
  arrayInputConstraints,
  canApplyArrayCandidate,
  canApplyObjectCandidate,
  configValuesEqual,
  isSupportedConfigValueValid,
  isObjectPropertyNameValid,
  objectAdditionalPropertiesSchema,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.constraints.ts";
import { renderMapField } from "./config-form.node.collection-map.ts";
import {
  renderCollectionDefaultDescription,
  renderFlatDefaultRow,
  renderFieldRow,
  renderTags,
  schemaWithDefault,
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

export function renderObject(
  params: ConfigNodeRenderParams,
  renderNode: ConfigNodeRenderer,
): TemplateResult {
  const {
    schema,
    value,
    path,
    hints,
    unsupported,
    disabled,
    onPatch,
    searchCriteria,
    rawAvailable,
    revealSensitive,
    isSensitivePathRevealed,
    onToggleSensitivePath,
    onRemove,
  } = params;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const selfMatched =
    searchCriteria && hasSearchCriteria(searchCriteria)
      ? matchesNodeSelf({ schema, path, hints, criteria: searchCriteria })
      : false;
  const childSearchCriteria = selfMatched ? undefined : searchCriteria;

  const inherited = value === undefined && schema.default !== undefined;
  const fallback = inherited ? schema.default : value;
  const objectSourceIdentity = fallback === undefined ? UNSET_MAP_SOURCE_IDENTITY : fallback;
  const objectValue =
    fallback && typeof fallback === "object" && !Array.isArray(fallback)
      ? (fallback as Record<string, unknown>)
      : {};
  const defaultDescription = renderCollectionDefaultDescription(params, fallback);
  const entries = objectPropertyKeys(schema)
    .map((key) => [key, objectPropertySchema(schema, key)] as const)
    .filter((entry): entry is readonly [string, ConfigNodeRenderParams["schema"]] =>
      Boolean(entry[1]),
    );
  const requiredKeys = requiredPropertyKeys(schema);

  // Sort by hint order
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
      if (!childValue || typeof childValue !== "object" || Array.isArray(childValue)) {
        return false;
      }
      candidate = childValue as Record<string, unknown>;
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

  const fields = html`
    ${sorted.map(([propertyKey, node]) => {
      const hasInheritedChild = inherited && Object.hasOwn(objectValue, propertyKey);
      return renderNode({
        schema: hasInheritedChild ? schemaWithDefault(node, objectValue[propertyKey]) : node,
        value: inherited ? undefined : objectValue[propertyKey],
        path: [...path, propertyKey],
        hints,
        rawAvailable,
        unsupported,
        disabled,
        isRequired: requiredKeys.has(propertyKey),
        sourceIdentity: inherited ? undefined : objectValue[propertyKey],
        controlIdentity: params.controlIdentity ?? objectValue,
        searchCriteria: childSearchCriteria,
        revealSensitive,
        isSensitivePathRevealed,
        onToggleSensitivePath,
        onPatch: patchObjectChild,
      });
    })}
    ${
      allowExtra
        ? renderMapField(
            {
              ...params,
              schema: additionalProperties,
              value: objectValue,
              sourceIdentity: objectSourceIdentity,
              reservedKeys,
              validateKey: (key) => isObjectPropertyNameValid(schema, key),
              searchCriteria: childSearchCriteria,
              onPatch: patchObjectChild,
            },
            renderNode,
          )
        : nothing
    }
  `;

  // Top-level objects and label-less contexts emit rows directly into the
  // surrounding settings-group so row dividers stay sibling-driven.
  if (path.length === 1 || params.showLabel === false) {
    return html`${path.length === 1 ? renderFlatDefaultRow(defaultDescription) : nothing}${fields}`;
  }

  // Nested objects get collapsible treatment as an indented sub-block.
  return html`
    <details class="cfg-object cfg-block" ?open=${path.length <= 2}>
      <summary class="settings-row cfg-object__summary">
        <div class="settings-row__text">
          <span class="settings-row__title">${label}</span>
          ${help ? html`<span class="settings-row__desc">${help}</span>` : nothing}
          ${
            schema.default !== undefined
              ? html`<span class="settings-row__desc">${defaultDescription}</span>`
              : nothing
          }
          ${renderTags(tags)}
        </div>
        <div class="settings-row__control">
          <span class="settings-row__chevron cfg-object__chevron">${icons.chevronDown}</span>
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
  const {
    schema,
    value,
    path,
    hints,
    unsupported,
    disabled,
    onPatch,
    searchCriteria,
    rawAvailable,
    revealSensitive,
    isSensitivePathRevealed,
    onToggleSensitivePath,
  } = params;
  const showLabel = params.showLabel ?? true;
  const showHeaderMeta = params.showHeaderMeta ?? showLabel;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
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
      tags: [],
      showLabel: true,
      control: nothing,
      error: t("configForm.unsupportedArray"),
    });
  }

  const inherited = value === undefined && Array.isArray(schema.default);
  const arrayValue = Array.isArray(value)
    ? value
    : Array.isArray(schema.default)
      ? schema.default
      : [];
  const arraySourceIdentity = Array.isArray(value)
    ? value
    : Array.isArray(schema.default)
      ? schema.default
      : UNSET_ARRAY_SOURCE_IDENTITY;
  const defaultDescription = renderCollectionDefaultDescription(params, arrayValue);
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
  const { atomicCandidate, autoCandidate } = arrayAddCandidates({
    schema,
    value: arrayValue,
    minimumItems,
    maximumItems,
    uniqueItems,
    isUnset: value === undefined,
    isRequired: params.isRequired ?? false,
    itemSchemaAt,
  });
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
            showHeaderMeta && schema.default !== undefined
              ? html`<span class="settings-row__desc">${defaultDescription}</span>`
              : nothing
          }
          ${renderTags(tags)}
        </div>
        <div class="settings-row__control">
          <span class="settings-row__value"
            >${t(arrayValue.length === 1 ? "configForm.itemCountOne" : "configForm.itemCount", {
              count: String(arrayValue.length),
            })}</span
          >
          <button
            type="button"
            class="btn btn--sm"
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
            ${t("configForm.add")}
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
          ? renderSettingsEmpty(t("configForm.noItems"))
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
                    return html`
                      <div class="settings-row">
                        <div class="settings-row__text">
                          <span class="settings-row__title">#${index + 1}</span>
                        </div>
                        <div class="settings-row__control">
                          <openclaw-tooltip .content=${t("configForm.removeItem")}>
                            <button
                              type="button"
                              class="btn btn--icon"
                              style="width:28px;height:28px;padding:0;"
                              aria-label=${t("configForm.removeItem")}
                              ?disabled=${disabled || arrayValue.length <= minimumItems || !canRemove}
                              @click=${(event: MouseEvent) => {
                                const focused = event.currentTarget === document.activeElement;
                                const add = document.activeElement
                                  ?.closest(".cfg-array")
                                  ?.querySelector<HTMLButtonElement>("button[aria-controls]");
                                if (
                                  canRemove &&
                                  patch(nextValue, rowIdentities.toSpliced(index, 1)) &&
                                  focused
                                ) {
                                  // A keyed removal retires the focused button; keep keyboard
                                  // navigation in this array without stealing a later focus choice.
                                  queueMicrotask(() => {
                                    if (document.activeElement === document.body) {
                                      add?.focus();
                                    }
                                  });
                                }
                              }}
                            >
                              ${icons.trash}
                            </button>
                          </openclaw-tooltip>
                        </div>
                      </div>
                      ${renderNode({
                        schema: inherited ? schemaWithDefault(itemSchema, item) : itemSchema,
                        value: inherited ? undefined : item,
                        path: [...path, index],
                        hints,
                        rawAvailable,
                        unsupported,
                        disabled,
                        isRequired: true,
                        sourceIdentity: inherited ? undefined : item,
                        controlIdentity: arrayValue,
                        searchCriteria: childSearchCriteria,
                        showLabel: false,
                        revealSensitive,
                        isSensitivePathRevealed,
                        onToggleSensitivePath,
                        // Inherited rows stay visually unset, but edits materialize the
                        // complete effective array through patchArrayItem at the parent path.
                        onPatch: patchArrayItem,
                      })}
                    `;
                  },
                )}
              </div>
            `
      }
    </div>
  `;
}
