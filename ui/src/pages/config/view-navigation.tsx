import { For } from "solid-js";
import { isKernelOwnedChannelConfigKey } from "../../../../src/config/channel-config-keys.js";
import type { ConfigUiHints } from "../../api/types.ts";
import {
  humanize,
  localizedHintForPath,
  type JsonSchema,
} from "../../components/config-form.shared.ts";
import { Icon } from "../../components/solid/icon.tsx";
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

export type SectionCategory = {
  id: string;
  label: string;
  sections: Array<{ key: string; label: string }>;
};

export const SECTION_CATEGORIES: {
  id: string;
  sections: string[];
}[] = [
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
    <div class="settings-group config-accordion-nav">
      <For each={props.categories} keyed={(category) => category.id}>
        {(category) => {
          const expanded = () =>
            category().sections.some((section) => section.key === props.activeSection);
          const panelId = () => `config-accordion-panel-${category().id}`;
          return (
            <div class="config-accordion-group">
              <button
                type="button"
                class="settings-row settings-row--nav config-accordion-group__header"
                aria-expanded={expanded() ? "true" : "false"}
                aria-controls={panelId()}
                onClick={(event) => {
                  props.onSectionChange(expanded() ? null : (category().sections[0]?.key ?? null));
                  props.resetContentScroll(event.currentTarget);
                }}
              >
                <span class="settings-row__text">
                  <span class="settings-row__title">{category().label}</span>
                </span>
                <span class="settings-row__control">
                  <span class="settings-row__chevron">
                    <Icon name="chevronRight" />
                  </span>
                </span>
              </button>
              <div id={panelId()} class="config-accordion-group__items" hidden={!expanded()}>
                <For each={category().sections} keyed={(section) => section.key}>
                  {(section) => (
                    <button
                      type="button"
                      class={[
                        "settings-row settings-row--nav config-accordion-group__item",
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
                      <span class="settings-row__text">
                        <span class="settings-row__title">{section().label}</span>
                      </span>
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
