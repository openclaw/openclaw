import { html, nothing } from "lit";
import {
  agentTabIconShape,
  type AgentTabIconShape,
  type TabIconPreference,
} from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { currentThemeBranding } from "../../app/theme-branding.ts";
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
import { renderThemeBrandIcon } from "../../components/theme-brand-icon.ts";
import { t } from "../../i18n/index.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { renderSettingsSectionHeader } from "./settings-section-header.ts";

export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  lobsterdexEnabled?: boolean;
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
  const defaultImage = html`<img src=${defaultSource} alt="" />`;
  const defaultPreview = renderThemeBrandIcon(defaultImage, currentThemeBranding(), defaultImage);
  const lobsterdexEnabled = props.lobsterdexEnabled !== false;
  const lobsters = lobsterdexEnabled ? (props.tabIconLobsters ?? []) : [];
  const lobsterMode = lobsterdexEnabled && (props.tabIcon?.startsWith("lobster:") ?? false);
  const selectedShape = agentTabIconShape(props.tabIcon);
  const selected = lobsters.find((palette) => props.tabIcon === `lobster:${palette.id}`);
  const preview = lobsterMode ? selected : lobsters[0];
  const avatarPreview = (source: string | null, shape: AgentTabIconShape = "square") => {
    const view = { imageUrl: source, pending: false };
    return html`<span
      class=${identityAvatarClass("identity-avatar--agent settings-tab-icon__preview", view)}
      data-avatar-shape=${shape}
      aria-hidden="true"
    >
      ${renderIdentityAvatarImage({ view, fallbackSelector: ".settings-tab-icon__preview", className: "identity-avatar__image" })}
      <span class="identity-avatar__fallback">${defaultPreview}</span>
    </span>`;
  };
  const optionLabel = (label: string, source: string | null, shape: AgentTabIconShape = "square") =>
    html`<span class="settings-tab-icon__option">${avatarPreview(source, shape)}${label}</span>`;
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
            lobsterdexEnabled && lobsters.length === 0 && !lobsterMode
              ? t("configView.appearance.tabIcon.empty")
              : undefined,
          control: renderSettingsSegmented({
            value: lobsterMode ? "lobster" : selectedShape ? "agent" : "default",
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
                  selectedShape ?? "square",
                ),
              },
              ...(lobsterdexEnabled
                ? [
                    {
                      value: "lobster",
                      label: html`<span class="settings-tab-icon__option">
                        <span class="settings-tab-icon__preview">
                          ${preview ? renderLobsterPreview(preview) : defaultPreview} </span
                        >${t("configView.appearance.tabIcon.lobsterdex")}
                      </span>`,
                      disabled: lobsters.length === 0,
                    },
                  ]
                : []),
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
          selectedShape
            ? renderSettingsRow({
                title: t("configView.appearance.tabIcon.shape"),
                stackedOnNarrow: true,
                control: html`<div
                  class="settings-tab-icon__shapes"
                  role="group"
                  aria-label=${t("configView.appearance.tabIcon.shapeLabel")}
                >
                  ${(
                    [
                      ["square", "agent"],
                      ["rounded", "agent:rounded"],
                      ["circle", "agent:circle"],
                    ] as const
                  ).map(
                    ([choice, preference]) => html`<button
                      type="button"
                      class="settings-tab-icon__pick"
                      aria-pressed=${String(selectedShape === choice)}
                      aria-label=${t(`configView.appearance.tabIcon.${choice}`)}
                      title=${t(`configView.appearance.tabIcon.${choice}`)}
                      @click=${() => props.setTabIconMode(preference)}
                    >
                      ${avatarPreview(props.tabIconAgentAvatar ?? null, choice)}
                    </button>`,
                  )}
                </div>`,
              })
            : nothing
        }
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
