import { createMemo, For, Show } from "solid-js";
import {
  BUILTIN_THEMES,
  resolveThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { UI_APPEARANCE_DEFAULTS } from "../../app/settings.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-look.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import "../../components/tooltip.ts";
import {
  SettingsDefaultDescription,
  SettingsRow,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import type { ConfigProps } from "./view-types.ts";

export function LobsterPetSection(props: ConfigProps) {
  const activeTheme = createMemo(
    () =>
      BUILTIN_THEMES.find((theme) => theme.id === props.theme) ??
      props.themeCatalog?.themes.find((theme) => theme.id === props.theme),
  );
  const branding = createMemo(() => resolveThemeBranding(activeTheme()));
  const themeHiddenDescription = createMemo(() =>
    branding().mascot === "none" ? (
      <>
        <br />
        {t("quickSettings.appearance.lobsterVisitsThemeHidden", {
          theme:
            activeTheme()?.source === "builtin"
              ? t(`configView.themes.${activeTheme()?.id}.label`)
              : (activeTheme()?.name ?? props.theme),
        })}
      </>
    ) : undefined,
  );
  const lobsterVisitsDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.enabled")}
      overridden={props.lobsterPetVisits !== UI_APPEARANCE_DEFAULTS.lobsterPetVisits}
    />
  );
  const lobsterSoundsDefaultDescription = (
    <SettingsDefaultDescription
      value={t("common.disabled")}
      overridden={props.lobsterPetSounds !== UI_APPEARANCE_DEFAULTS.lobsterPetSounds}
    />
  );
  const dex = projectLobsterdex();
  const dexEntries = () => dex.read();
  const seenCount = createMemo(
    () => LOBSTER_PET_PALETTES.filter((palette) => dexEntries().has(palette.id)).length,
  );
  return (
    <Show when={branding().lobsterdex}>
      <section class="settings-section">
        {<SettingsSectionHeader title={t("quickSettings.appearance.lobsterdex")} />}
        <div class="settings-group">
          {
            <SettingsToggleRow
              title={t("quickSettings.appearance.lobsterVisits")}
              description={
                <>
                  {t(
                    props.lobsterPetVisits
                      ? "quickSettings.appearance.lobsterVisitsOn"
                      : "quickSettings.appearance.lobsterVisitsOff",
                  )}
                  <br />
                  {lobsterVisitsDefaultDescription} {t("quickSettings.personal.browserOnly")}
                  {themeHiddenDescription()}
                </>
              }
              checked={props.lobsterPetVisits}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  lobsterPetVisits: enabled,
                })
              }
            />
          }
          {
            <SettingsToggleRow
              title={t("quickSettings.appearance.lobsterSounds")}
              description={
                <>
                  {t(
                    props.lobsterPetSounds
                      ? "quickSettings.appearance.lobsterSoundsOn"
                      : "quickSettings.appearance.lobsterSoundsOff",
                  )}
                  <br />
                  {lobsterSoundsDefaultDescription} {t("quickSettings.personal.browserOnly")}
                </>
              }
              checked={props.lobsterPetSounds}
              onChange={(enabled) =>
                props.onAppearanceChange({
                  lobsterPetSounds: enabled,
                })
              }
              onAct={(enabled) => {
                if (enabled) {
                  previewLobsterChirp();
                }
              }}
            />
          }
          {
            <SettingsRow
              title={t("quickSettings.appearance.lobsterdex")}
              description={t("quickSettings.appearance.lobsterdexSeen", {
                seen: String(seenCount()),
                total: String(LOBSTER_PET_PALETTES.length),
              })}
              stacked={true}
              control={
                <>
                  <div class="lobsterdex__gallery">
                    <div class="lobsterdex">
                      {
                        <For each={LOBSTER_PET_PALETTES}>
                          {(palette) => {
                            const look = canonicalLobsterLook(palette);
                            const entry = createMemo(() => dexEntries().get(palette.id));
                            const seen = createMemo(() => entry() !== undefined);
                            const shinySeen = createMemo(() => entry()?.shinySeenAt != null);
                            const baseName = createMemo(() =>
                              entry() ? (entry()?.name ?? lobsterPaletteName(palette.id)) : "?",
                            );
                            const displayName = createMemo(() =>
                              shinySeen() ? `${baseName()} ✦` : baseName(),
                            );
                            const lore = LOBSTER_PALETTE_LORE[palette.id];
                            const loreLine = createMemo(() => (seen() ? lore.flavor : lore.hint));
                            const visitedLine = createMemo(() => {
                              const firstSeenAt = entry()?.firstSeenAt;
                              return firstSeenAt != null
                                ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                                    name: baseName(),
                                    date: new Date(firstSeenAt).toLocaleDateString(),
                                  })
                                : null;
                            });
                            const ariaLabel = createMemo(() =>
                              [displayName(), loreLine(), visitedLine()]
                                .filter((line): line is string => line !== null)
                                .join("\n"),
                            );
                            return (
                              <>
                                <openclaw-tooltip>
                                  <span
                                    class={[
                                      "lobsterdex__mini",
                                      `lobster-pet--palette-${palette.id}`,
                                      { "lobsterdex__mini--unseen": !seen() },
                                    ]}
                                    style={lobsterLookStyle(look)}
                                    tabIndex={0}
                                    role="img"
                                    aria-label={ariaLabel()}
                                  >
                                    <LobsterSvg look={look} standalone />
                                    {shinySeen() ? (
                                      <>
                                        <span class="lobsterdex__mini-star" aria-hidden="true">
                                          ✦
                                        </span>
                                      </>
                                    ) : undefined}
                                  </span>
                                  <span slot="content" class="lobsterdex__tooltip">
                                    <strong>{displayName()}</strong>
                                    <span>{loreLine()}</span>
                                    {visitedLine() ? (
                                      <>
                                        <span>{visitedLine()}</span>
                                      </>
                                    ) : undefined}
                                  </span>
                                </openclaw-tooltip>
                              </>
                            );
                          }}
                        </For>
                      }
                    </div>
                    {props.lobsterdexHref ? (
                      <>
                        <a
                          class="btn btn--sm lobsterdex__open"
                          href={props.lobsterdexHref}
                          onClick={(event: MouseEvent) => {
                            if (!shouldHandleNavigationClick(event)) {
                              return;
                            }
                            event.preventDefault();
                            props.onOpenLobsterdex?.();
                          }}
                        >
                          {t("quickSettings.appearance.lobsterdexOpen")}
                        </a>
                      </>
                    ) : undefined}
                  </div>
                </>
              }
            />
          }
        </div>
      </section>
    </Show>
  );
}
