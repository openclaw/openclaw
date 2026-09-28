import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
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
import { icons } from "../../components/icons.ts";
import { renderSettingsLoadingSkeleton } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/web-awesome.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderPluginDetailBreadcrumb } from "./detail-shell.ts";
import { pluginEntryValue, type PluginSettingsEditorModel } from "./settings-model.ts";
import "./settings-editor.css";

registerPluginManagementEnglish();
export type PluginSettingsField = ConfigNodeRenderParams & {
  label: string;
  help?: string;
  property: string;
  /** Inspected host grants supply effective state without becoming configured defaults. */
  effectiveValue?: unknown;
};

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

export class PluginSettingsEditor extends OpenClawLightDomElement {
  @property({ attribute: false }) model?: PluginSettingsEditorModel;
  @property({ attribute: false }) permissions?: {
    fields: PluginSettingsField[];
    loading?: boolean;
  };
  @property({ attribute: false }) onAskSetting?: (field: PluginSettingsField) => void;
  @property({ attribute: false }) renderCredential?: (
    field: PluginSettingsField,
  ) => TemplateResult | undefined;
  @state() private query = "";

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("model") && changed.get("model")?.pluginId !== this.model?.pluginId) {
      this.query = "";
    }
  }

  private renderField(field: PluginSettingsField) {
    const { label, help, path, disabled } = field;
    // A retired dropdown keeps the callback that owns its rendered plugin selection.
    const onAskSetting = this.onAskSetting;
    const effective =
      field.value === undefined ? (field.effectiveValue ?? field.schema.default) : field.value;
    const isBoolean =
      !hintForPath(path, field.hints)?.placeholder &&
      schemaType(field.schema) === "boolean" &&
      !field.schema.enum &&
      !field.schema.anyOf &&
      !field.schema.oneOf;
    const descriptionId = configFieldId(path, "plugin-help");
    const controlParams = {
      ...field,
      value: field.value === undefined ? field.effectiveValue : field.value,
      descriptionId: help ? descriptionId : undefined,
    };
    const credential = this.renderCredential?.(controlParams);
    const control =
      credential ??
      renderNode({
        ...controlParams,
        showLabel: false,
        hints: { ...field.hints, [pathKey(path)]: { ...hintForPath(path, field.hints), label } },
      });
    return html`<div
      class="plugin-editor__row"
      data-setting=${path.slice(path[3] === "config" ? 4 : 3).join(".")}
      @click=${(event: MouseEvent) => {
        if (!isBoolean || disabled || getSelection()?.toString()) {
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
        field.onPatch(path, !effective);
      }}
    >
      <div class="plugin-editor__menu">
        <wa-dropdown
          placement="bottom-start"
          @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
            if (event.detail.item.value === "reset" && !disabled) {
              field.onPatch(
                path,
                field.isRequired ? structuredClone(field.schema.default) : undefined,
              );
            }
            if (event.detail.item.value === "ask") {
              onAskSetting?.({ ...field, value: effective });
            }
          }}
        >
          <button
            slot="trigger"
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label=${t("pluginsPage.editor.actions", { name: label })}
          >
            ${icons.moreHorizontal}
          </button>
          <wa-dropdown-item
            value="reset"
            ?disabled=${disabled || field.value === undefined || (field.isRequired && field.schema.default === undefined)}
            >${t("pluginsPage.editor.reset")}</wa-dropdown-item
          >
          ${onAskSetting ? html`<wa-dropdown-item value="ask">${t("pluginsPage.editor.ask")}</wa-dropdown-item>` : nothing}
        </wa-dropdown>
      </div>
      <div class="plugin-editor__copy">
        <span class="plugin-editor__title">${label}</span
        >${help ? html`<p id=${descriptionId}>${help}</p>` : nothing}
      </div>
      <div class="plugin-editor__control">${control}</div>
    </div>`;
  }

  private renderPermissions(): TemplateResult | typeof nothing {
    if (!this.permissions) {
      return nothing;
    }
    const query = this.query.trim().toLocaleLowerCase();
    const fields = this.permissions.fields.filter(
      (field) =>
        !query ||
        `${t("pluginsPage.editor.permissions")} ${field.label} ${field.help ?? ""}`
          .toLocaleLowerCase()
          .includes(query) ||
        matchesNodeSearch({ ...field, criteria: { text: query, tags: [] } }),
    );
    return this.permissions.loading && !query
      ? renderSettingsLoadingSkeleton({ rows: 3, carapace: true })
      : fields.length
        ? html`${repeat(
            fields,
            (field) => JSON.stringify(field.path),
            (field) => this.renderField(field),
          )}`
        : nothing;
  }

  private renderGroups(
    params: ConfigNodeRenderParams,
    permissions: TemplateResult | typeof nothing,
  ): TemplateResult {
    const hasPermissions = permissions !== nothing;
    // Grouping changes presentation only: unions and enums must keep the
    // canonical whole-value control or valid alternatives become uneditable.
    const object =
      schemaType(params.schema) !== "object" ||
      params.schema.anyOf ||
      params.schema.oneOf ||
      params.schema.enum ||
      params.unsupported.has(pathKey(params.path))
        ? { fields: [params], additional: undefined }
        : resolveConfigObjectFields(params);
    const groups = (hintForPath(params.path, params.hints)?.groups ?? []).toSorted(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    const query = this.query.trim().toLocaleLowerCase();
    const all = object.fields.flatMap((field) =>
      flattenPluginSettingsFields(field, String(field.path.at(-1))),
    );
    const fields = all.filter(
      (field) =>
        !query ||
        matchesNodeSearch({ ...field, criteria: { text: query, tags: [] } }) ||
        [
          field.path.slice(4).join("."),
          field.label,
          field.help,
          groups.find((group) => group.properties.includes(field.property))?.title,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
    );
    const sections = groups.map((group) => ({
      id: group.id,
      title: group.title,
      fields: group.properties.flatMap((key) => fields.filter((field) => field.property === key)),
    }));
    const ungrouped = fields.filter(
      (field) => !groups.some((group) => group.properties.includes(field.property)),
    );
    sections.push({
      id: "__ungrouped",
      title: groups.length ? t("pluginsPage.editor.other") : "",
      fields: ungrouped,
    });
    const additional = object.additional
      ? renderMapField(
          { ...object.additional, searchCriteria: query ? { text: query, tags: [] } : undefined },
          renderNode,
        )
      : nothing;
    const sectionId = (id: string) => configFieldId([...params.path, id], "section");
    const links = sections.filter((section) => section.fields.length && section.title);
    if (hasPermissions) {
      links.push({ id: "__permissions", title: t("pluginsPage.editor.permissions"), fields: [] });
    }
    return html`<div class="plugin-editor__layout">
      ${
        groups.length
          ? html`<nav class="plugin-editor__nav" aria-label=${t("pluginsPage.editor.navigation")}>
              ${links.map(
                (section) =>
                  html`<a
                    href=${`#${sectionId(section.id)}`}
                    @click=${(event: MouseEvent) => {
                      event.preventDefault();
                      const target = this.querySelector<HTMLElement>(
                        `#${CSS.escape(sectionId(section.id))}`,
                      );
                      target?.scrollIntoView({ block: "start", behavior: resolveScrollBehavior() });
                      target?.focus({ preventScroll: true });
                    }}
                    >${section.title}</a
                  >`,
              )}
            </nav>`
          : nothing
      }
      <div class="plugin-editor__sections">
        ${sections.map((section) =>
          section.fields.length
            ? html`<section
                class="plugin-editor__section"
                id=${sectionId(section.id)}
                tabindex="-1"
              >
                ${section.title ? html`<h2>${section.title}</h2>` : nothing}
                <div class="plugin-editor__group">
                  ${repeat(
                    section.fields,
                    (field) => JSON.stringify(field.path),
                    (field) => this.renderField(field),
                  )}
                </div>
              </section>`
            : nothing,
        )}
        ${additional !== nothing ? html`<section class="plugin-editor__section"><div class="plugin-editor__group">${additional}</div></section>` : nothing}
        ${
          hasPermissions
            ? html`<section
                class="plugin-editor__section"
                id=${sectionId("__permissions")}
                tabindex="-1"
              >
                <h2>${t("pluginsPage.editor.permissions")}</h2>
                <div class="plugin-editor__group">${permissions}</div>
              </section>`
            : nothing
        }
        ${!fields.length && additional === nothing && !hasPermissions ? html`<p class="plugin-editor__empty">${t(query ? "pluginsPage.editor.noMatches" : "pluginsPage.editor.empty")}</p>` : nothing}
      </div>
    </div>`;
  }

  override render() {
    const props = this.model;
    if (!props) {
      return nothing;
    }
    const plugin = props.result?.plugins.find((p) => p.id === props.pluginId);
    const title = plugin?.name ?? props.pluginId;
    const permissions = this.renderPermissions();
    const hasPermissions = permissions !== nothing;
    const params: ConfigNodeRenderParams | null = props.configSchema
      ? {
          schema: props.configSchema,
          value: pluginEntryValue(props.configValue, props.pluginId).config,
          path: ["plugins", "entries", props.pluginId, "config"],
          hints: props.configHints,
          unsupported: new Set(props.configUnsupportedPaths),
          disabled: !props.connected || !props.canEditConfig || props.configBusy,
          compact: true,
          commitOnBlur: true,
          showLabel: false,
          maskSensitive: true,
          rawAvailable: false,
          onPatch: props.onConfigPatch,
          onRemove: props.onConfigRemove,
        }
      : null;
    const initial = params ? resolveStructuredDraftInitialValue(params) : undefined;
    const fields =
      params && initial !== undefined
        ? html`<openclaw-config-form-structured-draft
            .props=${{ identity: JSON.stringify(params.path), sourceIdentity: params.value, initialValue: initial, params, renderNode: (p: ConfigNodeRenderParams) => this.renderGroups(p, permissions) }}
          ></openclaw-config-form-structured-draft>`
        : params
          ? this.renderGroups(params, permissions)
          : nothing;
    return html`<section class="plugin-editor">
      <header class="plugin-editor__header">
        ${renderPluginDetailBreadcrumb({
          name: t("pluginsPage.detailSettings"),
          backHref: props.backHref,
          backLabel: title,
          onBack: props.onBack,
        })}
      </header>
      <label class="plugin-editor__search"
        >${icons.search}<input
          type="search"
          class="settings-input"
          aria-label=${t("pluginsPage.editor.search")}
          placeholder=${t("pluginsPage.editor.search")}
          .value=${this.query}
          @input=${(event: Event) => {
            // SAFETY: Lit binds this handler directly to the native search input.
            this.query = (event.currentTarget as HTMLInputElement).value;
          }}
      /></label>
      ${props.configError ? html`<div class="callout danger" role="alert">${props.configError}<button class="btn btn--sm" @click=${props.configValue && props.configSchema ? props.onConfigWriteRetry : props.onConfigReadRetry}>${t("common.retry")}</button></div>` : nothing}
      ${props.configSchemaLoading || !props.configValue ? renderSettingsLoadingSkeleton({ rows: 2, carapace: true }) : fields}
      ${
        hasPermissions && !params
          ? html`<section class="plugin-editor__section">
              <h2>${t("pluginsPage.editor.permissions")}</h2>
              <div class="plugin-editor__group">${permissions}</div>
            </section>`
          : nothing
      }
    </section>`;
  }
}
customElements.define("openclaw-plugin-settings-editor", PluginSettingsEditor);
