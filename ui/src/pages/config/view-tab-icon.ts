import { html } from "lit";
import type { TabIconPreference } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
} from "../../components/identity-avatar-view.ts";
import { renderSettingsRow, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  tabIconAgentAvatar?: string | null;
  setTabIconMode: (mode: TabIconPreference) => void;
};

export function renderTabIconSection(props: TabIconViewProps) {
  const defaultSource = controlUiFaviconBaseSvg() ?? inferControlUiPublicAssetPath("favicon.svg");
  const optionLabel = (label: string, source: string | null) => {
    const view = { imageUrl: source, pending: false };
    return html`<span class="settings-tab-icon__option">
      <span
        class=${identityAvatarClass("identity-avatar--agent settings-tab-icon__preview", view)}
        aria-hidden="true"
      >
        ${renderIdentityAvatarImage({ view, fallbackSelector: ".settings-tab-icon__preview", className: "identity-avatar__image" })}
        <span class="identity-avatar__fallback"><img src=${defaultSource} alt="" /></span> </span
      >${label}
    </span>`;
  };
  return html`
    <section
      id=${APPEARANCE_SETTINGS_TARGET_IDS.tabIcon}
      class="settings-section settings-tab-icon"
    >
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.appearance.tabIcon.title")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.appearance.tabIcon.source"),
          stackedOnNarrow: true,
          control: renderSettingsSegmented({
            value: props.tabIcon ?? "default",
            options: [
              {
                value: "default",
                label: optionLabel(t("configView.appearance.tabIcon.default"), null),
              },
              {
                value: "agent",
                label: optionLabel(
                  t("configView.appearance.tabIcon.agent"),
                  props.tabIconAgentAvatar ?? null,
                ),
              },
            ],
            ariaLabel: t("configView.appearance.tabIcon.sourceLabel"),
            onChange: props.setTabIconMode,
          }),
        })}
      </div>
    </section>
  `;
}
