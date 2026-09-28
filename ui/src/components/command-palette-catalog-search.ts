import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  ModelCatalogResult,
  SkillStatusReport,
} from "../api/types.ts";
import {
  SETTINGS_SEARCHABLE_SUBPAGE_ROUTES,
  settingsNavigationLabelForRoute,
  subtitleForRoute,
  visibleSettingsNavigationGroups,
} from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { NativeDeviceSettingsCapability } from "../app/native-device-settings.ts";
import { t } from "../i18n/index.ts";
import { registerAppsEnglish } from "../i18n/locales/en-apps.ts";
import { registerCommandPaletteEnglish } from "../i18n/locales/en-command-palette.ts";
import { loadCronCatalog } from "../lib/cron/catalog.ts";
import type { PluginListResult } from "../lib/plugins/index.ts";
import { SETTINGS_SEARCH_TARGETS } from "../pages/config/settings-targets.ts";
import type { IconName } from "./icons.ts";

registerCommandPaletteEnglish();

registerAppsEnglish();

export type CommandPaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category:
    | "agents"
    | "apps"
    | "automations"
    | "models"
    | "plugins"
    | "settings"
    | "skills"
    | "search"
    | "navigation"
    | "chats"
    | "messages";
  action: string;
  session?: GatewaySessionRow;
  search?: string;
  hash?: string;
  agentId?: string;
  pluginId?: string;
  catalogId?: string;
  hasPluginIcon?: boolean;
  description?: string;
  searchText?: string;
  /** Searchable only while the current model catalog permits unrestricted selection. */
  primaryModel?: string;
};

const CATEGORY_LABEL_KEYS = new Map([
  ["search", "palette.categories.search"],
  ["navigation", "palette.categories.navigation"],
  ["skills", "palette.categories.skills"],
  ["agents", "palette.items.agents"],
  ["apps", "palette.items.apps"],
  ["automations", "palette.items.scheduled"],
  ["models", "routeTitles.modelProviders"],
  ["plugins", "palette.items.plugins"],
  ["settings", "palette.items.settings"],
  ["chats", "sessionsView.title"],
  ["messages", "palette.categories.messages"],
]);

export function commandPaletteCategoryLabel(category: string): string {
  const key = CATEGORY_LABEL_KEYS.get(category);
  return key ? t(key) : category;
}

const CATALOG_SEARCH_LIMIT = 10;

function navigationItem(
  routeId: RouteId,
  label: string,
  icon: IconName,
  options: { id?: string; description?: string } = {},
): CommandPaletteItem {
  return {
    ...options,
    id: `nav-${options.id ?? routeId}`,
    label,
    icon,
    category: "navigation",
    action: `nav:${routeId}`,
  };
}

function getCommandPaletteBaseItems(
  desktopAvailable: boolean,
  custodianAvailable: boolean,
): CommandPaletteItem[] {
  return [
    navigationItem("new-session", t("newSession.title"), "plus"),
    navigationItem("sessions", t("palette.items.sessions"), "fileText"),
    navigationItem("meetings", t("tabs.meetings"), "book", {
      description: t("subtitles.meetings"),
    }),
    navigationItem("cron", t("palette.items.scheduled"), "scrollText"),
    navigationItem("skills", t("palette.items.skills"), "zap"),
    navigationItem("plugins", t("palette.items.plugins"), "plug"),
    navigationItem("apps", t("palette.items.apps"), "layoutGrid"),
    navigationItem("appearance", t("palette.items.settings"), "settings", { id: "settings" }),
    navigationItem("agents", t("palette.items.agents"), "folder"),
    {
      id: "slash:verbose",
      label: "/verbose",
      icon: "terminal",
      category: "search",
      action: "/verbose full",
      description: t("palette.descriptions.verboseMode"),
    },
    ...(desktopAvailable
      ? [
          {
            id: "panel-desktop",
            label: t("palette.items.desktop"),
            icon: "monitor" as const,
            category: "navigation" as const,
            action: "panel:desktop",
          },
        ]
      : []),
    ...(custodianAvailable
      ? [
          {
            id: "panel-custodian",
            label: t("nav.askOpenClaw"),
            icon: "lobster" as const,
            category: "navigation" as const,
            action: "panel:custodian",
          },
        ]
      : []),
  ];
}

export function filterCommandPaletteItems(params: {
  query: string;
  includeSlashCommands: boolean;
  sessionItems: readonly CommandPaletteItem[];
  catalogItems: readonly CommandPaletteItem[];
  desktopAvailable: boolean;
  custodianAvailable: boolean;
  primaryModelSearch?: boolean;
}): CommandPaletteItem[] {
  const baseItems = getCommandPaletteBaseItems(
    params.desktopAvailable,
    params.custodianAvailable,
  ).filter((item) => params.includeSlashCommands || item.category !== "search");
  if (!params.query) {
    return baseItems;
  }
  const query = normalizeLowercaseStringOrEmpty(params.query);
  const matchRank = (item: CommandPaletteItem) => {
    const label = normalizeLowercaseStringOrEmpty(item.label);
    if (label === query) {
      return 3;
    }
    if (label.startsWith(query)) {
      return 2;
    }
    return label.includes(query) ||
      normalizeLowercaseStringOrEmpty(item.description).includes(query) ||
      normalizeLowercaseStringOrEmpty(item.searchText).includes(query) ||
      (params.primaryModelSearch &&
        normalizeLowercaseStringOrEmpty(item.primaryModel).includes(query))
      ? 1
      : 0;
  };
  const baseMatches = baseItems.filter((item) => matchRank(item) > 0);
  const catalogMatches = params.catalogItems
    .map((item) => ({ item, rank: matchRank(item) }))
    .filter(({ rank }) => rank > 0)
    .toSorted(
      (left, right) => right.rank - left.rank || left.item.label.localeCompare(right.item.label),
    )
    .slice(0, CATALOG_SEARCH_LIMIT)
    .map(({ item }) => item);
  return [...params.sessionItems, ...baseMatches, ...catalogMatches];
}

const APP_CARDS = [
  "ios",
  "android",
  "appleWatch",
  "wearOs",
  "macos",
  "windows",
  "linux",
  "chrome",
  "plugins",
] as const;

export function getStaticCommandPaletteCatalogItems(
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null = null,
): CommandPaletteItem[] {
  const settings = visibleSettingsNavigationGroups(canAdmin, nativeDeviceSettings)
    .flatMap((group) => group.routes)
    .concat(SETTINGS_SEARCHABLE_SUBPAGE_ROUTES)
    .map((routeId) => ({
      id: `settings-${routeId}`,
      label: settingsNavigationLabelForRoute(routeId),
      icon: "settings" as const,
      category: "settings" as const,
      action: `nav:${routeId}`,
      description: subtitleForRoute(routeId),
      searchText: routeId,
    }));
  const apps = APP_CARDS.map((card) => ({
    id: `app-${card}`,
    label: t(`appsPage.cards.${card}.title`),
    icon: "layoutGrid" as const,
    category: "apps" as const,
    action: "nav:apps",
    description: t(`appsPage.cards.${card}.desc`),
    searchText: card,
  }));
  const capture = SETTINGS_SEARCH_TARGETS.meetingCapture;
  return [
    ...settings,
    ...(canAdmin
      ? [
          {
            id: "settings-meeting-capture",
            label: t(capture.labelKey),
            icon: "settings" as const,
            category: "settings" as const,
            action: `nav:${capture.routeId}`,
            search: capture.search,
            hash: capture.hash,
            searchText: capture.aliases,
          },
        ]
      : []),
    ...apps,
  ];
}

export async function loadCommandPaletteCatalogItems(params: {
  client: GatewayBrowserClient;
  agentId: string;
  agents: () => Promise<AgentsListResult | null>;
  methodAvailable: (method: string) => boolean;
}): Promise<CommandPaletteItem[]> {
  const requestIfAvailable = async <T>(
    method: string,
    requestParams: unknown,
  ): Promise<T | null> =>
    params.methodAvailable(method)
      ? params.client.request<T>(method, requestParams).catch(() => null)
      : null;
  const [agents, automations, skills, plugins] = await Promise.all([
    params.agents().catch(() => null),
    params.methodAvailable("cron.list") ? loadCronCatalog(params.client).catch(() => null) : null,
    requestIfAvailable<SkillStatusReport>("skills.status", { agentId: params.agentId }),
    requestIfAvailable<PluginListResult>("plugins.list", {}),
  ]);

  return [
    ...(agents?.agents ?? []).map((agent) => ({
      id: `agent-${agent.id}`,
      label: agent.identity?.name ?? agent.name ?? agent.id,
      icon: "bot" as const,
      category: "agents" as const,
      action: "nav:agents",
      agentId: agent.id,
      description: agent.id,
      searchText: [agent.id, agent.workspace, agent.identity?.theme].filter(Boolean).join(" "),
      primaryModel: agent.model?.primary,
    })),
    ...(automations?.jobs ?? []).map((job) => ({
      id: `automation-${job.id}`,
      label: job.displayName ?? job.name,
      icon: "calendarClock" as const,
      category: "automations" as const,
      action: "nav:cron",
      searchText: [job.id, job.declarationKey, job.name, job.agentId].filter(Boolean).join(" "),
    })),
    ...(skills?.skills ?? []).map((skill) => ({
      id: `skill-${skill.skillKey}`,
      label: skill.name,
      icon: "zap" as const,
      category: "skills" as const,
      action: "nav:skills",
      description: skill.description,
      searchText: [skill.skillKey, skill.source].filter(Boolean).join(" "),
    })),
    ...(plugins?.plugins ?? []).map((plugin) => ({
      id: `plugin-${plugin.id}`,
      label: plugin.name,
      icon: "plug" as const,
      category: "plugins" as const,
      action: plugin.installed ? "nav:plugin-settings" : "nav:plugins",
      pluginId: plugin.id,
      catalogId: plugin.installed ? undefined : plugin.catalogId,
      hasPluginIcon: plugin.hasIcon,
      description: plugin.description,
      searchText: [plugin.id, plugin.packageName, plugin.category, plugin.kind?.join(" ")]
        .filter(Boolean)
        .join(" "),
    })),
  ];
}

export function getCommandPaletteModelItems(
  catalog: Pick<ModelCatalogResult, "models">,
): CommandPaletteItem[] {
  return catalog.models.map((model) => ({
    // Both IDs can contain separators; selection needs a lossless pair.
    id: `model-${JSON.stringify([model.provider, model.id])}`,
    label: model.name || model.id,
    icon: "brain" as const,
    category: "models" as const,
    action: "nav:model-providers",
    description: model.provider,
    searchText: [model.id, model.provider, model.alias, model.tags?.join(" ")]
      .filter(Boolean)
      .join(" "),
  }));
}
