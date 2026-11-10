import type { ApplicationContext } from "../../app/context-types.ts";
import { resetServerUiPref, selectThemeSettings } from "../../app/server-prefs-controls.ts";
import { canSyncAppearancePreference } from "../../app/server-prefs-profile-runtime.ts";
import { resolveServerUiPrefState } from "../../app/server-prefs-reconcile.ts";
import { isAppearancePref, type ResettableServerUiPrefKey } from "../../app/server-prefs-state.ts";
import {
  normalizeChatSendShortcut,
  patchSettings,
  UI_APPEARANCE_DEFAULTS,
  type UiSettings,
} from "../../app/settings.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import type { TypefaceId } from "../../app/typography.ts";
import { getLobsterdex } from "../../components/lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { i18n, isSupportedLocale, type Locale } from "../../i18n/index.ts";
import { currentDisplayConfig } from "../../lib/config/config-state-model.ts";

/** Resolves preference provenance and delegates changes to the canonical preference owners. */
export function createConfigPagePreferences(context: ApplicationContext, invalidate: () => void) {
  const settings = () => context.theme.settings;

  function apply(patch: Partial<UiSettings>, selectedTheme?: ThemeName) {
    if (selectedTheme) {
      selectThemeSettings(selectedTheme, patch);
    } else {
      patchSettings(patch);
    }
    invalidate();
  }

  function current<K extends ResettableServerUiPrefKey>(key: K) {
    const appearance = isAppearancePref(key);
    return resolveServerUiPrefState(
      currentDisplayConfig(context.runtimeConfig.state),
      key,
      context.gateway.connection.gatewayUrl,
      settings(),
      {
        canSync: canSyncAppearancePreference(context, appearance ? key : undefined),
        profileId: appearance ? context.gateway.snapshot?.selfUser?.id : undefined,
      },
    );
  }

  function setFont(key: "fontUi" | "fontChat", font: TypefaceId | undefined) {
    const preference = current(key);
    if (preference.overridden && font === preference.resetValue) {
      reset(key);
    } else {
      apply({ [key]: font });
    }
  }

  function reset(key: ResettableServerUiPrefKey) {
    const resetSettings = resetServerUiPref(
      key,
      current(key),
      context.gateway.connection.gatewayUrl,
      context.gateway.snapshot?.selfUser?.id,
    );
    if (key === "locale") {
      if (isSupportedLocale(resetSettings.locale)) {
        void i18n.setLocale(resetSettings.locale);
      } else {
        void i18n.useSystemLocale();
      }
    } else {
      invalidate();
    }
  }

  return {
    apply,
    read() {
      const themePref = current("theme");
      const themeModePref = current("themeMode");
      const accentPref = current("accent");
      const localePref = current("locale");
      const chatSendShortcutPref = current("chatSendShortcut");
      const chatFollowUpModePref = current("chatFollowUpMode");
      return {
        onAppearanceChange: apply,
        setTabIconMode: (preference: NonNullable<UiSettings["tabIcon"]>) => {
          if (
            preference.startsWith("lobster:") &&
            (!context.theme.branding.lobsterdex ||
              !LOBSTER_PET_PALETTES.some((palette) => palette.id === preference.slice(8)) ||
              !getLobsterdex().has(preference.slice(8)))
          ) {
            return;
          }
          apply({ tabIcon: preference });
        },
        theme: settings().theme,
        themeOverridden: themePref.overridden,
        themeProvenance: themePref.provenance,
        themeResetValue: themePref.resetValue ?? UI_APPEARANCE_DEFAULTS.theme,
        themeMode: settings().themeMode,
        themeModeOverridden: themeModePref.overridden,
        themeModeProvenance: themeModePref.provenance,
        themeModeResetValue: themeModePref.resetValue ?? UI_APPEARANCE_DEFAULTS.themeMode,
        accent: settings().accent,
        accentProvenance: accentPref.provenance,
        accentResetValue: accentPref.resetValue,
        fontUi: settings().fontUi,
        fontChat: settings().fontChat,
        fontUiProvenance: current("fontUi").provenance,
        fontChatProvenance: current("fontChat").provenance,
        setFontUi: (font: TypefaceId | undefined) => setFont("fontUi", font),
        setFontChat: (font: TypefaceId | undefined) => setFont("fontChat", font),
        systemLocale: i18n.getSystemLocale(),
        localeOverride: isSupportedLocale(localePref.value) ? localePref.value : undefined,
        localeOverridden: localePref.overridden,
        localeProvenance: localePref.provenance,
        localeResetValue: isSupportedLocale(localePref.resetValue)
          ? localePref.resetValue
          : undefined,
        onLocaleChange: (locale: Locale | undefined) => {
          if (locale === undefined) {
            reset("locale");
            return;
          }
          patchSettings({ locale });
          void i18n.setLocale(locale);
          invalidate();
        },
        setTheme: (theme: ThemeName) => {
          const preference = current("theme");
          if (preference.overridden && theme === preference.resetValue) {
            reset("theme");
          } else {
            apply({}, theme);
          }
        },
        setThemeMode: (mode: ThemeMode) => {
          const preference = current("themeMode");
          if (preference.overridden && mode === preference.resetValue) {
            reset("themeMode");
          } else {
            context.theme.setMode(mode);
          }
        },
        setAccent: (accent: string | undefined) =>
          accent === undefined ? reset("accent") : apply({ accent }),
        chatSendShortcut: normalizeChatSendShortcut(settings().chatSendShortcut),
        chatSendShortcutOverridden: chatSendShortcutPref.overridden,
        chatSendShortcutProvenance: chatSendShortcutPref.provenance,
        chatSendShortcutResetValue:
          chatSendShortcutPref.resetValue ?? UI_APPEARANCE_DEFAULTS.chatSendShortcut,
        chatFollowUpMode: settings().chatFollowUpMode,
        chatFollowUpModeOverridden: chatFollowUpModePref.overridden,
        chatFollowUpModeProvenance: chatFollowUpModePref.provenance,
        resetChatFollowUpMode: () => reset("chatFollowUpMode"),
      };
    },
  };
}
