import { createMemo, createSignal, For, untrack } from "solid-js";
import "../../styles/lobster-pet.css";
import { ConfigForm } from "../../components/config-form.render.tsx";
import { countSensitiveConfigValues } from "../../components/config-form.shared.ts";
import { HighlightedJson } from "../../components/solid/highlighted-json.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/tooltip.ts";
import { SettingsSegmented, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { isJson5Warm, warmJson5 } from "../../lib/json5-runtime.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { NotificationsSection } from "./notifications-section.tsx";
import { SetupSection } from "./setup.tsx";
import { AppearanceSection } from "./view-appearance.tsx";
import { computeRawDiff, formatConfigDiffPath, renderRawDiffValue } from "./view-diff.ts";
import {
  CATEGORISED_KEYS,
  ConfigAccordionNav,
  getChannelConfigGroups,
  SECTION_CATEGORIES,
  type SectionCategory,
} from "./view-navigation.tsx";
import {
  asConfigSchema,
  configValueExistsAtPath,
  getConfigSchemaAnalysis,
  UnsupportedPathSummary,
} from "./view-schema.tsx";
import {
  configContextKey,
  isSensitivePathRevealed,
  resetConfigEphemeralState,
  toggleSensitivePathReveal,
} from "./view-state.ts";
import type { ConfigProps } from "./view-types.ts";

registerEnglishCatalog(registerSettingsEnglish);
export { createConfigViewState } from "./view-state.ts";
export type { ConfigProps, ConfigViewState } from "./view-types.ts";
void warmJson5().catch(() => undefined);

function resetContentScroll(target: EventTarget | null) {
  queueMicrotask(() => {
    const origin = target instanceof Element ? target : null;
    const targets = [
      origin
        ?.closest(".config-lead")
        ?.parentElement?.querySelector<HTMLElement>(".config-content") ??
        document.querySelector<HTMLElement>(".config-content"),
      document.querySelector<HTMLElement>(".shell--settings .content"),
    ];
    for (const content of targets) {
      if (!content) {
        continue;
      }
      if (typeof content.scrollTo === "function") {
        content.scrollTo({ top: 0, left: 0, behavior: "auto" });
      } else {
        content.scrollTop = 0;
        content.scrollLeft = 0;
      }
    }
  });
}

export function Config(props: ConfigProps) {
  // The page owns these plain presentation facts; the revision only invalidates readers.
  const [revision, setRevision] = createSignal(0);
  const refresh = () => {
    setRevision((value) => value + 1);
    props.onViewStateChange();
  };
  const view = () => {
    revision();
    return props.viewState;
  };
  const state = createMemo(() => {
    const viewState = view();
    const showModeToggle = props.showModeToggle ?? false;
    const includeVirtualSections = props.includeVirtualSections ?? true;
    const include = props.includeSections?.length ? new Set(props.includeSections) : null;
    const exclude = props.excludeSections?.length ? new Set(props.excludeSections) : null;
    const analysis = getConfigSchemaAnalysis(
      viewState,
      asConfigSchema(props.schema),
      include,
      exclude,
    );
    const unsupportedActivePaths = analysis.unsupportedPaths.filter(
      (path) =>
        path !== "<root>" &&
        (!props.activeSection ||
          path === props.activeSection ||
          path.startsWith(`${props.activeSection}.`)) &&
        configValueExistsAtPath(props.formValue, path),
    );
    const rawAvailable = props.rawAvailable ?? true;
    const rawDraftPending = Boolean(props.rawDraftPending) && rawAvailable;
    const formMode = rawDraftPending
      ? "raw"
      : showModeToggle && rawAvailable
        ? props.formMode
        : "form";
    if (viewState.lastFormModeForScroll !== null && viewState.lastFormModeForScroll !== formMode) {
      resetContentScroll(null);
    }
    viewState.lastFormModeForScroll = formMode;
    const contextKey = configContextKey(props);
    if (viewState.lastConfigContextKey !== contextKey) {
      resetConfigEphemeralState(viewState);
      viewState.lastConfigContextKey = contextKey;
    }
    const schemaProps = analysis.schema?.properties ?? {};
    const virtualSections = new Set(["__appearance__", "__notifications__"]);
    const visibleVirtual = (key: string) =>
      includeVirtualSections &&
      virtualSections.has(key) &&
      (key === "__appearance__" || include?.has(key) === true);
    const sectionLabel = (key: string) =>
      t(
        `configView.sections.${key === "__appearance__" ? "theme" : key === "__notifications__" ? "notifications" : key}`,
      );
    const categories: SectionCategory[] = SECTION_CATEGORIES.map((category) => ({
      id: category.id,
      label: t(`configView.categories.${category.id}`),
      sections: category.sections
        .filter(
          (key) =>
            (visibleVirtual(key) || key in schemaProps) &&
            (!include || include.has(key)) &&
            (!exclude || !exclude.has(key)),
        )
        .map((key) => ({ key, label: sectionLabel(key) })),
    })).filter((category) => category.sections.length > 0);
    const extras = Object.keys(schemaProps)
      .filter((key) => !CATEGORISED_KEYS.has(key))
      .map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1) }));
    if (extras.length) {
      categories.push({ id: "other", label: t("configView.categories.other"), sections: extras });
    }
    const channelSchema = props.activeSection === "channels" ? schemaProps.channels : undefined;
    const channelGroups = channelSchema ? getChannelConfigGroups(channelSchema, props.uiHints) : [];
    const channelGroup =
      channelGroups.find((group) => group.key === props.activeSubsection) ?? channelGroups[0];
    const formSchema =
      channelSchema && channelGroup
        ? {
            ...analysis.schema,
            properties: {
              ...schemaProps,
              channels: {
                ...channelSchema,
                properties: Object.fromEntries(
                  Object.entries(channelSchema.properties ?? {}).filter(([key]) =>
                    channelGroup.keys.includes(key),
                  ),
                ),
                required: channelSchema.required?.filter((key) => channelGroup.keys.includes(key)),
                additionalProperties: false,
              },
            },
          }
        : analysis.schema;
    const setupSchema = formSchema?.properties?.wizard;
    const editorSchema = setupSchema
      ? {
          ...formSchema,
          properties: Object.fromEntries(
            Object.entries(formSchema.properties ?? {}).filter(([key]) => key !== "wizard"),
          ),
        }
      : formSchema;
    const topTabs: Array<{ key: string | null; label: string }> = [
      ...((props.showRootTab ?? true)
        ? [{ key: null, label: props.navRootLabel ?? t("nav.settings") }]
        : []),
      ...categories.flatMap((category) => category.sections),
    ];
    const hasRawChanges = formMode === "raw" && props.raw !== props.originalRaw;
    if (!hasRawChanges) {
      viewState.rawDiffOpen = false;
    }
    if (!hasRawChanges || !viewState.rawDiffOpen) {
      viewState.rawDiffCache = undefined;
    }
    const rawDiff =
      hasRawChanges && viewState.rawDiffOpen
        ? computeRawDiff(viewState, props.originalRaw, props.raw)
        : [];
    if (hasRawChanges && viewState.rawDiffOpen && !isJson5Warm()) {
      void warmJson5()
        .then(refresh)
        .catch(() => undefined);
    }
    const configBusy = props.loading || props.saving || props.applying || props.updating;
    const formBusy = configBusy || props.schemaLoading;
    const mutationAllowed = props.mutationAllowed !== false;
    const showSetup = Boolean(
      setupSchema && (!props.activeSection || props.activeSection === "wizard"),
    );
    const showSectionTabs = props.settingsLayout !== "accordion" && topTabs.length > 1;
    const showToolbar = showModeToggle || showSectionTabs;
    const showValidityWarning = props.valid === false && !viewState.validityDismissed;
    const sensitiveCount = countSensitiveConfigValues(props.formValue, [], props.uiHints);
    return {
      showModeToggle,
      includeVirtualSections,
      include,
      analysis,
      unsupportedActivePaths,
      rawAvailable,
      rawDraftPending,
      formMode,
      categories,
      channelGroups,
      channelGroup,
      editorSchema,
      setupSchema,
      showSetup,
      topTabs,
      hasRawChanges,
      rawDiff,
      configBusy,
      formBusy,
      mutationAllowed,
      showSchemaLoading: props.schemaLoading && !analysis.schema,
      showSectionTabs,
      showToolbar,
      showValidityWarning,
      showLead:
        showToolbar ||
        props.settingsLayout === "accordion" ||
        showValidityWarning ||
        Boolean(channelGroup),
      sensitiveCount,
    };
  });
  function FormEditor() {
    const editor = (
      <ConfigForm
        schema={state().editorSchema}
        uiHints={props.uiHints}
        value={props.formValue}
        embedded={props.embeddedEditor === true || state().showSetup}
        rawAvailable={state().rawAvailable}
        disabled={state().formBusy || !props.formValue || !state().mutationAllowed}
        unsupportedPaths={state().analysis.unsupportedPaths}
        onPatch={props.onFormPatch}
        onRemove={props.onFormRemove}
        activeSection={props.activeSection}
        activeSubsection={null}
        showAdvanced={props.forceShowAdvanced === true || props.showAdvancedSettings}
        forceAdvancedSection={props.forceAdvancedSection}
        onShowAdvanced={() => props.onAppearanceChange({ showAdvancedSettings: true })}
        onHideAdvanced={
          props.forceShowAdvanced
            ? undefined
            : () => props.onAppearanceChange({ showAdvancedSettings: false })
        }
        sectionActions={
          props.activeSection === "env" ? (
            <button
              class={["btn btn--sm", { active: view().envRevealed }]}
              aria-pressed={view().envRevealed ? "true" : "false"}
              title={t(
                view().envRevealed ? "configView.hideEnvValues" : "configView.revealEnvValues",
              )}
              onClick={() => {
                view().envRevealed = !view().envRevealed;
                refresh();
              }}
            >
              <Icon name={view().envRevealed ? "eyeOff" : "eye"} />
              {t("configView.peek")}
            </button>
          ) : undefined
        }
        showSectionDocs={props.showSectionDocs}
        sectionPrelude={props.sectionPrelude}
        revealSensitive={props.activeSection === "env" && view().envRevealed}
        maskSensitive
        isSensitivePathRevealed={(path) => isSensitivePathRevealed(view(), path)}
        onToggleSensitivePath={(path) => {
          toggleSensitivePathReveal(view(), path);
          refresh();
        }}
      />
    );
    // The section renderer is a stable factory; recreating it discards live field nodes.
    const renderSection = untrack(() => props.renderSection);
    return renderSection ? renderSection(editor) : editor;
  }
  return (
    <>
      {state().showLead ? (
        <div class="config-lead">
          {state().showToolbar ? (
            <div class="config-toolbar">
              {state().showModeToggle ? (
                <SettingsSegmented
                  mode="buttons"
                  variant="primary"
                  value={state().formMode}
                  onChange={props.onFormModeChange}
                  onReselect={props.onFormModeChange}
                  options={[
                    {
                      value: "form",
                      label: t("configView.form"),
                      disabled: props.schemaLoading || !props.schema || state().rawDraftPending,
                      title: state().rawDraftPending
                        ? t("configView.rawDraftPendingFormTitle")
                        : state().unsupportedActivePaths.length
                          ? t("configView.formUnsafeTitle")
                          : "",
                    },
                    {
                      value: "raw",
                      label: t("configView.raw"),
                      disabled: !state().rawAvailable,
                      title: t(
                        state().rawAvailable
                          ? "configView.rawTitle"
                          : "configView.rawUnavailableTitle",
                      ),
                    },
                  ]}
                />
              ) : null}
              {state().showSectionTabs ? (
                <HubTabs
                  id="config-sections"
                  active={props.activeSection ?? "root"}
                  tabs={state().topTabs.map((tab) => ({
                    value: tab.key ?? "root",
                    label: tab.label,
                  }))}
                  ariaLabel={t("common.settingsSections")}
                  panelId="config-section-panel"
                  onSelect={(value) => props.onSectionChange(value === "root" ? null : value)}
                  onActivate={resetContentScroll}
                />
              ) : null}
            </div>
          ) : null}
          {props.settingsLayout === "accordion" ? (
            <ConfigAccordionNav
              activeSection={props.activeSection}
              onSectionChange={props.onSectionChange}
              categories={state().categories}
              resetContentScroll={resetContentScroll}
            />
          ) : null}
          {state().channelGroup && state().formMode === "form" ? (
            <div class="config-toolbar">
              <label class="field">
                <span>{t("configView.channelSettings")}</span>
                <select
                  class="settings-select"
                  value={state().channelGroup.key ?? ""}
                  onChange={(event) => {
                    props.onSubsectionChange(event.currentTarget.value || null);
                    resetContentScroll(event.currentTarget);
                  }}
                >
                  <For each={state().channelGroups} keyed={(group) => group.key}>
                    {(group) => (
                      <option
                        value={group().key ?? ""}
                        selected={group().key === state().channelGroup.key}
                      >
                        {group().label}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </div>
          ) : null}
          {state().showValidityWarning ? (
            <div class="config-validity-warning">
              <Icon name="alertTriangle" class="config-validity-warning__icon" />
              <span class="config-validity-warning__text">{t("configView.invalidConfig")}</span>
              <button
                class="btn btn--sm"
                onClick={() => {
                  view().validityDismissed = true;
                  refresh();
                }}
              >
                {t("configView.dismissWarning")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        id="config-section-panel"
        class="config-content"
        role={state().showSectionTabs ? "tabpanel" : "region"}
        aria-busy={state().formMode === "form" && props.schemaLoading ? "true" : undefined}
        aria-labelledby={
          state().showSectionTabs
            ? `config-sections-tab-${props.activeSection ?? "root"}`
            : undefined
        }
        aria-label={state().showSectionTabs ? undefined : t("common.settingsSections")}
      >
        {props.activeSection === "__appearance__" ? (
          state().includeVirtualSections ? (
            <AppearanceSection {...props} />
          ) : null
        ) : props.activeSection === "__notifications__" ? (
          state().includeVirtualSections ? (
            <NotificationsSection {...props} />
          ) : null
        ) : state().formMode === "form" ? (
          <>
            {state().unsupportedActivePaths.length > 0 &&
            state().showModeToggle &&
            state().rawAvailable ? (
              <div class="config-content-callout">
                <div class="callout info">
                  <UnsupportedPathSummary paths={state().unsupportedActivePaths} />{" "}
                  <button
                    type="button"
                    class="btn btn--sm"
                    onClick={() => props.onFormModeChange("raw")}
                  >
                    {t("configView.openRawEditor")}
                  </button>
                </div>
              </div>
            ) : null}
            {state().includeVirtualSections &&
            props.activeSection === null &&
            state().include?.has("__appearance__") ? (
              <AppearanceSection {...props} />
            ) : null}
            {state().showSchemaLoading ? (
              <div class="config-loading">
                <div class="config-loading__spinner" />
                <span>{t("configView.loadingSchema")}</span>
              </div>
            ) : (
              <FormEditor />
            )}
            {state().showSetup && !state().showSchemaLoading ? (
              <SetupSection
                schema={state().setupSchema!}
                config={props}
                disabled={state().formBusy || !props.formValue || !state().mutationAllowed}
              />
            ) : null}
          </>
        ) : (
          <SettingsPage>
            {state().hasRawChanges ? (
              <details
                class="config-diff"
                open={view().rawDiffOpen}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  if (view().rawDiffOpen === open) {
                    return;
                  }
                  view().rawDiffOpen = open;
                  if (!open) {
                    view().rawDiffCache = undefined;
                  }
                  refresh();
                }}
              >
                <summary class="config-diff__summary">
                  <span>{t("configView.viewPendingChangesRaw")}</span>
                  <svg
                    class="config-diff__chevron"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </summary>
                <div class="config-diff__content">
                  <For
                    each={state().rawDiff}
                    fallback={
                      <div class="config-diff__item">{t("configView.rawDiffUnavailable")}</div>
                    }
                  >
                    {(change) => (
                      <div class="config-diff__item">
                        <div class="config-diff__path">{formatConfigDiffPath(change.path)}</div>
                        <div class="config-diff__values">
                          <span class="config-diff__from">
                            {renderRawDiffValue(
                              change.path,
                              change.from,
                              props.uiHints,
                              view().rawRevealed,
                            )}
                          </span>
                          <span class="config-diff__arrow">→</span>
                          <span class="config-diff__to">
                            {renderRawDiffValue(
                              change.path,
                              change.to,
                              props.uiHints,
                              view().rawRevealed,
                            )}
                          </span>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </details>
            ) : null}
            <div class="settings-group">
              <div class="settings-row settings-row--stacked">
                <div class="config-raw-actions">
                  {props.onOpenFile && props.openFileAllowed !== false ? (
                    <button class="btn btn--sm" onClick={props.onOpenFile}>
                      <Icon name="fileText" />
                      {t("configView.open")}
                    </button>
                  ) : null}
                  <button
                    class="btn btn--sm"
                    disabled={state().configBusy || !state().hasRawChanges}
                    onClick={props.onRawDiscard}
                  >
                    {t("configView.rawDiscard")}
                  </button>
                  <button
                    class="btn btn--sm primary"
                    disabled={
                      !props.connected ||
                      !state().mutationAllowed ||
                      state().configBusy ||
                      !state().hasRawChanges
                    }
                    aria-busy={props.saving ? "true" : "false"}
                    onClick={props.onSave}
                  >
                    {props.saving ? (
                      <>
                        <span class="config-action-spinner" aria-hidden="true">
                          <Icon name="loader" />
                        </span>
                        {t("common.saving")}
                      </>
                    ) : (
                      t("common.save")
                    )}
                  </button>
                </div>
                <div class="field config-raw-field">
                  <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    {t("configView.rawConfig")}
                    {state().sensitiveCount > 0 ? (
                      <>
                        <span class="settings-count">
                          {t(
                            state().sensitiveCount === 1
                              ? "configView.secretCount"
                              : "configView.secretCountPlural",
                            { count: String(state().sensitiveCount) },
                          )}{" "}
                          {t(view().rawRevealed ? "configView.visible" : "configView.redacted")}
                        </span>
                        <openclaw-tooltip
                          prop:content={t(
                            view().rawRevealed
                              ? "configView.hideSensitive"
                              : "configView.revealSensitive",
                          )}
                        >
                          <button
                            class={[
                              "btn btn--icon config-raw-toggle",
                              { active: view().rawRevealed },
                            ]}
                            aria-label={t("configView.toggleRawRedaction")}
                            aria-pressed={view().rawRevealed ? "true" : "false"}
                            onClick={() => {
                              view().rawRevealed = !view().rawRevealed;
                              refresh();
                            }}
                          >
                            <Icon name={view().rawRevealed ? "eye" : "eyeOff"} />
                          </button>
                        </openclaw-tooltip>
                      </>
                    ) : null}
                  </span>
                  {state().sensitiveCount > 0 && !view().rawRevealed ? (
                    <div class="callout info" style={{ "margin-top": "12px" }}>
                      {t(
                        state().sensitiveCount === 1
                          ? "configView.sensitiveHidden"
                          : "configView.sensitiveHiddenPlural",
                        { count: String(state().sensitiveCount) },
                      )}
                    </div>
                  ) : (
                    <textarea
                      aria-label={t("configView.rawConfig")}
                      placeholder={t("configView.rawConfig")}
                      value={props.raw}
                      disabled={state().configBusy || !state().mutationAllowed}
                      onInput={(event) => props.onRawChange(event.currentTarget.value)}
                    />
                  )}
                </div>
              </div>
            </div>
          </SettingsPage>
        )}
        {props.issues.length > 0 ? (
          <div class="config-content-callout">
            <div class="callout danger">
              <HighlightedJson class="code-block" value={props.issues} />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
