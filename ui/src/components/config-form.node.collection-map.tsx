import type { JSX } from "@solidjs/web";
import { For, Show, createMemo } from "solid-js";
import { containsRedactedSentinel } from "../lib/config-form-utils.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  openCollectionDraft,
  ConfigCollectionDraftHost,
  type ConfigFormCollectionDraftCommit,
  type ConfigFormCollectionDraftProps,
} from "./config-form-collection-draft.tsx";
import { defaultValue, NO_SAFE_DEFAULT } from "./config-form.constraints.ts";
import {
  configChildRenderOptions,
  getSensitiveRenderState,
  isAnySchema,
  jsonValue,
  CollectionRemoveButton,
  FieldRow,
  JsonTextareaControl,
  type ConfigNodeRenderer,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.tsx";
import { resolveConfigMapSearch } from "./config-form.search.ts";
import { configFieldId } from "./config-form.shared.ts";

type MapParams = ConfigNodeRenderParams & {
  value: Record<string, unknown>;
  reservedKeys: Set<string>;
  validateKey: (key: string) => boolean;
};

type MapProps = {
  params: MapParams;
  renderNode: ConfigNodeRenderer;
};

function resolveMapContent(params: MapParams) {
  const anySchema = isAnySchema(params.schema);
  const entryDefault = anySchema ? {} : defaultValue(params.schema);
  const draftId = configFieldId(params.path, "map-draft");
  const draftProps: ConfigFormCollectionDraftProps = {
    schema: params.schema,
    label: t("configForm.customEntries"),
    disabled: params.disabled,
    identity: JSON.stringify(params.path.filter((segment) => typeof segment === "string")),
    sourceIdentity: params.sourceIdentity ?? params.value,
    existingKeys: [...new Set([...Object.keys(params.value), ...params.reservedKeys])],
    validateKey: params.validateKey,
  };
  return { anySchema, entryDefault, draftId, draftProps, ...resolveConfigMapSearch(params) };
}

function ConfigMapRow(
  props: MapProps & { entry: [string, unknown]; anySchema: boolean },
): JSX.Element {
  const key = createMemo(() => props.entry[0]);
  const entryValue = () => props.entry[1];
  const valuePath = createMemo(() => [...props.params.path, key()]);
  const sensitiveState = createMemo(() =>
    getSensitiveRenderState({
      path: valuePath(),
      value: entryValue(),
      hints: props.params.hints,
      revealSensitive: props.params.revealSensitive ?? false,
      isSensitivePathRevealed: props.params.isSensitivePathRevealed,
    }),
  );
  const node = createMemo(
    () =>
      ({
        ...configChildRenderOptions(props.params),
        schema: props.params.schema,
        value: entryValue(),
        path: valuePath(),
        isRequired: true,
        sourceIdentity: entryValue(),
        controlIdentity: props.params.value,
        searchCriteria: props.params.searchCriteria,
        showLabel: false,
        onPatch: props.params.onPatch,
      }) satisfies ConfigNodeRenderParams,
  );
  return (
    <>
      <div class="settings-row">
        <div class="settings-row__text">
          <input
            type="text"
            class="settings-input"
            placeholder={t("configForm.key")}
            aria-label={`${t("configForm.key")}: ${key()}`}
            value={key()}
            disabled={props.params.disabled}
            onChange={(event) => {
              const target = event.currentTarget;
              const nextKey = target.value.trim();
              if (!nextKey || nextKey === key()) {
                target.value = key();
                return;
              }
              // A new key must never carry a server-redacted credential sentinel.
              const error = !props.params.validateKey(nextKey)
                ? t("configForm.invalidString")
                : containsRedactedSentinel(props.params.value[key()])
                  ? t("configForm.renameRedactedBlocked")
                  : "";
              if (nextKey in props.params.value || error) {
                target.value = key();
                if (error) {
                  target.setCustomValidity(error);
                  target.reportValidity();
                  target.setCustomValidity("");
                }
                return;
              }
              const nextValue = { ...props.params.value, [nextKey]: props.params.value[key()] };
              delete nextValue[key()];
              if (props.params.onPatch(props.params.path, nextValue) === false) {
                target.value = key();
              }
            }}
          />
        </div>
        <div class="settings-row__control">
          <CollectionRemoveButton
            label={t("configForm.removeEntry")}
            disabled={props.params.disabled}
            remove={() => {
              const nextValue = { ...props.params.value };
              delete nextValue[key()];
              return props.params.onPatch(props.params.path, nextValue) !== false;
            }}
          />
        </div>
      </div>
      <Show when={props.anySchema} fallback={props.renderNode(node)}>
        <FieldRow
          label={key()}
          showLabel={false}
          stacked={true}
          control={
            <JsonTextareaControl
              schema={props.params.schema}
              path={valuePath()}
              ariaLabel={`${key()}: ${t("configForm.jsonValue")}`}
              sourceValue={entryValue()}
              fallback={jsonValue(entryValue())}
              rows={2}
              sensitiveState={sensitiveState()}
              disabled={props.params.disabled}
              isRequired={true}
              onToggleSensitivePath={props.params.onToggleSensitivePath}
              onPatch={props.params.onPatch}
            />
          }
        />
      </Show>
    </>
  );
}

export function ConfigMapField(props: MapProps): JSX.Element {
  const content = createMemo(() => resolveMapContent(props.params));
  return (
    <Show when={content().visible}>
      <div class="cfg-block cfg-map">
        <div class="settings-row">
          <Show when={props.params.showLabel !== false || props.params.reservedKeys.size > 0}>
            <div class="settings-row__text">
              <span class="settings-row__title">{t("configForm.customEntries")}</span>
            </div>
          </Show>
          <div class="settings-row__control">
            <button
              type="button"
              class="btn btn--sm"
              aria-controls={content().draftId}
              disabled={props.params.disabled}
              onClick={(event) => {
                if (content().entryDefault === NO_SAFE_DEFAULT) {
                  openCollectionDraft(event, content().draftId);
                  return;
                }
                const nextValue = { ...props.params.value };
                let index = 1;
                let key = `custom-${index}`;
                while (key in nextValue) {
                  index += 1;
                  key = `custom-${index}`;
                }
                nextValue[key] = content().entryDefault;
                if (props.params.onPatch(props.params.path, nextValue) === false) {
                  openCollectionDraft(event, content().draftId);
                }
              }}
            >
              {t("configForm.addEntry")}
            </button>
          </div>
        </div>
        <ConfigCollectionDraftHost
          id={content().draftId}
          props={content().draftProps}
          onConfig-collection-draft-commit={(
            event: CustomEvent<ConfigFormCollectionDraftCommit>,
          ) => {
            const key = event.detail.key;
            if (
              !key ||
              Object.hasOwn(props.params.value, key) ||
              props.params.reservedKeys.has(key) ||
              props.params.onPatch(props.params.path, {
                ...props.params.value,
                [key]: event.detail.value,
              }) === false
            ) {
              event.preventDefault();
            }
          }}
        />
        <Show when={content().visibleEntries.length > 0}>
          <div class="settings-subrows">
            <For each={content().visibleEntries} keyed={(entry) => entry[0]}>
              {(entry) => (
                <ConfigMapRow
                  params={props.params}
                  renderNode={props.renderNode}
                  entry={entry()}
                  anySchema={content().anySchema}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
