import { Show } from "solid-js";
import { patchSettings } from "../../app/settings.ts";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { DictationPunctuationFields } from "../chat/components/dictation-punctuation-fields.tsx";

export function DictationRefinementSettings() {
  const context = useApplication();
  const preferences = projectTheme(context.theme).preferences;
  return (
    <SettingsSection
      title={t("chat.dictation.punctuation.title")}
      description={t("chat.dictation.punctuation.settingsDescription")}
    >
      <div class="dictation-refinement-settings">
        <Show when={preferences.read().dictationRefinementIssue}>
          <p role="alert">{t("chat.dictation.punctuation.invalidPreference")}</p>
          <button
            type="button"
            class="btn"
            onClick={() =>
              patchSettings({ dictationRefinement: undefined, dictationRefinementIssue: undefined })
            }
          >
            {t("chat.dictation.punctuation.resetPreference")}
          </button>
        </Show>
        <DictationPunctuationFields
          value={preferences.read().dictationRefinement}
          allowDisabled
          onChange={(policy) =>
            patchSettings({
              dictationRefinement: policy ? { version: 1, ...policy } : undefined,
              dictationRefinementIssue: undefined,
            })
          }
        />
        <p>{t("chat.dictation.punctuation.policyHelp")}</p>
        <p>{t("chat.dictation.punctuation.explicitHelp")}</p>
        <p>{t("chat.dictation.punctuation.verbatimHelp")}</p>
      </div>
    </SettingsSection>
  );
}
