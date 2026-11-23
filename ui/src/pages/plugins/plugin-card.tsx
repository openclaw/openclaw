import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

export type InstalledPluginState = "enabled" | "disabled" | "needs-setup" | "error";

const INSTALLED_PLUGIN_STATUS = {
  enabled: ["pluginsPage.enabled", "ok"],
  disabled: ["pluginsPage.disabled", "muted"],
  "needs-setup": ["pluginsPage.setupRequiredNotice", "warn"],
  error: ["pluginsPage.needsAttention", "danger"],
} as const satisfies Record<InstalledPluginState, readonly [string, string]>;

export function renderPluginStateStatus(state: InstalledPluginState, className: string) {
  const [labelKey, tone] = INSTALLED_PLUGIN_STATUS[state];
  const label = t(labelKey);
  return (
    <span
      class={[className, "settings-status", `settings-status--${tone}`]}
      data-plugin-state={state}
      role="img"
      aria-label={label}
      title={label}
    >
      <span class="settings-status__dot" aria-hidden="true" />
    </span>
  );
}

const INSTALLED_PLUGIN_STATUS_WORD = {
  enabled: ["pluginsPage.enabled", "ok"],
  disabled: ["pluginsPage.disabled", "muted"],
  "needs-setup": ["pluginsPage.needsSetup", "warn"],
  error: ["pluginsPage.needsAttention", "danger"],
} as const satisfies Record<InstalledPluginState, readonly [string, string]>;

/** The row form: the state's word beside its dot, with the full notice on hover. */
export function renderPluginStateWord(state: InstalledPluginState) {
  const [wordKey, kind] = INSTALLED_PLUGIN_STATUS_WORD[state];
  return (
    <span
      class="plugins-settings-row__status"
      data-plugin-state={state}
      title={t(INSTALLED_PLUGIN_STATUS[state][0])}
    >
      <SettingsStatus kind={kind} label={t(wordKey)} />
    </span>
  );
}

export function renderPluginOfficialBadge(): JSX.Element {
  return (
    <span
      class="plugin-official-badge"
      role="img"
      aria-label={t("pluginsPage.official")}
      title={t("pluginsPage.official")}
    >
      {<Icon name="badgeCheck" />}
    </span>
  );
}

export function renderPluginAuthor(author: string | undefined): JSX.Element | undefined {
  if (!author) {
    return undefined;
  }
  const handle = author.replace(/^@+/, "");
  const label = `@${handle}`;
  return (
    <a
      class="plugin-card-author plugin-card-author--linked"
      href={`https://clawhub.ai/${encodeURIComponent(handle)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  );
}

export function PluginCardSummary(props: { summary: string }): JSX.Element {
  return <p class="installed-plugins-card__summary">{props.summary}</p>;
}
