import { createUniqueId, Show } from "solid-js";
import { registerChatDictationEnglish } from "../../../i18n/locales/en-chat-dictation.ts";
import type { DictationPunctuationPolicy } from "../../../lib/dictation-refinement.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./dictation-refinement.css";

registerEnglishCatalog(registerChatDictationEnglish);

/** Shared native controls; the caller owns either the saved preference or an unsent review. */
export function DictationPunctuationFields(props: {
  value: DictationPunctuationPolicy | undefined;
  allowDisabled?: boolean;
  disabled?: boolean;
  onChange: (value: DictationPunctuationPolicy | undefined) => void;
}) {
  const policy = (): DictationPunctuationPolicy =>
    props.value ?? { mode: "verbatim", explicitEnabled: false };
  // Name each select by its caption alone; its options' text is not part of the label.
  const modeLabel = `dictation-punctuation-mode-${createUniqueId()}`;
  const localeLabel = `dictation-punctuation-locale-${createUniqueId()}`;
  return (
    <fieldset class="dictation-punctuation-fields" disabled={props.disabled}>
      <legend>{t("chat.dictation.punctuation.policy")}</legend>
      <label>
        <span id={modeLabel}>{t("chat.dictation.punctuation.mode")}</span>
        <select
          aria-labelledby={modeLabel}
          class="settings-select"
          value={props.value?.mode ?? "off"}
          onChange={(event) => {
            const mode = event.currentTarget.value;
            if (mode === "off" && props.allowDisabled) {
              props.onChange(undefined);
            } else if (mode === "verbatim" || mode === "automatic" || mode === "explicit") {
              props.onChange({ ...policy(), mode });
            }
          }}
        >
          <Show when={props.allowDisabled}>
            <option value="off">{t("chat.dictation.punctuation.off")}</option>
          </Show>
          <option value="verbatim">{t("chat.dictation.punctuation.verbatim")}</option>
          <option value="automatic">{t("chat.dictation.punctuation.automatic")}</option>
          <option value="explicit">{t("chat.dictation.punctuation.explicit")}</option>
        </select>
      </label>
      <Show when={props.value}>
        <label>
          <span id={localeLabel}>{t("chat.dictation.punctuation.locale")}</span>
          <select
            aria-labelledby={localeLabel}
            class="settings-select"
            value={policy().locale ?? ""}
            onChange={(event) =>
              props.onChange({ ...policy(), locale: event.currentTarget.value || undefined })
            }
          >
            <option value="">{t("chat.dictation.punctuation.localeUnset")}</option>
            <option value="en-US">{t("chat.dictation.punctuation.englishUs")}</option>
            <Show when={policy().locale && policy().locale !== "en-US"}>
              <option value={policy().locale}>{policy().locale}</option>
            </Show>
          </select>
        </label>
        <label class="dictation-punctuation-fields__check">
          <input
            type="checkbox"
            checked={policy().explicitEnabled}
            onChange={(event) =>
              props.onChange({ ...policy(), explicitEnabled: event.currentTarget.checked })
            }
          />
          <span>{t("chat.dictation.punctuation.enableExplicit")}</span>
        </label>
        <label class="dictation-punctuation-fields__check">
          <input
            type="checkbox"
            checked={policy().fragment === true}
            onChange={(event) =>
              props.onChange({ ...policy(), fragment: event.currentTarget.checked })
            }
          />
          <span>{t("chat.dictation.punctuation.fragment")}</span>
        </label>
      </Show>
    </fieldset>
  );
}
