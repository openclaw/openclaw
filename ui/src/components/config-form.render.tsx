import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import { createProgressiveList } from "../lib/reactive/progressive-list.ts";
import { SECTION_META } from "./config-form.meta.ts";
import { collectLiftedHelp } from "./config-form.node.collection.ts";
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
import { InlineAlert } from "./solid/inline-alert.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";
import { SettingsDisclosure } from "./solid/settings-disclosure.tsx";
import { SettingsEmpty, SettingsPage, LearnMoreLink } from "./solid/settings-ui.tsx";

export function ConfigTierGroups(
  props: ConfigTierGroupsProps & { tiers?: ReturnType<typeof splitConfigSchemaByTier> },
): SolidJSX.Element {
  const split = createMemo(
    () =>
      props.tiers ??
      splitConfigSchemaByTier({
        schema: props.schema,
        path: props.path.map(String),
        hints: props.hints,
      }),
  );
  return (
    <div class="config-tier-groups">
      <Show when={split().common || props.commonPrelude || props.flat}>
        <div class="settings-group">
          {props.commonPrelude}
          <Show when={split().common}>{(node) => props.renderTier(node)}</Show>
          <Show when={props.flat ? split().advanced : null}>
            {(node) => props.renderTier(node)}
          </Show>
        </div>
      </Show>
      <Show when={props.flat ? null : split().advanced}>
        {(node) => (
          <SettingsDisclosure
            class="config-advanced-disclosure"
            title={t("configForm.advancedSettings")}
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
            <Show when={props.revealAdvanced}>{props.renderTier(node)}</Show>
          </SettingsDisclosure>
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
  const curated = () => props.form.curatedSections?.[String(props.section.path[0])];
  const meta = createMemo(() => {
    getLocale();
    const { path, node } = props.section;
    const key = path.at(-1)!;
    const hint = localizedHintForPath(path, hints());
    const sectionMeta = path.length === 1 ? SECTION_META[key] : undefined;
    if (props.form.sectionTitle) {
      return { label: props.form.sectionTitle, description: "" };
    }
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
  // Objects the form renders in place leave their help to the section.
  const tiers = createMemo(() =>
    splitConfigSchemaByTier({
      schema: props.section.node,
      path: props.section.path,
      hints: hints(),
    }),
  );
  const liftedHelp = createMemo(() => {
    getLocale();
    const { common, advanced } = tiers();
    return [
      ...new Set(
        [common, advanced].flatMap((tier) =>
          tier ? collectLiftedHelp(tier, props.section.path, hints()) : [],
        ),
      ),
    ];
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
  const hasSectionHelp = () => Boolean(docsUrl()) || liftedHelp().length > 0;
  const contextLabel = () => {
    const label = curated()?.label;
    return typeof label === "string" ? label : meta().label;
  };
  const headingRepeats = () => {
    const heading = contextLabel().toLowerCase();
    return (props.form.repeatedHeadings ?? []).some((name) =>
      `${name?.toLowerCase()} `.startsWith(`${heading} `),
    );
  };
  // A search result or deep link has to land on open rows.
  const revealTarget = () =>
    props.form.forceAdvancedSection === props.section.path[0] || Boolean(props.form.searchQuery);
  const revealAdvanced = () => props.form.showAdvanced === true || revealTarget();
  return (
    <section
      class="settings-section"
      id={props.section.id}
      aria-label={headingRepeats() ? meta().label : undefined}
    >
      <div
        class="settings-section__header"
        hidden={
          headingRepeats() &&
          !(meta().description && !curated()) &&
          !props.form.sectionActions &&
          !hasSectionHelp()
        }
      >
        <Show
          when={!headingRepeats()}
          fallback={
            <Show when={!curated() && meta().description}>
              <div class="settings-section__copy">
                <p class="settings-section__desc">{meta().description}</p>
              </div>
            </Show>
          }
        >
          <h2 class="settings-section__heading">{curated()?.label ?? meta().label}</h2>
        </Show>
        <Show when={props.form.sectionActions || hasSectionHelp()}>
          <div class="settings-section__actions">
            {props.form.sectionActions}
            <Show when={hasSectionHelp()}>
              {
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
                          <For each={liftedHelp()}>{(text) => <p>{text}</p>}</For>
                          <Show when={docsUrl()}>{(url) => <LearnMoreLink url={url()} />}</Show>
                        </div>
                      </Popover>
                    )}
                  </Show>
                </span>
              }
            </Show>
          </div>
        </Show>
      </div>
      <Show when={!curated() && meta().description && !headingRepeats() && !docsUrl()}>
        <p class="settings-section__desc">{meta().description}</p>
      </Show>
      <ConfigTierGroups
        tiers={tiers()}
        flat={Boolean(curated())}
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
              onOpenRaw: props.form.onOpenRaw,
              unsupported: new Set(props.form.unsupportedPaths ?? []),
              disabled: props.form.disabled ?? false,
              showLabel: false,
              showHeaderMeta: true,
              contextLabel: contextLabel(),
              sectionRoot: true,
              collapseObjects: curated() ? !revealTarget() : revealTarget() ? false : undefined,
              progressive: props.form.progressive,
              summarizeObject: curated()?.summarizeObject,
              searchCriteria: parseConfigSearchQuery(props.form.searchQuery ?? ""),
              revealSensitive: props.form.revealSensitive ?? false,
              maskSensitive: props.form.maskSensitive,
              isSensitivePathRevealed: props.form.isSensitivePathRevealed,
              onToggleSensitivePath: props.form.onToggleSensitivePath,
              secretFields: props.form.secretFields,
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
        fallback={<InlineAlert tone="danger">{t("configForm.unsupportedSchema")}</InlineAlert>}
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
          <ConfigSections sections={visibleSections()} form={props} />
        </Show>
      </Show>
    </Show>
  );
}

function ConfigSections(props: { sections: Section[]; form: ConfigFormProps }): SolidJSX.Element {
  const visible = createProgressiveList(() => props.sections, {
    initial: 0,
    batch: 7,
    enabled: () => props.form.progressive === true,
  });
  return (
    <SettingsPage busy={visible.pending()}>
      <For each={visible.items()} keyed={(section) => section.id}>
        {(section) => <ConfigSection section={section()} form={props.form} />}
      </For>
    </SettingsPage>
  );
}
