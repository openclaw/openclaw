import { html, nothing } from "lit";
import type { TabIconPreference } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
} from "../../components/identity-avatar-view.ts";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { renderSettingsRow, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { renderSettingsSectionHeader } from "./settings-section-header.ts";

export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  tabIconAgentAvatar?: string | null;
  tabIconLobsters?: readonly LobsterPetPalette[];
  setTabIconMode: (mode: TabIconPreference) => void;
};

function renderLobsterPreview(palette: LobsterPetPalette) {
  const look = canonicalLobsterLook(palette);
  return html`<span
    class="lobster-pet settings-tab-icon__lobster lobster-pet--palette-${palette.id}"
    style=${lobsterLookStyle(look)}
    aria-hidden="true"
    >${renderLobsterSvg(look, { standalone: true })}</span
  >`;
}

export function renderTabIconSection(props: TabIconViewProps) {
  const defaultSource = controlUiFaviconBaseSvg() ?? inferControlUiPublicAssetPath("favicon.svg");
  const lobsters = props.tabIconLobsters ?? [];
  const lobsterMode = props.tabIcon?.startsWith("lobster:") ?? false;
  const selected = lobsters.find((palette) => props.tabIcon === `lobster:${palette.id}`);
  const preview = lobsterMode ? selected : lobsters[0];
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
      ${renderSettingsSectionHeader(t("configView.appearance.tabIcon.title"))}
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.appearance.tabIcon.source"),
          stackedOnNarrow: true,
          description:
            lobsters.length === 0 && !lobsterMode
              ? t("configView.appearance.tabIcon.empty")
              : undefined,
          control: renderSettingsSegmented({
            value: lobsterMode ? "lobster" : (props.tabIcon ?? "default"),
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
              {
                value: "lobster",
                label: html`<span class="settings-tab-icon__option">
                  <span class="settings-tab-icon__preview">
                    ${preview ? renderLobsterPreview(preview) : html`<img src=${defaultSource} alt="" />`} </span
                  >${t("configView.appearance.tabIcon.lobsterdex")}
                </span>`,
                disabled: lobsters.length === 0,
              },
            ],
            ariaLabel: t("configView.appearance.tabIcon.sourceLabel"),
            onChange: (mode) => {
              if (mode === "lobster") {
                const palette = selected ?? lobsters[0];
                if (palette) {
                  props.setTabIconMode(`lobster:${palette.id}`);
                }
              } else if (mode === "default" || mode === "agent") {
                props.setTabIconMode(mode);
              }
            },
          }),
        })}
        ${
          lobsterMode
            ? renderSettingsRow({
                title: t("configView.appearance.tabIcon.lobster"),
                description: t(
                  selected
                    ? "configView.appearance.tabIcon.localCollection"
                    : "configView.appearance.tabIcon.unavailable",
                ),
                stackedOnNarrow: true,
                control: html`<div
                  class="settings-tab-icon__lobsters"
                  role="group"
                  aria-label=${t("configView.appearance.tabIcon.lobster")}
                >
                  ${lobsters.map(
                    (palette) => html`<button
                      type="button"
                      class="settings-tab-icon__pick"
                      aria-pressed=${String(selected?.id === palette.id)}
                      aria-label=${lobsterPaletteName(palette.id)}
                      title=${lobsterPaletteName(palette.id)}
                      @click=${() => props.setTabIconMode(`lobster:${palette.id}`)}
                    >
                      ${renderLobsterPreview(palette)}
                    </button>`,
                  )}
                </div>`,
              })
            : nothing
        }
      </div>
    </section>
  `;
}
