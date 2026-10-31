import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
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
import { Popover, type PopoverHandle } from "./solid/popover.tsx";
import { SettingsEmpty, SettingsPage, LearnMoreLink } from "./solid/settings-ui.tsx";

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
  node: JsonSchema;
  path: string[];
};

function ConfigSection(props: { section: Section; form: ConfigFormProps }): SolidJSX.Element {
  const hints = createMemo(() => props.form.uiHints);
  const meta = createMemo(() => {
    getLocale();
    const { path, node } = props.section;
    const key = path.at(-1)!;
    const hint = localizedHintForPath(path, hints());
    const sectionMeta = path.length === 1 ? SECTION_META[key] : undefined;
    return {
      label:
        sectionMeta?.label ??
        hint?.label ??
        (path.length === 1
          ? key.charAt(0).toUpperCase() + key.slice(1)
          : (node.title ?? humanize(key))),
      description: sectionMeta?.description ?? hint?.help ?? node.description ?? "",
    };
  });
  const value = () =>
    props.section.path.reduce<unknown>(
      (current, key) => asNullableRecord(current)?.[key],
      props.form.value,
    );
  const [docsTrigger, setDocsTrigger] = createSignal<HTMLButtonElement>();
  let docsPopover!: PopoverHandle;
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
        <h2 class="settings-section__heading">{meta().label}</h2>
        <Show when={props.form.sectionActions || docsUrl()}>
          <div class="settings-section__actions">
            {props.form.sectionActions}
            <Show when={docsUrl()}>
              {(url) => (
                <span class="settings-section__docs">
                  <openclaw-tooltip
                    prop:content={t("configForm.sectionHelp", { section: meta().label })}
                  >
                    <button
                      ref={setDocsTrigger}
                      id={docsTriggerId()}
                      type="button"
                      class="settings-section__help-button"
                      aria-label={t("configForm.sectionHelp", { section: meta().label })}
                      aria-controls={`settings-section-help-popover-${props.section.id}`}
                      aria-haspopup="dialog"
                      onClick={() => docsPopover.overlay.request(!docsPopover.overlay.open)}
                    >
                      <span aria-hidden="true">
                        <Icon name="circleQuestionMark" />
                      </span>
                    </button>
                  </openclaw-tooltip>
                  <Show when={docsTrigger()}>
                    {(trigger) => (
                      <Popover
                        ref={(handle) => (docsPopover = handle)}
                        id={`settings-section-help-popover-${props.section.id}`}
                        label={t("configForm.sectionHelp", { section: meta().label })}
                        class="settings-section__help-popover"
                        anchor={trigger()}
                        placement="bottom-end"
                      >
                        <div class="settings-section__help-panel">
                          <Show when={meta().description}>
                            <p>{meta().description}</p>
                          </Show>
                          <LearnMoreLink url={url()} />
                        </div>
                      </Popover>
                    )}
                  </Show>
                </span>
              )}
            </Show>
          </div>
        </Show>
      </div>
      <Show when={meta().description}>
        <p class="settings-section__desc">{meta().description}</p>
      </Show>
      <ConfigTierGroups
        schema={props.section.node}
        path={props.section.path}
        hints={hints()}
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
              value: value(),
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
  const schemaInput = createMemo(() => props.schema);
  const hints = createMemo(() => props.uiHints);
  const selectedSection = createMemo(() => props.activeSection);
  const selectedSubsection = createMemo(() => props.activeSubsection);
  const query = createMemo(() => props.searchQuery);
  const searchValue = createMemo(() => props.value);
  const sections = createMemo((): Section[] => {
    const schema = schemaInput();
    if (!schema || schemaType(schema) !== "object" || !schema.properties) {
      return [];
    }
    const uiHints = hints();
    const activeSection = selectedSection();
    const activeSubsection = selectedSubsection();
    const entries = Object.entries(schema.properties)
      .toSorted(([a], [b]) => {
        const order =
          (hintForPath([a], uiHints)?.order ?? 50) - (hintForPath([b], uiHints)?.order ?? 50);
        return order || a.localeCompare(b);
      })
      .filter(([key]) => !activeSection || key === activeSection);
    const active = entries[0];
    if (
      activeSection &&
      activeSubsection &&
      entries.length === 1 &&
      active &&
      schemaType(active[1]) === "object"
    ) {
      const node = active[1].properties?.[activeSubsection];
      if (node) {
        const path = [activeSection, activeSubsection];
        return [
          {
            id: `config-section-${path.join("-")}`,
            node,
            path,
          },
        ];
      }
    }
    return entries.map(([key, node]) => ({
      id: `config-section-${key}`,
      node,
      path: [key],
    }));
  });
  const visibleSections = createMemo(() => {
    const all = sections();
    const searchQuery = query();
    if (!searchQuery) {
      return all;
    }
    getLocale();
    const schema = schemaInput();
    const uiHints = hints();
    const value = searchValue();
    return all.filter((section) => {
      const key = section.path[0]!;
      return matchesConfigSectionSearch({
        key,
        schema: schema!.properties![key]!,
        value: value?.[key],
        hints: uiHints,
        query: searchQuery,
        label: SECTION_META[key]?.label,
        description: SECTION_META[key]?.description,
      });
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
          when={visibleSections().length > 0}
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
            <For each={visibleSections()} keyed={(section) => section.id}>
              {(section) => <ConfigSection section={section()} form={props} />}
            </For>
          </SettingsPage>
        </Show>
      </Show>
    </Show>
  );
}
