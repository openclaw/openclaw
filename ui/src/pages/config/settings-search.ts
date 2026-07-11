import type { ConfigUiHints } from "../../api/types.ts";
import { settingsSearchTextMatches, type SettingsSearchBlock } from "../../app-navigation.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { SECTION_META } from "../../components/config-form.meta.ts";
import {
  matchesConfigSectionSearch,
  parseConfigSearchQuery,
} from "../../components/config-form.search.ts";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import {
  AI_AGENTS_SECTION_KEYS,
  APPEARANCE_SECTION_KEYS,
  AUTOMATION_SECTION_KEYS,
  COMMUNICATION_SECTION_KEYS,
  INFRASTRUCTURE_SECTION_KEYS,
} from "./config-sections.ts";

type StaticSettingsBlock = SettingsSearchBlock & {
  id: string;
  searchText: string;
};

export const GENERAL_SETTINGS_BLOCKS = {
  model: {
    routeId: "config",
    id: "settings-general-model",
    label: "Model & Thinking",
    hash: "#settings-general-model",
    searchText: "model thinking fast mode auto standard",
  },
  channels: {
    routeId: "config",
    id: "settings-general-channels",
    label: "Channels",
    hash: "#settings-general-channels",
    searchText: "channels telegram discord slack whatsapp signal imessage connected configure",
  },
  security: {
    routeId: "config",
    id: "settings-general-security",
    label: "Security",
    hash: "#settings-general-security",
    searchText: "security gateway auth exec policy device auth browser tool profile",
  },
  system: {
    routeId: "config",
    id: "settings-general-system",
    label: "Gateway Host",
    hash: "#settings-general-system",
    searchText: "gateway host system cpu memory disk uptime node address",
  },
  appearance: {
    routeId: "config",
    id: "settings-general-appearance",
    label: "Appearance",
    hash: "#settings-general-appearance",
    searchText: "appearance theme mode text size lobster",
  },
  personal: {
    routeId: "config",
    id: "settings-general-personal",
    label: "Personal",
    hash: "#settings-general-personal",
    searchText: "personal user assistant identity avatar image",
  },
  automations: {
    routeId: "config",
    id: "settings-general-automations",
    label: "Automations",
    hash: "#settings-general-automations",
    searchText: "automations scheduled tasks cron skills mcp servers",
  },
} as const satisfies Record<string, StaticSettingsBlock>;

export const APPEARANCE_SETTINGS_BLOCKS = {
  theme: {
    routeId: "appearance",
    id: "settings-appearance-theme",
    label: "Theme",
    search: "?section=__appearance__",
    hash: "#settings-appearance-theme",
    searchText: "theme family import tweakcn light dark system",
  },
  textSize: {
    routeId: "appearance",
    id: "settings-appearance-text-size",
    label: "Text size",
    search: "?section=__appearance__",
    hash: "#settings-appearance-text-size",
    searchText: "text size scale small default large xl xxl",
  },
  connection: {
    routeId: "appearance",
    id: "settings-appearance-connection",
    label: "Connection",
    search: "?section=__appearance__",
    hash: "#settings-appearance-connection",
    searchText: "connection gateway status assistant version",
  },
} as const satisfies Record<string, StaticSettingsBlock>;

export const COMMUNICATION_SETTINGS_BLOCKS = {
  notifications: {
    routeId: "communications",
    id: "settings-communications-notifications",
    label: "Push notifications",
    search: "?section=__notifications__",
    hash: "#settings-communications-notifications",
    searchText: "push notifications browser permission subscription vapid gateway",
  },
} as const satisfies Record<string, StaticSettingsBlock>;

const STATIC_SETTINGS_BLOCKS: readonly StaticSettingsBlock[] = [
  ...Object.values(GENERAL_SETTINGS_BLOCKS),
  ...Object.values(APPEARANCE_SETTINGS_BLOCKS),
  ...Object.values(COMMUNICATION_SETTINGS_BLOCKS),
];

const COMMUNICATION_SECTIONS = new Set<string>(COMMUNICATION_SECTION_KEYS);
const APPEARANCE_SECTIONS = new Set<string>(APPEARANCE_SECTION_KEYS);
const AUTOMATION_SECTIONS = new Set<string>(AUTOMATION_SECTION_KEYS);
const INFRASTRUCTURE_SECTIONS = new Set<string>(INFRASTRUCTURE_SECTION_KEYS);
const AI_AGENTS_SECTIONS = new Set<string>(AI_AGENTS_SECTION_KEYS);

function routeForConfigSection(key: string): RouteId {
  if (key === "mcp") {
    return "mcp";
  }
  if (COMMUNICATION_SECTIONS.has(key)) {
    return "communications";
  }
  if (APPEARANCE_SECTIONS.has(key)) {
    return "appearance";
  }
  if (AUTOMATION_SECTIONS.has(key)) {
    return "automation";
  }
  if (INFRASTRUCTURE_SECTIONS.has(key)) {
    return "infrastructure";
  }
  if (AI_AGENTS_SECTIONS.has(key)) {
    return "ai-agents";
  }
  return "config";
}

export function findSettingsSearchBlocks(params: {
  query: string;
  schema: unknown;
  value: Record<string, unknown> | null;
  uiHints: ConfigUiHints;
}): SettingsSearchBlock[] {
  if (!params.query.trim()) {
    return [];
  }
  const criteria = parseConfigSearchQuery(params.query);
  const matches: SettingsSearchBlock[] =
    criteria.tags.length === 0 && criteria.text
      ? STATIC_SETTINGS_BLOCKS.filter((block) =>
          settingsSearchTextMatches(`${block.label} ${block.searchText}`, criteria.text),
        )
      : [];
  const schema =
    params.schema && typeof params.schema === "object" && !Array.isArray(params.schema)
      ? (params.schema as JsonSchema)
      : null;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return matches;
  }
  const value = params.value ?? {};
  const usePrefixMatching =
    criteria.tags.length === 0 && criteria.text.length > 0 && criteria.text.length <= 2;
  for (const [key, sectionSchema] of Object.entries(schema.properties)) {
    const meta = SECTION_META[key];
    const matchesSection = usePrefixMatching
      ? [key, meta?.label, meta?.description, sectionSchema.title, sectionSchema.description].some(
          (candidate) =>
            typeof candidate === "string" && settingsSearchTextMatches(candidate, criteria.text),
        )
      : matchesConfigSectionSearch({
          key,
          schema: sectionSchema,
          value: value[key],
          hints: params.uiHints,
          query: params.query,
          label: meta?.label,
          description: meta?.description,
        });
    if (!matchesSection) {
      continue;
    }
    const encodedKey = encodeURIComponent(key);
    matches.push({
      routeId: routeForConfigSection(key),
      label: meta?.label ?? sectionSchema.title ?? key,
      search: `?section=${encodedKey}`,
      hash: `#config-section-${encodedKey}`,
    });
  }
  return matches;
}
