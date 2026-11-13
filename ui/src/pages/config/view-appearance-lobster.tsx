import { createMemo, Show } from "solid-js";
import {
  BUILTIN_THEMES,
  resolveThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { projectLobsterdex } from "../../lib/reactive/events-browser.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
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
        return (
          <section class="settings-section">
            <SettingsSectionHeader title={t("configView.appearance.tabIcon.lobster")} />
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
              <Show when={props.lobsterdexHref}>
                {(href) => (
                  <a
                    class="settings-row settings-row--nav lobsterdex__open"
                    href={href()}
                    onClick={(event: MouseEvent) =>
                      handleNavigationClick(event, () => props.onOpenLobsterdex?.())
                    }
                  >
                    <span class="settings-row__text">
                      <span class="settings-row__title">
                        {t("quickSettings.appearance.lobsterdex")}
                      </span>
                      <span class="settings-row__desc">
                        {t("quickSettings.appearance.lobsterdexSeen", {
                          seen: String(seenCount()),
                          total: String(LOBSTER_PET_PALETTES.length),
                        })}
                      </span>
                    </span>
                    <span class="settings-row__control">
                      <span class="settings-row__chevron">
                        <Icon name="chevronRight" />
                      </span>
                    </span>
                  </a>
                )}
              </Show>
            </div>
          </section>
        );
      }}
    </Show>
  );
}
