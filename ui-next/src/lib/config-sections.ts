import {
  Globe,
  Download,
  Bot,
  Shield,
  MessageSquare,
  Mail,
  Terminal,
  Zap,
  Wrench,
  Server,
  Wand2,
  LayoutGrid,
  FileText,
  Bug,
  ScrollText,
  Globe2,
  Palette,
  Cpu,
  Plug,
  Radio,
  Volume2,
  Image,
  Webhook,
  AppWindow,
  Compass,
  PanelTop,
  Mic,
  Brain,
  Package,
  ShieldCheck,
  Clock,
  Settings,
  Network,
  type LucideIcon,
} from "lucide-react";
import { humanize } from "./config-form-utils";

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type SectionIssuesMap = Map<string, ConfigValidationIssue[]>;

export type ConfigSection = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

/** A collapsible group of related sections in the sidebar. */
export type ConfigSectionGroup = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Section keys that belong to this group */
  children: string[];
};

export const CONFIG_SECTIONS: ConfigSection[] = [
  {
    key: "meta",
    label: "Meta",
    description: "Config metadata and versioning",
    icon: FileText,
  },
  {
    key: "env",
    label: "Environment",
    description: "Environment variables passed to the gateway process",
    icon: Globe,
  },
  {
    key: "wizard",
    label: "Setup Wizard",
    description: "Setup wizard state and history",
    icon: Wand2,
  },
  {
    key: "diagnostics",
    label: "Diagnostics",
    description: "Diagnostics, observability, and tracing",
    icon: Bug,
  },
  {
    key: "logging",
    label: "Logging",
    description: "Logging levels, file output, and redaction",
    icon: ScrollText,
  },
  {
    key: "update",
    label: "Updates",
    description: "Auto-update settings and release channel",
    icon: Download,
  },
  {
    key: "browser",
    label: "Browser",
    description: "Browser control and CDP configuration",
    icon: Globe2,
  },
  {
    key: "ui",
    label: "UI",
    description: "UI appearance and assistant display settings",
    icon: Palette,
  },
  {
    key: "auth",
    label: "Authentication",
    description: "API keys and authentication profiles",
    icon: Shield,
  },
  {
    key: "models",
    label: "Models",
    description: "Model selection and provider configuration",
    icon: Brain,
  },
  {
    key: "nodeHost",
    label: "Node Host",
    description: "Node host and browser proxy settings",
    icon: Cpu,
  },
  {
    key: "agents",
    label: "Agents",
    description: "Agent configurations, models, and identities",
    icon: Bot,
  },
  {
    key: "tools",
    label: "Tools",
    description: "Tool configurations (browser, search, etc.)",
    icon: Wrench,
  },
  {
    key: "bindings",
    label: "Bindings",
    description: "Key and action bindings",
    icon: Plug,
  },
  {
    key: "broadcast",
    label: "Broadcast",
    description: "Broadcast and announcement settings",
    icon: Radio,
  },
  {
    key: "audio",
    label: "Audio",
    description: "Audio input and processing configuration",
    icon: Volume2,
  },
  {
    key: "media",
    label: "Media",
    description: "Media handling and file settings",
    icon: Image,
  },
  {
    key: "messages",
    label: "Messages",
    description: "Message handling and delivery settings",
    icon: Mail,
  },
  {
    key: "commands",
    label: "Commands",
    description: "Command routing and native command settings",
    icon: Terminal,
  },
  {
    key: "approvals",
    label: "Approvals",
    description: "Approval workflows and policies",
    icon: ShieldCheck,
  },
  {
    key: "session",
    label: "Sessions",
    description: "Session scope, identity links, and DM settings",
    icon: MessageSquare,
  },
  {
    key: "cron",
    label: "Cron",
    description: "Scheduled job settings and concurrency",
    icon: Clock,
  },
  {
    key: "hooks",
    label: "Hooks",
    description: "Webhook hooks, Gmail integration, and event mappings",
    icon: Webhook,
  },
  {
    key: "web",
    label: "Web",
    description: "Web provider and heartbeat settings",
    icon: AppWindow,
  },
  {
    key: "channels",
    label: "Channels",
    description: "Messaging channels (Telegram, Discord, Slack, etc.)",
    icon: MessageSquare,
  },
  {
    key: "discovery",
    label: "Discovery",
    description: "Network discovery and mDNS settings",
    icon: Compass,
  },
  {
    key: "canvasHost",
    label: "Canvas Host",
    description: "Canvas host configuration",
    icon: PanelTop,
  },
  {
    key: "talk",
    label: "Talk",
    description: "Text-to-speech voice and API settings",
    icon: Mic,
  },
  {
    key: "gateway",
    label: "Gateway",
    description: "Gateway server and runtime settings",
    icon: Server,
  },
  {
    key: "memory",
    label: "Memory",
    description: "Memory search backend and citations",
    icon: Brain,
  },
  {
    key: "skills",
    label: "Skills",
    description: "Skill configurations and allowlists",
    icon: Zap,
  },
  {
    key: "plugins",
    label: "Plugins",
    description: "Plugin loading, slots, and entries",
    icon: Package,
  },
];

// Icon for "All Settings" view
export const ALL_SETTINGS_ICON = LayoutGrid;

// Default icon for unknown sections
export const DEFAULT_SECTION_ICON = Settings;

// Lookup helper
export function getSectionMeta(key: string): ConfigSection | undefined {
  return CONFIG_SECTIONS.find((s) => s.key === key);
}

// Get section metadata, falling back to dynamic generation for unknown sections
export function getSectionMetaOrDefault(key: string): ConfigSection {
  const found = getSectionMeta(key);
  if (found) {
    return found;
  }

  return {
    key,
    label: humanize(key),
    description: "",
    icon: DEFAULT_SECTION_ICON,
  };
}

/**
 * Groups of related sections shown as collapsible sub-menus in the sidebar.
 * Sections listed as children are pulled out of the flat list and nested under the group.
 */
export const CONFIG_SECTION_GROUPS: ConfigSectionGroup[] = [
  {
    key: "matrix",
    label: "Matrix",
    description: "Multi-agent hierarchy, teams, and orchestration",
    icon: Network,
    children: ["agents", "session"],
  },
];

/** Set of all section keys that belong to a group (for fast lookup). */
const GROUPED_SECTION_KEYS = new Set(CONFIG_SECTION_GROUPS.flatMap((g) => g.children));

/** Check if a section key is grouped under a parent. */
export function isSectionGrouped(key: string): boolean {
  return GROUPED_SECTION_KEYS.has(key);
}

/** Find the group a section belongs to, if any. */
export function getGroupForSection(key: string): ConfigSectionGroup | undefined {
  return CONFIG_SECTION_GROUPS.find((g) => g.children.includes(key));
}

/**
 * Map an array of validation issues to the config sections they belong to.
 * The first segment of the dotted `path` (e.g. "agents" from "agents.list.0.id")
 * is used as the section key.
 */
export function mapIssuesToSections(issues: ConfigValidationIssue[]): SectionIssuesMap {
  const map: SectionIssuesMap = new Map();
  for (const issue of issues) {
    const sectionKey = issue.path.split(".")[0] || "_root";
    const existing = map.get(sectionKey);
    if (existing) {
      existing.push(issue);
    } else {
      map.set(sectionKey, [issue]);
    }
  }
  return map;
}
