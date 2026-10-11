import type { JSX } from "@solidjs/web";
import { For, Show, createMemo } from "solid-js";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import { ConfigFormArrayIdentity } from "./config-form-array-identity.ts";
import {
  openCollectionDraft,
  type ConfigFormCollectionDraftCommit,
  type ConfigFormCollectionDraftProps,
} from "./config-form-collection-draft.tsx";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";
import { arrayItemSchema } from "./config-form.array-items.ts";
import { ConfigCollectionDraftHost } from "./config-form.bridge.tsx";
import {
  arrayConstraintCandidates,
  arrayInputConstraints,
  canApplyArrayCandidate,
  configValuesEqual,
  defaultValue,
  isSupportedConfigValueValid,
  MAX_AUTO_ARRAY_DEFAULT_ITEMS,
  NO_SAFE_DEFAULT,
} from "./config-form.constraints.ts";
import { ConfigMapField } from "./config-form.node.collection-map.tsx";
import { resolveConfigObjectFields } from "./config-form.node.collection.ts";
import {
  configChildRenderOptions,
  getSensitiveRenderState,
  CollectionRemoveButton,
  FieldRow,
  renderSchemaDefaultDescription,
  type ConfigNodeRenderer,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.tsx";
import {
  hasConfigSearchCriteria as hasSearchCriteria,
  matchesNodeSelf,
  resolveConfigFieldMeta as resolveFieldMeta,
} from "./config-form.search.ts";
import { configFieldId, type JsonSchema } from "./config-form.shared.ts";
import { Icon } from "./solid/icon.tsx";
import { SettingsEmpty } from "./solid/settings-ui.tsx";

const UNSET_ARRAY_SOURCE_IDENTITY = Symbol("unset-array-source");

type CollectionProps = {
  params: ConfigNodeRenderParams;
  renderNode: ConfigNodeRenderer;
};

export function ConfigObject(props: CollectionProps): JSX.Element {
  const object = createMemo(() => resolveConfigObjectFields(props.params));
  const meta = createMemo(() => {
    getLocale();
    return resolveFieldMeta(props.params.path, props.params.schema, props.params.hints);
  });
  const fields = () => (
    <>
      <For each={object().fields} keyed={(field) => String(field.path.at(-1))}>
        {(field) => {
          // The renderer accepts the live keyed accessor; evaluating it here would freeze the field.
          // oxlint-disable-next-line solid/reactivity
          return props.renderNode(field);
        }}
      </For>
      <Show when={object().additional}>
        {(additional) => <ConfigMapField params={additional()} renderNode={props.renderNode} />}
      </Show>
    </>
  );

  // Top-level objects and label-less contexts emit sibling settings rows.
  return (
    <Show
      when={props.params.path.length !== 1 && props.params.showLabel !== false}
      fallback={fields()}
    >
      <details class="cfg-object cfg-block" open={props.params.path.length <= 2}>
        <summary class="settings-row cfg-object__summary">
          <div class="settings-row__text">
            <span class="settings-row__title">{meta().label}</span>
            <Show when={meta().help}>
              <span class="settings-row__desc">{meta().help}</span>
            </Show>
          </div>
          <div class="settings-row__control">
            <span class="settings-row__chevron cfg-object__chevron">
              <Icon name="chevronRight" />
            </span>
          </div>
        </summary>
        <div class="settings-subrows">{fields()}</div>
      </details>
    </Show>
  );
}

function resolveArrayContent(params: ConfigNodeRenderParams, rows: ConfigFormArrayIdentity) {
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
    return undefined;
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
    ? undefined
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

  return {
    arrayValue,
    arraySourceIdentity,
    inherited,
    label,
    help,
    showLabel,
    showHeaderMeta,
    childSearchCriteria,
    defaultDescription,
    rowIdentities,
    patch,
    minimumItems,
    uniqueItems,
    itemSchemaAt,
    atomicCandidate,
    canAppend,
    requiresDraft,
    autoCandidate,
    draftId,
    draftProps,
    patchArrayItem,
    commitDraft(event: CustomEvent<ConfigFormCollectionDraftCommit>) {
      const nextValue = [...arrayValue, event.detail.value];
      const canApply =
        !(uniqueItems && arrayValue.some((item) => configValuesEqual(item, event.detail.value))) &&
        (maximumItems === undefined || arrayValue.length < maximumItems) &&
        isSupportedConfigValueValid(nextItemSchema, event.detail.value) &&
        (nextValue.length < minimumItems || isSupportedConfigValueValid(schema, nextValue));
      if (!canApply || !patch(nextValue, [...rowIdentities, Symbol("array-row")])) {
        event.preventDefault();
      }
    },
    add(event: Event) {
      if (atomicCandidate) {
        if (onPatch(path, atomicCandidate) === false) {
          openCollectionDraft(event, draftId);
        }
      } else if (requiresDraft) {
        openCollectionDraft(event, draftId);
      } else if (autoCandidate) {
        const appended = Array.from({ length: autoCandidate.length - arrayValue.length }, () =>
          Symbol("array-row"),
        );
        if (!patch(autoCandidate, [...rowIdentities, ...appended])) {
          openCollectionDraft(event, draftId);
        }
      }
    },
  };
}

type ArrayContent = NonNullable<ReturnType<typeof resolveArrayContent>>;

function ConfigArrayRow(
  props: CollectionProps & {
    content: ArrayContent;
    item: unknown;
    index: number;
  },
): JSX.Element {
  const nextValue = createMemo(() => props.content.arrayValue.toSpliced(props.index, 1));
  const canRemove = createMemo(() =>
    canApplyArrayCandidate(
      props.params.schema,
      props.content.arrayValue,
      nextValue(),
      props.content.uniqueItems,
      false,
    ),
  );
  const node = createMemo(() => {
    const schema = props.content.itemSchemaAt(props.index);
    return {
      ...configChildRenderOptions(props.params),
      schema: props.content.inherited ? { ...schema, default: props.item } : schema,
      value: props.content.inherited ? undefined : props.item,
      path: [...props.params.path, props.index],
      isRequired: true,
      sourceIdentity: props.content.inherited ? undefined : props.item,
      controlIdentity: props.content.arrayValue,
      searchCriteria: props.content.childSearchCriteria,
      showLabel: false,
      // Edits materialize the complete effective array through its parent owner.
      onPatch: props.content.patchArrayItem,
    } satisfies ConfigNodeRenderParams;
  });
  const remove = () =>
    canRemove() &&
    props.content.patch(nextValue(), props.content.rowIdentities.toSpliced(props.index, 1));
  const removeControl = () => (
    <CollectionRemoveButton
      label={t("configForm.removeItem")}
      disabled={
        props.params.disabled ||
        props.content.arrayValue.length <= props.content.minimumItems ||
        !canRemove()
      }
      remove={remove}
    />
  );
  return (
    <Show
      when={props.params.compact}
      fallback={
        <>
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">#{props.index + 1}</span>
            </div>
            <div class="settings-row__control">{removeControl()}</div>
          </div>
          {props.renderNode(node)}
        </>
      }
    >
      <div class="cfg-array__item">
        <div class="cfg-array__value">{props.renderNode(node)}</div>
        {removeControl()}
      </div>
    </Show>
  );
}

export function ConfigArray(props: CollectionProps): JSX.Element {
  // Only string segments identify a nested array; a moved parent row retains its editors.
  const rows = createMemo(() =>
    JSON.stringify(props.params.path.filter((segment) => typeof segment === "string")),
  );
  const identity = createMemo(() => {
    rows();
    return new ConfigFormArrayIdentity();
  });
  const content = createMemo(() => {
    getLocale();
    return resolveArrayContent(props.params, identity());
  });
  const entries = createMemo(
    () =>
      content()?.arrayValue.map((item, index) => ({
        item,
        identity: content()!.rowIdentities[index],
      })) ?? [],
  );
  return (
    <Show
      when={content()}
      fallback={
        <FieldRow
          label={resolveFieldMeta(props.params.path, props.params.schema, props.params.hints).label}
          showLabel={true}
          control={undefined}
          error={t("configForm.unsupportedArray")}
        />
      }
    >
      {(current) => (
        <div class="cfg-block cfg-array">
          <div class="settings-row">
            <div class="settings-row__text">
              <Show when={current().showLabel}>
                <span class="settings-row__title">{current().label}</span>
              </Show>
              <Show when={current().showHeaderMeta && current().help}>
                <span class="settings-row__desc">{current().help}</span>
              </Show>
              <Show when={current().showHeaderMeta && current().defaultDescription}>
                <span class="settings-row__desc">{current().defaultDescription}</span>
              </Show>
            </div>
            <div class="settings-row__control">
              <Show when={!props.params.compact}>
                <span class="settings-row__value">
                  {t(
                    current().arrayValue.length === 1
                      ? "configForm.itemCountOne"
                      : "configForm.itemCount",
                    { count: String(current().arrayValue.length) },
                  )}
                </span>
              </Show>
              <button
                type="button"
                class={props.params.compact ? "btn btn--sm btn--icon" : "btn btn--sm"}
                aria-label={t("configForm.add")}
                aria-controls={current().draftId}
                disabled={
                  props.params.disabled ||
                  (!current().canAppend && current().atomicCandidate === undefined)
                }
                onClick={(event) => current().add(event)}
              >
                <Show when={props.params.compact} fallback={t("configForm.add")}>
                  <Icon name="plus" />
                </Show>
              </button>
            </div>
          </div>
          <ConfigCollectionDraftHost
            id={current().draftId}
            props={current().draftProps}
            onConfig-collection-draft-commit={(
              event: CustomEvent<ConfigFormCollectionDraftCommit>,
            ) => current().commitDraft(event)}
          />
          <Show
            when={entries().length > 0}
            fallback={
              <Show when={!props.params.compact}>
                <SettingsEmpty message={t("configForm.noItems")} />
              </Show>
            }
          >
            <div class="settings-subrows">
              <For each={entries()} keyed={(entry) => entry.identity}>
                {(entry, index) => (
                  <ConfigArrayRow
                    params={props.params}
                    renderNode={props.renderNode}
                    content={current()}
                    item={entry().item}
                    index={index()}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
