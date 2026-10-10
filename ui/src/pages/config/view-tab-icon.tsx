import { createMemo, For, Show } from "solid-js";
import {
  agentTabIconShape,
  type AgentTabIconShape,
  type TabIconPreference,
} from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { controlUiFaviconBaseSvg } from "../../app/control-ui-environment-presentation.runtime.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-look.ts";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { SettingsRow, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import "./tab-icon-avatar.ts";
import "../../components/lobster-illustration.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
export type TabIconViewProps = {
  tabIcon: TabIconPreference | undefined;
  lobsterdexEnabled?: boolean;
  tabIconAgentAvatar?: string | null;
  tabIconLobsters?: readonly LobsterPetPalette[];
  setTabIconMode: (mode: TabIconPreference) => void;
};
function renderLobsterPreview(palette: LobsterPetPalette) {
  const look = canonicalLobsterLook(palette);
  return (
    <>
      <span
        class={`lobster-pet settings-tab-icon__lobster lobster-pet--palette-${palette.id}`}
        style={lobsterLookStyle(look)}
        aria-hidden="true"
      >
        <openclaw-lobster-illustration
          style={{ display: "contents" }}
          prop:look={look}
          prop:options={{
            standalone: true,
          }}
        />
      </span>
    </>
  );
}
export function TabIconSection(props: TabIconViewProps) {
  const defaultSource = createMemo(
    () => controlUiFaviconBaseSvg() ?? inferControlUiPublicAssetPath("favicon.svg"),
  );
  const lobsterdexEnabled = createMemo(() => props.lobsterdexEnabled !== false);
  const lobsters = createMemo(() => (lobsterdexEnabled() ? (props.tabIconLobsters ?? []) : []));
  const lobsterMode = createMemo(
    () => lobsterdexEnabled() && (props.tabIcon?.startsWith("lobster:") ?? false),
  );
  const selectedShape = createMemo(() => agentTabIconShape(props.tabIcon));
  const selected = createMemo(() =>
    lobsters().find((palette) => props.tabIcon === `lobster:${palette.id}`),
  );
  const preview = createMemo(() => (lobsterMode() ? selected() : lobsters()[0]));
  const defaultPreview = () => (
    <openclaw-tab-icon-avatar
      style={{ display: "contents" }}
      prop:imageUrl={null}
      prop:fallbackOnly={true}
      prop:fallbackUrl={defaultSource()}
    />
  );
  const avatarPreview = (source: string | null, shape: AgentTabIconShape = "square") => (
    <openclaw-tab-icon-avatar
      style={{ display: "contents" }}
      prop:imageUrl={source}
      prop:shape={shape}
      prop:fallbackUrl={defaultSource()}
    />
  );
  const optionLabel = (
    label: string,
    source: string | null,
    shape: AgentTabIconShape = "square",
  ) => (
    <>
      <span class="settings-tab-icon__option">
        {avatarPreview(source, shape)}
        {label}
      </span>
    </>
  );
  return (
    <>
      <section
        id={APPEARANCE_SETTINGS_TARGET_IDS.tabIcon}
        class="settings-section settings-tab-icon"
      >
        {<SettingsSectionHeader title={t("configView.appearance.tabIcon.title")} />}
        <div class="settings-group">
          {
            <SettingsRow
              title={t("configView.appearance.tabIcon.source")}
              stackedOnNarrow={true}
              description={
                lobsterdexEnabled() && lobsters().length === 0 && !lobsterMode()
                  ? t("configView.appearance.tabIcon.empty")
                  : undefined
              }
              control={
                <SettingsSegmented
                  value={lobsterMode() ? "lobster" : selectedShape() ? "agent" : "default"}
                  options={[
                    {
                      value: "default",
                      label: optionLabel(t("configView.appearance.tabIcon.default"), null),
                    },
                    {
                      value: "agent",
                      label: optionLabel(
                        t("configView.appearance.tabIcon.agent"),
                        props.tabIconAgentAvatar ?? null,
                        selectedShape() ?? "square",
                      ),
                    },
                    ...(lobsterdexEnabled()
                      ? [
                          {
                            value: "lobster",
                            label: (
                              <>
                                <span class="settings-tab-icon__option">
                                  <span class="settings-tab-icon__preview">
                                    <Show when={preview()} fallback={defaultPreview()}>
                                      {(palette) => renderLobsterPreview(palette())}
                                    </Show>{" "}
                                  </span>
                                  {t("configView.appearance.tabIcon.lobsterdex")}
                                </span>
                              </>
                            ),
                            disabled: lobsters().length === 0,
                          },
                        ]
                      : []),
                  ]}
                  ariaLabel={t("configView.appearance.tabIcon.sourceLabel")}
                  onChange={(mode) => {
                    if (mode === "lobster") {
                      const palette = selected() ?? lobsters()[0];
                      if (palette) {
                        props.setTabIconMode(`lobster:${palette.id}`);
                      }
                    } else if (mode === "default" || mode === "agent") {
                      props.setTabIconMode(mode);
                    }
                  }}
                />
              }
            />
          }
          {selectedShape() ? (
            <SettingsRow
              title={t("configView.appearance.tabIcon.shape")}
              stackedOnNarrow={true}
              control={
                <>
                  <div
                    class="settings-tab-icon__shapes"
                    role="group"
                    aria-label={t("configView.appearance.tabIcon.shapeLabel")}
                  >
                    {
                      <For
                        each={
                          [
                            ["square", "agent"],
                            ["rounded", "agent:rounded"],
                            ["circle", "agent:circle"],
                          ] as const
                        }
                      >
                        {([choice, preference]) => (
                          <>
                            <button
                              type="button"
                              class="settings-tab-icon__pick"
                              aria-pressed={String(selectedShape() === choice)}
                              aria-label={t(`configView.appearance.tabIcon.${choice}`)}
                              title={t(`configView.appearance.tabIcon.${choice}`)}
                              onClick={() => props.setTabIconMode(preference)}
                            >
                              {avatarPreview(props.tabIconAgentAvatar ?? null, choice)}
                            </button>
                          </>
                        )}
                      </For>
                    }
                  </div>
                </>
              }
            />
          ) : undefined}
          {lobsterMode() ? (
            <SettingsRow
              title={t("configView.appearance.tabIcon.lobster")}
              description={t(
                selected()
                  ? "configView.appearance.tabIcon.localCollection"
                  : "configView.appearance.tabIcon.unavailable",
              )}
              stackedOnNarrow={true}
              control={
                <>
                  <div
                    class="settings-tab-icon__lobsters"
                    role="group"
                    aria-label={t("configView.appearance.tabIcon.lobster")}
                  >
                    {
                      <For each={lobsters()} keyed={(entry) => entry.id}>
                        {(palette) => (
                          <>
                            <button
                              type="button"
                              class="settings-tab-icon__pick"
                              aria-pressed={String(selected()?.id === palette().id)}
                              aria-label={lobsterPaletteName(palette().id)}
                              title={lobsterPaletteName(palette().id)}
                              onClick={() => props.setTabIconMode(`lobster:${palette().id}`)}
                            >
                              {renderLobsterPreview(palette())}
                            </button>
                          </>
                        )}
                      </For>
                    }
                  </div>
                </>
              }
            />
          ) : undefined}
        </div>
      </section>
    </>
  );
}
