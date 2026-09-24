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

type CommandPaletteCatalogCategory =
  | "agents"
  | "apps"
  | "automations"
  | "models"
  | "plugins"
  | "settings"
  | "skills";

type CommandPaletteCatalogItem = {
  id: string;
  label: string;
  icon: IconName;
  category: CommandPaletteCatalogCategory;
  routeId: RouteId;
  search?: string;
  hash?: string;
  agentId?: string;
  description?: string;
  searchText?: string;
  /** Searchable only while the current model catalog permits unrestricted selection. */
  primaryModel?: string;
};

export type CommandPaletteItem = Omit<CommandPaletteCatalogItem, "routeId" | "category"> & {
  category: "search" | "navigation" | "chats" | "messages" | CommandPaletteCatalogCategory;
  action: string;
  session?: GatewaySessionRow;
};

export function commandPaletteCategoryLabel(category: string): string {
  switch (category) {
    case "search":
      return t("palette.categories.search");
    case "navigation":
      return t("palette.categories.navigation");
    case "skills":
      return t("palette.categories.skills");
    case "agents":
      return t("palette.items.agents");
    case "apps":
      return t("palette.items.apps");
    case "automations":
      return t("palette.items.scheduled");
    case "models":
      return t("routeTitles.modelProviders");
    case "plugins":
      return t("palette.items.plugins");
    case "settings":
      return t("palette.items.settings");
    case "chats":
      return t("sessionsView.title");
    case "messages":
      return t("palette.categories.messages");
    default:
      return category;
  }
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

export function toCommandPaletteItems(
  items: readonly CommandPaletteCatalogItem[],
): CommandPaletteItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    category: item.category,
    action: `nav:${item.routeId}`,
    search: item.search,
    hash: item.hash,
    agentId: item.agentId,
    description: item.description,
    searchText: item.searchText,
    primaryModel: item.primaryModel,
  }));
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
): CommandPaletteCatalogItem[] {
  const settings = visibleSettingsNavigationGroups(canAdmin, nativeDeviceSettings)
    .flatMap((group) => group.routes)
    .concat(SETTINGS_SEARCHABLE_SUBPAGE_ROUTES)
    .map((routeId) => ({
      id: `settings-${routeId}`,
      label: settingsNavigationLabelForRoute(routeId),
      icon: "settings" as const,
      category: "settings" as const,
      routeId,
      description: subtitleForRoute(routeId),
      searchText: routeId,
    }));
  const apps = APP_CARDS.map((card) => ({
    id: `app-${card}`,
    label: t(`appsPage.cards.${card}.title`),
    icon: "layoutGrid" as const,
    category: "apps" as const,
    routeId: "apps" as const,
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
            routeId: capture.routeId,
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
}): Promise<CommandPaletteCatalogItem[]> {
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
      routeId: "agents" as const,
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
      routeId: "cron" as const,
      searchText: [job.id, job.declarationKey, job.name, job.agentId].filter(Boolean).join(" "),
    })),
    ...(skills?.skills ?? []).map((skill) => ({
      id: `skill-${skill.skillKey}`,
      label: skill.name,
      icon: "zap" as const,
      category: "skills" as const,
      routeId: "skills" as const,
      description: skill.description,
      searchText: [skill.skillKey, skill.source].filter(Boolean).join(" "),
    })),
    ...(plugins?.plugins ?? []).map((plugin) => ({
      id: `plugin-${plugin.id}`,
      label: plugin.name,
      icon: "plug" as const,
      category: "plugins" as const,
      routeId: "plugins" as const,
      description: plugin.description,
      searchText: [plugin.id, plugin.packageName, plugin.category, plugin.kind?.join(" ")]
        .filter(Boolean)
        .join(" "),
    })),
  ];
}

export function getCommandPaletteModelItems(
  catalog: Pick<ModelCatalogResult, "models">,
): CommandPaletteCatalogItem[] {
  return catalog.models.map((model) => ({
    // Both IDs can contain separators; selection needs a lossless pair.
    id: `model-${JSON.stringify([model.provider, model.id])}`,
    label: model.name || model.id,
    icon: "brain" as const,
    category: "models" as const,
    routeId: "model-providers" as const,
    description: model.provider,
    searchText: [model.id, model.provider, model.alias, model.tags?.join(" ")]
      .filter(Boolean)
      .join(" "),
  }));
}
