import { For, Show, createMemo, createRenderEffect, createSignal } from "solid-js";
import { resolveStructuredDraftInitialValue } from "../../components/config-form-structured-draft.ts";
import { renderMapField } from "../../components/config-form.node.collection-map.ts";
import { resolveConfigObjectFields } from "../../components/config-form.node.collection.ts";
import {
  isSecretRefObject,
  type ConfigNodeRenderParams,
} from "../../components/config-form.node.shared.ts";
import { matchesNodeSearch, resolveConfigFieldMeta } from "../../components/config-form.search.ts";
import {
  configFieldId,
  hintForPath,
  pathKey,
  schemaType,
} from "../../components/config-form.shared.ts";
import { renderNode } from "../../components/config-form.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { defineSolidBridge, LitContent } from "../../lit/solid-bridge.ts";
import "../../components/web-awesome.ts";
import type { JSX } from "../../types/solid-elements.d.ts";
import { PluginCredentialEditor, type PluginCredentialEditorProps } from "./credential-editor.tsx";
import "./custom-elements.ts";
import { renderPluginDetailBreadcrumb } from "./detail-shell.tsx";
import { nothing, renderPluginSettingsGroups } from "./settings-editor.ts";
import "./settings-editor.css";
import { pluginEntryValue, type PluginSettingsEditorModel } from "./settings-model.ts";

registerPluginManagementEnglish();
export type PluginSettingsField = ConfigNodeRenderParams & {
  label: string;
  help?: string;
  property: string;
  /** Inspected host grants supply effective state without becoming configured defaults. */
  effectiveValue?: unknown;
};

export function pluginSettingsNodeOptions(model: PluginSettingsEditorModel) {
  return {
    hints: model.configHints,
    unsupported: new Set(model.configUnsupportedPaths),
    disabled: !model.connected || !model.canEditConfig || model.configBusy,
    compact: true,
    commitOnBlur: true,
    maskSensitive: true,
    rawAvailable: false,
    onPatch: model.onConfigPatch,
    onRemove: model.onConfigRemove,
  };
}

export function flattenPluginSettingsFields(
  params: ConfigNodeRenderParams,
  rootProperty: string,
  ancestors: string[] = [],
): PluginSettingsField[] {
  const { label, help } = resolveConfigFieldMeta(params.path, params.schema, params.hints);
  const labels = [...ancestors, label];
  const initial = resolveStructuredDraftInitialValue(params);
  // SecretRef metadata stays atomic; source/provider/id are not child settings.
  if (
    schemaType(params.schema) === "object" &&
    params.schema.properties &&
    Object.keys(params.schema.properties).length > 0 &&
    params.schema.additionalProperties === false &&
    !params.schema.anyOf &&
    !params.schema.oneOf &&
    !params.schema.enum &&
    !isSecretRefObject(params.value) &&
    !params.unsupported.has(pathKey(params.path)) &&
    initial === undefined
  ) {
    return resolveConfigObjectFields(params).fields.flatMap((field) =>
      flattenPluginSettingsFields(field, rootProperty, labels),
    );
  }
  return [{ ...params, property: rootProperty, label: labels.join(": "), help }];
}

export type PluginSettingsEditorProps = {
  model?: PluginSettingsEditorModel;
  permissions?: { fields: PluginSettingsField[]; loading?: boolean };
  onAskSetting?: (field: PluginSettingsField) => void;
  resolveCredential?: (field: PluginSettingsField) => PluginCredentialEditorProps | undefined;
};

type FieldProps = Pick<PluginSettingsEditorProps, "onAskSetting" | "resolveCredential"> & {
  field: PluginSettingsField;
};
function PluginSettingsRow(props: FieldProps) {
  const effective = () =>
    props.field.value === undefined
      ? (props.field.effectiveValue ?? props.field.schema.default)
      : props.field.value;
  const isBoolean = () =>
    !hintForPath(props.field.path, props.field.hints)?.placeholder &&
    schemaType(props.field.schema) === "boolean" &&
    !props.field.schema.enum &&
    !props.field.schema.anyOf &&
    !props.field.schema.oneOf;
  const descriptionId = () => configFieldId(props.field.path, "plugin-help");
  const controlParams = createMemo(() => ({
    ...props.field,
    value: props.field.value === undefined ? props.field.effectiveValue : props.field.value,
    descriptionId: props.field.help ? descriptionId() : undefined,
  }));
  let selectHandler: (event: CustomEvent<{ item: { value: string } }>) => void = () => {};
  // Retired dropdowns may still deliver their queued selection; retain that field's callback.
  createRenderEffect(
    () => {
      const field = props.field;
      const onAskSetting = props.onAskSetting;
      const staticValue = effective();
      return (event: CustomEvent<{ item: { value: string } }>) => {
        if (event.detail.item.value === "reset" && !field.disabled) {
          field.onPatch(
            field.path,
            field.isRequired ? structuredClone(field.schema.default) : undefined,
          );
        }
        if (event.detail.item.value === "ask") {
          onAskSetting?.({ ...field, value: staticValue });
        }
      };
    },
    (handler) => {
      selectHandler = handler;
    },
  );
  const credential = createMemo(() => props.resolveCredential?.(controlParams()));
  return (
    <div
      class="plugin-editor__row"
      data-setting={props.field.path.slice(props.field.path[3] === "config" ? 4 : 3).join(".")}
      onClick={(event: MouseEvent) => {
        if (!isBoolean() || props.field.disabled || getSelection()?.toString()) {
          return;
        }
        const target = event.target;
        if (
          !(target instanceof Element) ||
          target.closest(
            "button,a,input,select,textarea,label,wa-switch,wa-checkbox,wa-dropdown,summary,[contenteditable]",
          )
        ) {
          return;
        }
        props.field.onPatch(props.field.path, !effective());
      }}
    >
      <div class="plugin-editor__menu">
        <wa-dropdown
          placement="bottom-start"
          onWa-select={(event: CustomEvent<{ item: { value: string } }>) => selectHandler(event)}
        >
          <button
            slot="trigger"
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t("pluginsPage.editor.actions", { name: props.field.label })}
          >
            <Icon name="moreHorizontal" />
          </button>
          <wa-dropdown-item
            value="reset"
            prop:disabled={
              props.field.disabled ||
              props.field.value === undefined ||
              (props.field.isRequired && props.field.schema.default === undefined)
            }
          >
            {t("pluginsPage.editor.reset")}
          </wa-dropdown-item>
          {props.onAskSetting ? (
            <wa-dropdown-item value="ask">{t("pluginsPage.editor.ask")}</wa-dropdown-item>
          ) : null}
        </wa-dropdown>
      </div>
      <div class="plugin-editor__copy">
        <span class="plugin-editor__title">{props.field.label}</span>
        {props.field.help ? <p id={descriptionId()}>{props.field.help}</p> : null}
      </div>
      <div class="plugin-editor__control">
        {credential() ? (
          <PluginCredentialEditor
            field={credential()!.field}
            descriptor={credential()!.descriptor}
            context={credential()!.context}
          />
        ) : (
          <LitContent
            render={() =>
              renderNode({
                ...controlParams(),
                showLabel: false,
                hints: {
                  ...props.field.hints,
                  [pathKey(props.field.path)]: {
                    ...hintForPath(props.field.path, props.field.hints),
                    label: props.field.label,
                  },
                },
              })
            }
          />
        )}
      </div>
    </div>
  );
}

function PluginSettingsFields(
  props: Pick<PluginSettingsEditorProps, "onAskSetting" | "resolveCredential"> & {
    fields: PluginSettingsField[];
    loading?: boolean;
  },
) {
  return (
    <Show
      when={!props.loading || props.fields.length}
      fallback={<SettingsLoadingSkeleton rows={3} carapace />}
    >
      <For each={props.fields} keyed={(field) => JSON.stringify(field.path)}>
        {(field) => (
          <PluginSettingsRow
            field={field()}
            onAskSetting={props.onAskSetting}
            resolveCredential={props.resolveCredential}
          />
        )}
      </For>
    </Show>
  );
}

function EditorSection(props: { title: string; id?: string; children: JSX.Element }) {
  return (
    <section
      class="plugin-editor__section"
      id={props.id}
      tabindex={props.id === undefined ? undefined : -1}
    >
      {props.title ? <h2>{props.title}</h2> : null}
      <div class="plugin-editor__group">{props.children}</div>
    </section>
  );
}

type GroupsProps = Pick<PluginSettingsEditorProps, "onAskSetting" | "resolveCredential"> & {
  params: ConfigNodeRenderParams;
  permissions: PluginSettingsEditorProps["permissions"];
  query: string;
};
function PluginSettingsGroups(props: GroupsProps) {
  let host: HTMLDivElement;
  const object = createMemo(() =>
    schemaType(props.params.schema) !== "object" ||
    props.params.schema.anyOf ||
    props.params.schema.oneOf ||
    props.params.schema.enum ||
    props.params.unsupported.has(pathKey(props.params.path))
      ? { fields: [props.params], additional: undefined }
      : resolveConfigObjectFields(props.params),
  );
  const groups = createMemo(() =>
    (hintForPath(props.params.path, props.params.hints)?.groups ?? []).toSorted(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    ),
  );
  const query = () => props.query.trim().toLocaleLowerCase();
  const fields = createMemo(() =>
    object()
      .fields.flatMap((field) => flattenPluginSettingsFields(field, String(field.path.at(-1))))
      .filter(
        (field) =>
          !query() ||
          matchesNodeSearch({ ...field, criteria: { text: query(), tags: [] } }) ||
          [
            field.path.slice(4).join("."),
            field.label,
            field.help,
            groups().find((group) => group.properties.includes(field.property))?.title,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query()),
      ),
  );
  const sections = createMemo(() => [
    ...groups().map((group) => ({
      id: group.id,
      title: group.title,
      fields: group.properties.flatMap((key) => fields().filter((field) => field.property === key)),
    })),
    {
      id: "__ungrouped",
      title: groups().length ? t("pluginsPage.editor.other") : "",
      fields: fields().filter(
        (field) => !groups().some((group) => group.properties.includes(field.property)),
      ),
    },
  ]);
  const additional = createMemo(() => {
    const params = object().additional;
    if (!params) {
      return undefined;
    }
    const content = renderMapField(
      { ...params, searchCriteria: query() ? { text: query(), tags: [] } : undefined },
      renderNode,
    );
    return content === nothing ? undefined : content;
  });
  const sectionId = (id: string) => configFieldId([...props.params.path, id], "section");
  const links = createMemo(() => {
    const result = sections().filter((section) => section.fields.length && section.title);
    if (props.permissions) {
      result.push({ id: "__permissions", title: t("pluginsPage.editor.permissions"), fields: [] });
    }
    return result;
  });
  return (
    <div
      class="plugin-editor__layout"
      ref={(element) => {
        host = element;
      }}
    >
      {groups().length ? (
        <nav class="plugin-editor__nav" aria-label={t("pluginsPage.editor.navigation")}>
          <For each={links()} keyed={(section) => section.id}>
            {(section) => (
              <a
                href={`#${sectionId(section().id)}`}
                onClick={(event: MouseEvent) => {
                  event.preventDefault();
                  const target = host.querySelector<HTMLElement>(
                    `#${CSS.escape(sectionId(section().id))}`,
                  );
                  target?.scrollIntoView({ block: "start", behavior: resolveScrollBehavior() });
                  target?.focus({ preventScroll: true });
                }}
              >
                {section().title}
              </a>
            )}
          </For>
        </nav>
      ) : null}
      <div class="plugin-editor__sections">
        <For each={sections()} keyed={(section) => section.id}>
          {(section) => (
            <Show when={section().fields.length}>
              <EditorSection title={section().title} id={sectionId(section().id)}>
                <PluginSettingsFields
                  fields={section().fields}
                  onAskSetting={props.onAskSetting}
                  resolveCredential={props.resolveCredential}
                />
              </EditorSection>
            </Show>
          )}
        </For>
        {additional() ? (
          <EditorSection title="">
            <LitContent render={() => additional()} />
          </EditorSection>
        ) : null}
        {props.permissions ? (
          <EditorSection
            title={t("pluginsPage.editor.permissions")}
            id={sectionId("__permissions")}
          >
            <PluginSettingsFields
              {...props.permissions!}
              onAskSetting={props.onAskSetting}
              resolveCredential={props.resolveCredential}
            />
          </EditorSection>
        ) : null}
        {!fields().length && !additional() && !props.permissions ? (
          <p class="plugin-editor__empty">
            {t(query() ? "pluginsPage.editor.noMatches" : "pluginsPage.editor.empty")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PluginSettingsEditorContent(props: PluginSettingsEditorProps) {
  const pluginId = createMemo(() => props.model?.pluginId);
  const [query, setQuery] = createSignal(() => {
    pluginId();
    return "";
  });
  const params = createMemo<ConfigNodeRenderParams | null>(() =>
    props.model?.configSchema
      ? {
          schema: props.model.configSchema,
          value: pluginEntryValue(props.model.configValue, props.model.pluginId).config,
          path: ["plugins", "entries", props.model.pluginId, "config"],
          ...pluginSettingsNodeOptions(props.model),
        }
      : null,
  );
  const permissionFields = createMemo(
    () =>
      props.permissions?.fields.filter((field) => {
        const search = query().trim().toLocaleLowerCase();
        return (
          !search ||
          `${t("pluginsPage.editor.permissions")} ${field.label} ${field.help ?? ""}`
            .toLocaleLowerCase()
            .includes(search) ||
          matchesNodeSearch({ ...field, criteria: { text: search, tags: [] } })
        );
      }) ?? [],
  );
  const permissions = createMemo(() => {
    if (!props.permissions) {
      return undefined;
    }
    const loading = Boolean(
      props.permissions.loading && !props.permissions.fields.length && !query().trim(),
    );
    const fields = permissionFields();
    return loading || fields.length ? { fields, loading } : undefined;
  });
  return (
    <>
      {props.model ? (
        <section class="plugin-editor">
          <header class="plugin-editor__header">
            {renderPluginDetailBreadcrumb({
              name: t("pluginsPage.detailSettings"),
              backHref: props.model.backHref,
              backLabel:
                props.model.result?.plugins.find((plugin) => plugin.id === props.model!.pluginId)
                  ?.name ?? props.model.pluginId,
              onBack: props.model.onBack,
            })}
          </header>
          <label class="plugin-editor__search">
            <Icon name="search" />
            <input
              type="search"
              class="settings-input"
              aria-label={t("pluginsPage.editor.search")}
              placeholder={t("pluginsPage.editor.search")}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {props.model.configError ? (
            <div class="callout danger" role="alert">
              {props.model.configError}
              <button
                class="btn btn--sm"
                onClick={
                  props.model.configValue && props.model.configSchema
                    ? props.model.onConfigWriteRetry
                    : props.model.onConfigReadRetry
                }
              >
                {t("common.retry")}
              </button>
            </div>
          ) : null}
          {props.model.configSchemaLoading || !props.model.configValue ? (
            <SettingsLoadingSkeleton {...{ rows: 2, carapace: true }} />
          ) : params() ? (
            <PluginSettingsDraft
              params={params()!}
              permissions={permissions()}
              query={query()}
              onAskSetting={props.onAskSetting}
              resolveCredential={props.resolveCredential}
            />
          ) : null}
          {permissions() && !params() ? (
            <EditorSection title={t("pluginsPage.editor.permissions")}>
              <PluginSettingsFields
                {...permissions()!}
                onAskSetting={props.onAskSetting}
                resolveCredential={props.resolveCredential}
              />
            </EditorSection>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

defineSolidBridge<{ props?: GroupsProps }>(
  "openclaw-plugin-settings-groups",
  (bridge) => (
    <Show when={Boolean(bridge.props)}>
      <PluginSettingsGroups {...bridge.props!} />
    </Show>
  ),
  { properties: { props: { default: undefined, attribute: false } } },
);

function PluginSettingsDraft(props: GroupsProps) {
  const draft = createMemo(() => {
    const initialValue = resolveStructuredDraftInitialValue(props.params);
    if (initialValue === undefined) {
      return undefined;
    }
    const groups = { ...props };
    return {
      identity: JSON.stringify(props.params.path),
      sourceIdentity: props.params.value,
      initialValue,
      params: props.params,
      renderNode: (params: ConfigNodeRenderParams) =>
        renderPluginSettingsGroups({ ...groups, params }),
    };
  });
  return (
    <Show when={Boolean(draft())} fallback={<PluginSettingsGroups {...props} />}>
      <openclaw-config-form-structured-draft prop:props={draft()} />
    </Show>
  );
}

export const PluginSettingsEditor = defineSolidBridge<PluginSettingsEditorProps>(
  "openclaw-plugin-settings-editor",
  PluginSettingsEditorContent,
  {
    properties: {
      model: { default: undefined, attribute: false },
      permissions: { default: undefined, attribute: false },
      onAskSetting: { default: undefined, attribute: false },
      resolveCredential: { default: undefined, attribute: false },
    },
  },
);
