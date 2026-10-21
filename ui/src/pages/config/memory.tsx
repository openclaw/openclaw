import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, latest, Loading } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import {
  LearnMoreLink,
  SettingsDefaultDescription,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerMemoryImportEnglish } from "../../i18n/locales/en-memory-import.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { memoryAddonPresentations } from "./memory-addon-presentation.ts";
import {
  selectedEngineId,
  DEFAULT_MEMORY_ENGINE_ID,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";

registerEnglishCatalog(registerSettingsEnglish);

registerEnglishCatalog(registerPluginManagementEnglish);

registerEnglishCatalog(registerMemoryImportEnglish);

/**
 * Enablement as the page actually knows it, shared by the engine row and the
 * add-on rows. `loading` and `unknown` exist so a catalog that was never read
 * cannot render as a definite "Disabled"; only a successful read decides.
 */
export type MemoryPluginState = "enabled" | "disabled" | "loading" | "unknown";

export type MemoryCatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; plugins: readonly PluginCatalogItem[]; mutationAllowed: boolean };

function buildMemoryEngineOptions(catalog: MemoryCatalogState, selection: MemoryEngineSelection) {
  if (catalog.kind !== "ready") {
    return [];
  }
  const options = catalog.plugins
    .filter((plugin) => plugin.installed && plugin.kind?.includes("memory") === true)
    .map((plugin) => ({
      id: plugin.id,
      label:
        plugin.id === DEFAULT_MEMORY_ENGINE_ID
          ? t("memoryPage.engine.openClawMemory")
          : plugin.name,
      available: true,
    }))
    .toSorted((left, right) => {
      const leftIsDefault = left.id === DEFAULT_MEMORY_ENGINE_ID;
      const rightIsDefault = right.id === DEFAULT_MEMORY_ENGINE_ID;
      return leftIsDefault === rightIsDefault
        ? left.label.localeCompare(right.label)
        : leftIsDefault
          ? -1
          : 1;
    });
  const selected = selectedEngineId(selection);
  if (selected && !options.some((option) => option.id === selected)) {
    const unavailable = {
      id: selected,
      label:
        selected === DEFAULT_MEMORY_ENGINE_ID ? t("memoryPage.engine.openClawMemory") : selected,
      available: false,
    };
    if (selected === DEFAULT_MEMORY_ENGINE_ID) {
      options.unshift(unavailable);
    } else {
      options.push(unavailable);
    }
  }
  return options;
}

export function resolveMemoryPluginState(
  catalog: MemoryCatalogState,
  entry: PluginCatalogItem | undefined,
): MemoryPluginState {
  if (catalog.kind !== "ready") {
    return catalog.kind === "loading" ? "loading" : "unknown";
  }
  return !entry?.installed || entry.state === "not-installed" || entry.state === "error"
    ? "unknown"
    : entry.enabled
      ? "enabled"
      : "disabled";
}

export function findMemoryCatalogPlugin(catalog: MemoryCatalogState, pluginId: string | null) {
  return catalog.kind === "ready" && pluginId
    ? catalog.plugins.find((plugin) => plugin.id === pluginId)
    : undefined;
}

/** Additive memory plugin: no `kind`, so it layers on top of whichever engine wins the slot. */
type MemoryAddonRow = ReturnType<typeof buildMemoryAddonRows>[number];

function buildMemoryAddonRows(
  catalog: MemoryCatalogState,
  state: {
    errors: Readonly<Partial<Record<string, string>>>;
    notices: Readonly<Partial<Record<string, { message: string }>>>;
    refreshWarnings: Readonly<Partial<Record<string, string>>>;
  },
) {
  return memoryAddonPresentations.map((addon) => {
    const entry = findMemoryCatalogPlugin(catalog, addon.id);
    return {
      id: addon.id,
      label: t(addon.labelKey),
      description: entry?.description ?? addon.id,
      state: resolveMemoryPluginState(catalog, entry),
      error: state.errors[addon.id] ?? null,
      notice:
        [state.notices[addon.id]?.message, state.refreshWarnings[addon.id]]
          .filter(Boolean)
          .join(" ") || null,
    };
  });
}

export type MemoryEngineOutcome = { kind: "error" | "warning"; message: string };

type MemoryViewProps = {
  activeTab: MemoryTab;
  onTabChange: (tab: MemoryTab) => void;
  catalog: MemoryCatalogState;
  catalogScope?: object | null;
  addonOutcomes: Parameters<typeof buildMemoryAddonRows>[1];
  /** Read optimistic state at the control, outside held catalog and parent snapshots. */
  readAddonExpected: (id: string) => boolean | undefined;
  readAddonBusy: (id: string) => boolean;
  engineSelection: MemoryEngineSelection;
  enginePending?: boolean;
  engineBusy: boolean;
  /** Distinguishes a rejected write from a committed write with a failed refresh. */
  engineOutcome: MemoryEngineOutcome | null;
  onEngineChange: (engineId: string | null) => void;
  canToggleAddons: boolean;
  onAddonChange: (pluginId: string, enabled: boolean) => void;
  pluginsHref: string;
  memoryImportHref: string;
  canImportMemory: boolean;
  overview: JSX.Element;
  memories: JSX.Element;
  dreams: JSX.Element;
  /** One embedded editor for every `memory.*` schema field. */
  editor: JSX.Element;
  /** Global dreaming controls, sharing runtimeConfig with the editor above. */
  dreamingSettings: JSX.Element;
};

const MEMORY_PANEL_ID = "memory-settings-panel";

const MEMORY_DOCS_URL = "https://docs.openclaw.ai/concepts/memory";

const MEMORY_ENGINE_OFF = "";

function engineHintKey(selection: MemoryEngineSelection): string {
  switch (selection.kind) {
    case "default":
      return "memoryPage.engine.autoHint";
    case "off":
      return "memoryPage.engine.offHint";
    default:
      return "memoryPage.engine.explicitHint";
  }
}

function EngineSection(props: MemoryViewProps) {
  // The slot is exclusive (resolveMemorySlotDecisionShared): only one memory-kind
  // plugin loads. A segmented control states that up front instead of leaving it
  // to a post-save toast.
  const engineId = () => selectedEngineId(props.engineSelection);
  const engineOptions = createMemo(() =>
    buildMemoryEngineOptions(props.catalog, props.engineSelection),
  );
  const blocked = () =>
    props.engineBusy || (props.catalog.kind === "ready" && !props.catalog.mutationAllowed);
  const defaultEngine = () =>
    engineOptions().find((option) => option.id === DEFAULT_MEMORY_ENGINE_ID)?.label ??
    t("memoryPage.engine.openClawMemory");
  const defaultDescription = (
    <SettingsDefaultDescription
      value={defaultEngine()}
      overridden={props.engineSelection.kind !== "default"}
    />
  );
  const available = () => engineOptions().length > 0;
  const options = () => [
    ...engineOptions().map((option) => ({
      value: option.id,
      label: option.available
        ? option.label
        : `${option.label} (${t("memoryPage.engine.unavailable")})`,
    })),
    { value: MEMORY_ENGINE_OFF, label: t("memoryPage.engine.off") },
  ];
  return (
    <SettingsSection
      title={t("memoryPage.engine.title")}
      description={t("memoryPage.engine.description")}
    >
      <>
        <SettingsRow
          title={t("memoryPage.engine.rowTitle")}
          description={
            <>
              {" "}
              {!available() && t("memoryPage.engine.catalogUnavailable")}
              {t(engineHintKey(props.engineSelection))} {defaultDescription}{" "}
            </>
          }
          stacked={available()}
          control={
            available() ? (
              <SettingsSegmented
                value={engineId() ?? MEMORY_ENGINE_OFF}
                options={options()}
                disabled={blocked()}
                ariaLabel={t("memoryPage.engine.rowTitle")}
                onChange={(value) => props.onEngineChange(value || null)}
              />
            ) : (
              <SettingsValue mono={true} value={engineId() ?? t("memoryPage.engine.off")} />
            )
          }
        />
        {available() ? <DisabledEngineRow {...props} engineBusy={blocked()} /> : undefined}
        {!available() || props.engineOutcome === null ? undefined : (
          <SettingsRow
            title={t(
              props.engineOutcome.kind === "error"
                ? "memoryPage.engine.changeFailed"
                : "pluginsPage.needsAttention",
            )}
            description={props.engineOutcome.message}
            control={
              <SettingsStatus
                kind={props.engineOutcome.kind === "error" ? "danger" : "warn"}
                label={t(
                  props.engineOutcome.kind === "error"
                    ? "common.failed"
                    : "pluginsPage.needsAttention",
                )}
              />
            }
          />
        )}
      </>
    </SettingsSection>
  );
}

/**
 * The segmented control shows the slot owner, which stays selected even when
 * that plugin is disabled — so re-picking it fires no change event and there
 * would be no way back. This row is the only path that re-enables the owner.
 */
function DisabledEngineRow(props: MemoryViewProps) {
  const engineId = () => selectedEngineId(props.engineSelection);
  const state = () =>
    resolveMemoryPluginState(props.catalog, findMemoryCatalogPlugin(props.catalog, engineId()));
  return (
    <>
      {!props.enginePending && engineId() !== null && state() === "disabled" && (
        <SettingsRow
          title={t("memoryPage.engine.disabledTitle")}
          description={t("memoryPage.engine.disabledHint")}
          control={
            <button
              class="btn btn--sm"
              disabled={props.engineBusy}
              onClick={() => props.onEngineChange(engineId())}
            >
              {t("memoryPage.engine.enable")}
            </button>
          }
        />
      )}
    </>
  );
}

// Only `enabled` is a positive claim; the other three are deliberately muted so
// an unread catalog never looks like a decided "off".
function AddonStatus(props: { state: MemoryPluginState }) {
  return (
    <SettingsStatus
      kind={props.state === "enabled" ? "ok" : "muted"}
      label={t(
        props.state === "enabled" || props.state === "disabled" || props.state === "loading"
          ? `common.${props.state}`
          : "memoryPage.addons.stateUnknown",
      )}
    />
  );
}

function AddonRow(props: { addon: MemoryAddonRow; owner: MemoryViewProps }) {
  // Read optimistic affordances at the control, outside the held catalog row snapshot.
  // A retry dismisses the old error ahead of its action's held catalog update.
  const error = () => (props.owner.readAddonBusy(props.addon.id) ? null : props.addon.error);
  return (
    <>
      {props.owner.canToggleAddons &&
      props.owner.catalog.kind === "ready" &&
      props.owner.catalog.mutationAllowed &&
      (props.addon.state === "enabled" || props.addon.state === "disabled") ? (
        <SettingsToggleRow
          title={props.addon.label}
          ariaLabel={t("memoryPage.addons.toggleAriaLabel", { plugin: props.addon.label })}
          description={props.addon.description}
          checked={props.owner.readAddonExpected(props.addon.id) ?? props.addon.state === "enabled"}
          disabled={props.owner.readAddonBusy(props.addon.id)}
          onChange={(enabled) => props.owner.onAddonChange(props.addon.id, enabled)}
        />
      ) : (
        <SettingsRow
          title={props.addon.label}
          description={props.addon.description}
          control={<AddonStatus state={props.addon.state} />}
        />
      )}
      {latest(error) === null ? undefined : (
        <SettingsRow
          title={t("memoryPage.addons.changeFailed", { plugin: props.addon.label })}
          description={error()}
          control={<SettingsStatus kind="danger" label={t("common.failed")} />}
        />
      )}
      {props.addon.notice === null ? undefined : (
        <SettingsRow
          title={t("pluginsPage.needsAttention")}
          description={props.addon.notice}
          control={<SettingsStatus kind="warn" label={t("pluginsPage.needsAttention")} />}
        />
      )}
    </>
  );
}

function AddonsSection(props: MemoryViewProps) {
  const addons = createMemo(() => buildMemoryAddonRows(props.catalog, props.addonOutcomes));
  return (
    <SettingsSection
      title={t("memoryPage.addons.title")}
      description={t("memoryPage.addons.description")}
    >
      <For each={addons()} keyed={(addon) => addon.id}>
        {(addon) => <AddonRow addon={addon()} owner={props} />}
      </For>
      <SettingsRow
        title={t("memoryPage.addons.manage")}
        control={
          <a class="memory-page__link" href={props.pluginsHref}>
            {t("memoryPage.addons.manageLink")}
          </a>
        }
      />
    </SettingsSection>
  );
}

function MemoryCatalogSections(props: MemoryViewProps) {
  return (
    <>
      <EngineSection {...props} />
      <AddonsSection {...props} />
    </>
  );
}

function SettingsTab(props: MemoryViewProps) {
  const catalogScope = createMemo(() => props.catalogScope);
  return (
    <ShellLayoutBoundary traits={{ settingsPage: true }}>
      <div class="settings-page">
        <Errored
          fallback={(_error) => (
            <MemoryCatalogSections {...props} catalog={{ kind: "unavailable" }} />
          )}
        >
          <Loading
            on={catalogScope()}
            fallback={<MemoryCatalogSections {...props} catalog={{ kind: "loading" }} />}
          >
            <MemoryCatalogSections {...props} />
          </Loading>
        </Errored>
        <p class="settings-page__intro">{t("memoryPage.search.intro")}</p>
      </div>
      {props.editor}
      <div class="settings-page">
        {props.dreamingSettings}
        <SettingsSection
          title={t("memoryPage.import.title")}
          description={t("memoryPage.import.description")}
        >
          <SettingsRow
            title={t("tabs.memoryImport")}
            description={t("subtitles.memoryImport")}
            control={
              props.canImportMemory ? (
                <>
                  {" "}
                  <a class="memory-page__link" href={props.memoryImportHref}>
                    {t("memoryPage.import.link")}
                  </a>{" "}
                </>
              ) : (
                <SettingsValue value={t("memoryImport.adminRequired")} />
              )
            }
          />
        </SettingsSection>
      </div>
    </ShellLayoutBoundary>
  );
}

export function Memory(props: MemoryViewProps) {
  return (
    <ShellLayoutBoundary traits={{ memoryPage: true, toolbarHeader: true }}>
      <section class="memory-page">
        <section class="content-header content-header--settings content-header--page hub-page-header">
          <div class="hub-page-header__title">
            <div class="page-title">{t("tabs.memory")}</div>
            <div class="page-subtitle">
              {t("memoryPage.intro")} <LearnMoreLink url={MEMORY_DOCS_URL} />
            </div>
          </div>
          <div class="hub-page-header__tabs">
            <HubTabs<MemoryTab>
              id="memory"
              active={props.activeTab}
              tabs={[
                { value: "overview", label: t("memoryPage.tabs.overview") },
                { value: "memories", label: t("memoryPage.tabs.memories") },
                { value: "dreams", label: t("memoryPage.tabs.dreams") },
                { value: "settings", label: t("memoryPage.tabs.settings") },
              ]}
              ariaLabel={t("memoryPage.tablistLabel")}
              panelId={MEMORY_PANEL_ID}
              onSelect={(tab) => props.onTabChange(tab)}
            />
          </div>
        </section>
        <div id={MEMORY_PANEL_ID} class="memory-page__panel" role="tabpanel">
          {props.activeTab === "overview" ? (
            props.overview
          ) : props.activeTab === "memories" ? (
            props.memories
          ) : props.activeTab === "dreams" ? (
            props.dreams
          ) : (
            <SettingsTab {...props} />
          )}
        </div>
      </section>
    </ShellLayoutBoundary>
  );
}
