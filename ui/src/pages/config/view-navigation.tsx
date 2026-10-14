import { For } from "solid-js";
import { isKernelOwnedChannelConfigKey } from "../../../../src/config/channel-config-keys.js";
import type { ConfigUiHints } from "../../api/types.ts";
import {
  humanize,
  localizedHintForPath,
  type JsonSchema,
} from "../../components/config-form.shared.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConfigProps } from "./view-types.ts";

export function getChannelConfigGroups(schema: JsonSchema, hints: ConfigUiHints) {
  const entries = Object.entries(schema.properties ?? {});
  const channels = entries
    .filter(([key]) => !isKernelOwnedChannelConfigKey(key))
    .map(([key, node]) => ({
      key,
      label: localizedHintForPath(["channels", key], hints)?.label ?? node.title ?? humanize(key),
      keys: [key],
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const sharedKeys = entries
    .filter(([key]) => isKernelOwnedChannelConfigKey(key))
    .map(([key]) => key);
  return [
    ...channels,
    ...(sharedKeys.length > 0
      ? [{ key: null, label: t("configView.categories.other"), keys: sharedKeys }]
      : []),
  ];
}

const sidebarIcons: Record<string, IconName> = {
  all: "layoutGrid",
  env: "settings",
  update: "download",
  agents: "bot",
  auth: "lock",
  channels: "messageSquare",
  messages: "mail",
  commands: "terminal",
  hooks: "link",
  skills: "star",
  tools: "wrench",
  gateway: "globe",
  wizard: "wandSparkles",
  meta: "penLine",
  logging: "fileText",
  browser: "chrome",
  ui: "panelsTopLeft",
  models: "box",
  bindings: "server",
  broadcast: "radio",
  tts: "music",
  transcripts: "book",
  session: "users",
  cron: "clock",
  discovery: "search",
  talk: "mic",
  plugins: "asterisk",
  diagnostics: "activity",
  cli: "terminal",
  secrets: "key",
  acp: "users",
  mcp: "server",
  __appearance__: "sun",
  __notifications__: "bell",
};

export type SectionCategory = {
  id: string;
  label: string;
  sections: Array<{ key: string; label: string }>;
};

type SectionCategoryDefinition = {
  id: string;
  sections: string[];
};

export const SECTION_CATEGORIES: SectionCategoryDefinition[] = [
  {
    id: "core",
    sections: [
      "env",
      "auth",
      "update",
      "meta",
      "logging",
      "diagnostics",
      "cli",
      "secrets",
      "wizard",
    ],
  },
  { id: "ai", sections: ["agents", "models", "skills", "tools", "memory", "session"] },
  {
    id: "communication",
    sections: [
      "channels",
      "messages",
      "broadcast",
      "__notifications__",
      "talk",
      "tts",
      "transcripts",
    ],
  },
  { id: "security", sections: ["security", "approvals"] },
  { id: "automation", sections: ["commands", "hooks", "bindings", "cron", "plugins"] },
  {
    id: "infrastructure",
    sections: ["gateway", "browser", "nodeHost", "discovery", "acp", "mcp"],
  },
  { id: "appearance", sections: ["__appearance__", "ui"] },
];

export const CATEGORISED_KEYS = new Set(
  SECTION_CATEGORIES.flatMap((category) => category.sections),
);

export function ConfigAccordionNav(props: {
  activeSection: ConfigProps["activeSection"];
  onSectionChange: ConfigProps["onSectionChange"];
  categories: SectionCategory[];
  resetContentScroll: (target: EventTarget | null) => void;
}) {
  return (
    <div class="config-accordion-nav">
      <For each={props.categories} keyed={(category) => category.id}>
        {(category) => {
          const expanded = () =>
            category().sections.some((section) => section.key === props.activeSection);
          const panelId = () => `config-accordion-panel-${category().id}`;
          return (
            <div class="config-accordion-group">
              <button
                class={[
                  "config-accordion-group__header",
                  { "config-accordion-group__header--active": expanded() },
                ]}
                aria-expanded={expanded() ? "true" : "false"}
                aria-controls={panelId()}
                onClick={(event) => {
                  props.onSectionChange(expanded() ? null : (category().sections[0]?.key ?? null));
                  props.resetContentScroll(event.currentTarget);
                }}
              >
                <span class="config-accordion-group__icon">
                  <Icon name={sidebarIcons[category().sections[0]?.key ?? "default"] ?? "file"} />
                </span>
                <span>{category().label}</span>
                <svg
                  class={[
                    "config-accordion-group__chevron",
                    { "config-accordion-group__chevron--open": expanded() },
                  ]}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  width="14"
                  height="14"
                >
                  <polyline points="9 6 15 12 9 18" />
                </svg>
              </button>
              <div id={panelId()} class="config-accordion-group__items" hidden={!expanded()}>
                <For each={category().sections} keyed={(section) => section.key}>
                  {(section) => (
                    <button
                      class={[
                        "config-accordion-group__item",
                        {
                          "config-accordion-group__item--active":
                            props.activeSection === section().key,
                        },
                      ]}
                      aria-current={props.activeSection === section().key ? "true" : undefined}
                      onClick={(event) => {
                        props.onSectionChange(section().key);
                        props.resetContentScroll(event.currentTarget);
                      }}
                    >
                      <span class="config-accordion-group__item-icon">
                        <Icon name={sidebarIcons[section().key] ?? "file"} />
                      </span>
                      {section().label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
