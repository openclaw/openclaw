import { createMemo, createSignal, For, Show } from "solid-js";
import {
  BUILTIN_THEMES,
  resolveThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import "../../components/tooltip.ts";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../../lib/reactive/observers.ts";
import { LocalToggleRow } from "./local-toggle-row.tsx";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import type { ConfigProps } from "./view-types.ts";

registerEnglishCatalog(registerPreferencesEnglish);

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
  const dex = projectLobsterdex();
  const dexEntries = () => dex.read();
  const seenCount = createMemo(
    () => LOBSTER_PET_PALETTES.filter((palette) => dexEntries().has(palette.id)).length,
  );
  return (
    <Show when={branding().lobsterdex}>
      {(_visible) => {
        const [artworkReady, setArtworkReady] = createSignal(false);
        let gallery!: HTMLDivElement;
        // Keep labels and fixed-size cells; create the SVGs only when needed.
        createIntersectionObserver(
          () => (artworkReady() ? [] : [gallery]),
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              setArtworkReady(true);
            }
          },
          { rootMargin: "400px 0px" },
        );
        return (
          <section class="settings-section">
            <SettingsSectionHeader title={t("quickSettings.appearance.lobsterdex")} />
            <div class="settings-group">
              <LocalToggleRow
                config={props}
                setting="lobsterPetVisits"
                title={t("quickSettings.appearance.lobsterVisits")}
                hint={t(
                  props.lobsterPetVisits
                    ? "quickSettings.appearance.lobsterVisitsOn"
                    : "quickSettings.appearance.lobsterVisitsOff",
                )}
                extraDescription={themeHiddenDescription()}
              />
              <LocalToggleRow
                config={props}
                setting="lobsterPetSounds"
                title={t("quickSettings.appearance.lobsterSounds")}
                hint={t(
                  props.lobsterPetSounds
                    ? "quickSettings.appearance.lobsterSoundsOn"
                    : "quickSettings.appearance.lobsterSoundsOff",
                )}
                onAct={(enabled) => {
                  if (enabled) {
                    previewLobsterChirp();
                  }
                }}
              />
              <SettingsRow
                title={t("quickSettings.appearance.lobsterdex")}
                description={t("quickSettings.appearance.lobsterdexSeen", {
                  seen: String(seenCount()),
                  total: String(LOBSTER_PET_PALETTES.length),
                })}
                stacked={true}
                control={
                  <div class="lobsterdex__gallery">
                    <div class="lobsterdex" ref={(element) => (gallery = element)}>
                      <For each={LOBSTER_PET_PALETTES}>
                        {(palette) => {
                          const look = canonicalLobsterLook(palette);
                          const entry = createMemo(() => dexEntries().get(palette.id));
                          const seen = () => entry() !== undefined;
                          const shinySeen = () => entry()?.shinySeenAt != null;
                          const baseName = createMemo(() =>
                            entry() ? (entry()?.name ?? lobsterPaletteName(palette.id)) : "?",
                          );
                          const displayName = () => (shinySeen() ? `${baseName()} ✦` : baseName());
                          const lore = LOBSTER_PALETTE_LORE[palette.id];
                          const loreLine = () => (seen() ? lore.flavor : lore.hint);
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
                            <openclaw-tooltip>
                              <span
                                class={[
                                  "lobsterdex__mini",
                                  `lobster-pet--palette-${palette.id}`,
                                  { "lobsterdex__mini--unseen": !seen() },
                                ]}
                                style={lobsterLookStyle(look)}
                                tabindex={0}
                                role="img"
                                aria-label={ariaLabel()}
                              >
                                <Show when={artworkReady()}>
                                  <LobsterSvg look={look} standalone />
                                </Show>
                                {shinySeen() ? (
                                  <span class="lobsterdex__mini-star" aria-hidden="true">
                                    ✦
                                  </span>
                                ) : undefined}
                              </span>
                              <span slot="content" class="lobsterdex__tooltip">
                                <strong>{displayName()}</strong>
                                <span>{loreLine()}</span>
                                {visitedLine() ? <span>{visitedLine()}</span> : undefined}
                              </span>
                            </openclaw-tooltip>
                          );
                        }}
                      </For>
                    </div>
                    {props.lobsterdexHref ? (
                      <a
                        class="btn btn--sm lobsterdex__open"
                        href={props.lobsterdexHref}
                        onClick={(event: MouseEvent) =>
                          handleNavigationClick(event, () => props.onOpenLobsterdex?.())
                        }
                      >
                        {t("quickSettings.appearance.lobsterdexOpen")}
                      </a>
                    ) : undefined}
                  </div>
                }
              />
            </div>
          </section>
        );
      }}
    </Show>
  );
}
