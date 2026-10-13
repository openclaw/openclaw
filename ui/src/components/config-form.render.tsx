import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import { SECTION_META } from "./config-form.meta.ts";
import { ConfigNode } from "./config-form.node.tsx";
import { matchesConfigSectionSearch, parseConfigSearchQuery } from "./config-form.search.ts";
import {
  hintForPath,
  humanize,
  localizedHintForPath,
  schemaType,
  type ConfigFormProps,
  type ConfigTierGroupsProps,
  type JsonSchema,
} from "./config-form.shared.ts";
import { splitConfigSchemaByTier } from "./config-form.tiers.ts";
import { Icon } from "./solid/icon.tsx";
import { SettingsEmpty, SettingsPage, LearnMoreLink } from "./solid/settings-ui.tsx";
import { syncPopoverLabel } from "./web-awesome-popover.ts";

export function ConfigTierGroups(props: ConfigTierGroupsProps): SolidJSX.Element {
  const split = createMemo(() =>
    splitConfigSchemaByTier({
      schema: props.schema,
      path: props.path.map(String),
      hints: props.hints,
    }),
  );
  return (
    <div class="config-tier-groups">
      <Show when={split().common || props.commonPrelude}>
        <div class="settings-group">
          {props.commonPrelude}
          <Show when={split().common}>{(node) => props.renderTier(node)}</Show>
        </div>
      </Show>
      <Show when={split().advanced}>
        {(node) => (
          <details
            class="config-advanced-disclosure"
            open={props.revealAdvanced}
            onToggle={(event) => {
              const disclosure = event.currentTarget;
              if (disclosure.open === props.revealAdvanced) {
                return;
              }
              if (disclosure.open) {
                props.onShowAdvanced();
              } else if (props.onHideAdvanced) {
                props.onHideAdvanced();
              } else {
                disclosure.open = true;
              }
            }}
          >
            <summary class="settings-section__heading config-advanced-disclosure__summary">
              {t("configForm.advancedSettings")}
            </summary>
            <Show when={props.revealAdvanced}>
              <div class="settings-group">{props.renderTier(node)}</div>
            </Show>
          </details>
        )}
      </Show>
    </div>
  );
}

type Section = {
  id: string;
  label: string;
  description: string;
  node: JsonSchema;
  nodeValue: unknown;
  path: Array<string | number>;
};

function ConfigSection(props: { section: Section; form: ConfigFormProps }): SolidJSX.Element {
  const docsUrl = () =>
    props.form.showSectionDocs === false
      ? undefined
      : hintForPath(props.section.path.slice(0, 1), props.form.uiHints)?.docsUrl;
  const docsTriggerId = () => `settings-section-help-${props.section.id}`;
  const revealAdvanced = () =>
    props.form.showAdvanced === true ||
    props.form.forceAdvancedSection === props.section.path[0] ||
    Boolean(props.form.searchQuery);
  return (
    <section class="settings-section" id={props.section.id}>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{props.section.label}</h2>
        <Show when={props.form.sectionActions || docsUrl()}>
          <div class="settings-section__actions">
            {props.form.sectionActions}
            <Show when={docsUrl()}>
              {(url) => (
                <span class="settings-section__docs">
                  <openclaw-tooltip
                    prop:content={t("configForm.sectionHelp", { section: props.section.label })}
                  >
                    <button
                      id={docsTriggerId()}
                      type="button"
                      class="settings-section__help-button"
                      aria-label={t("configForm.sectionHelp", { section: props.section.label })}
                      aria-controls={`settings-section-help-popover-${props.section.id}`}
                      aria-haspopup="dialog"
                    >
                      <span aria-hidden="true">
                        <Icon name="circleQuestionMark" />
                      </span>
                    </button>
                  </openclaw-tooltip>
                  <wa-popover
                    ref={syncPopoverLabel}
                    id={`settings-section-help-popover-${props.section.id}`}
                    class="settings-section__help-popover"
                    for={docsTriggerId()}
                    placement="bottom-end"
                  >
                    <div class="settings-section__help-panel">
                      <Show when={props.section.description}>
                        <p>{props.section.description}</p>
                      </Show>
                      <LearnMoreLink url={url()} />
                    </div>
                  </wa-popover>
                </span>
              )}
            </Show>
          </div>
        </Show>
      </div>
      <Show when={props.section.description}>
        <p class="settings-section__desc">{props.section.description}</p>
      </Show>
      <ConfigTierGroups
        schema={props.section.node}
        path={props.section.path}
        hints={props.form.uiHints}
        revealAdvanced={revealAdvanced()}
        onShowAdvanced={props.form.onShowAdvanced}
        onHideAdvanced={
          props.form.showAdvanced === true &&
          props.form.forceAdvancedSection !== props.section.path[0] &&
          !props.form.searchQuery
            ? props.form.onHideAdvanced
            : undefined
        }
        commonPrelude={props.form.sectionPrelude}
        renderTier={(node) => (
          <ConfigNode
            params={{
              schema: node(),
              value: props.section.nodeValue,
              path: props.section.path,
              hints: props.form.uiHints,
              rawAvailable: props.form.rawAvailable ?? true,
              unsupported: new Set(props.form.unsupportedPaths ?? []),
              disabled: props.form.disabled ?? false,
              showLabel: false,
              showHeaderMeta: true,
              searchCriteria: parseConfigSearchQuery(props.form.searchQuery ?? ""),
              revealSensitive: props.form.revealSensitive ?? false,
              maskSensitive: props.form.maskSensitive,
              isSensitivePathRevealed: props.form.isSensitivePathRevealed,
              onToggleSensitivePath: props.form.onToggleSensitivePath,
              onPatch: props.form.onPatch,
              onRemove: props.form.onRemove,
            }}
          />
        )}
      />
    </section>
  );
}

export function ConfigForm(props: ConfigFormProps): SolidJSX.Element {
  const sections = createMemo((): Section[] => {
    getLocale();
    const schema = props.schema;
    if (!schema || schemaType(schema) !== "object" || !schema.properties) {
      return [];
    }
    const value = props.value ?? {};
    const uiHints = props.uiHints;
    const activeSection = props.activeSection;
    const searchQuery = props.searchQuery;
    const entries = Object.entries(schema.properties)
      .toSorted(([a], [b]) => {
        const order =
          (hintForPath([a], uiHints)?.order ?? 50) - (hintForPath([b], uiHints)?.order ?? 50);
        return order || a.localeCompare(b);
      })
      .filter(
        ([key, node]) =>
          (!activeSection || key === activeSection) &&
          (!searchQuery ||
            matchesConfigSectionSearch({
              key,
              schema: node,
              value: value[key],
              hints: uiHints,
              query: searchQuery,
              label: SECTION_META[key]?.label,
              description: SECTION_META[key]?.description,
            })),
      );
    const active = entries[0];
    if (
      props.activeSection &&
      props.activeSubsection &&
      entries.length === 1 &&
      active &&
      schemaType(active[1]) === "object"
    ) {
      const node = active[1].properties?.[props.activeSubsection];
      if (node) {
        const path = [props.activeSection, props.activeSubsection];
        const hint = localizedHintForPath(path, props.uiHints);
        const sectionValue = value[props.activeSection];
        let nodeValue: unknown;
        if (sectionValue && typeof sectionValue === "object") {
          // SAFETY: The value is a non-null object; absent subsection keys yield undefined.
          nodeValue = (sectionValue as Record<string, unknown>)[props.activeSubsection];
        }
        return [
          {
            id: `config-section-${path.join("-")}`,
            label: hint?.label ?? node.title ?? humanize(props.activeSubsection),
            description: hint?.help ?? node.description ?? "",
            node,
            path,
            nodeValue,
          },
        ];
      }
    }
    return entries.map(([key, node]) => {
      const hint = localizedHintForPath([key], uiHints);
      const meta = SECTION_META[key] ?? {
        label: hint?.label ?? key.charAt(0).toUpperCase() + key.slice(1),
        description: hint?.help ?? node.description ?? "",
      };
      return {
        id: `config-section-${key}`,
        label: meta.label,
        description: meta.description,
        node,
        nodeValue: value[key],
        path: [key],
      };
    });
  });
  return (
    <Show
      when={props.schema}
      fallback={<div class="muted">{t("configForm.schemaUnavailable")}</div>}
    >
      <Show
        when={schemaType(props.schema!) === "object" && props.schema!.properties}
        fallback={<div class="callout danger">{t("configForm.unsupportedSchema")}</div>}
      >
        <Show
          when={sections().length > 0}
          fallback={
            <Show when={!props.embedded || props.searchQuery}>
              <SettingsPage>
                <SettingsEmpty
                  message={
                    props.searchQuery
                      ? t("configForm.noSettingsMatch", { query: props.searchQuery })
                      : t("configForm.noSettingsInSection")
                  }
                />
              </SettingsPage>
            </Show>
          }
        >
          <SettingsPage>
            <For each={sections()} keyed={(section) => section.id}>
              {(section) => <ConfigSection section={section()} form={props} />}
            </For>
          </SettingsPage>
        </Show>
      </Show>
    </Show>
  );
}
