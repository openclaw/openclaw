import { createUniqueId } from "solid-js";
import { registerChatCorrectionsEnglish } from "../../../i18n/locales/en-chat-corrections.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/composer-correction-controls.css";

registerEnglishCatalog(registerChatCorrectionsEnglish);

export function ComposerCorrectionControls(props: {
  policy: "off" | "explicit";
  literal: boolean;
  disabled?: boolean;
  onPolicyChange: (policy: "off" | "explicit") => void;
  onLiteralChange: (literal: boolean) => void;
}) {
  const hintId = `composer-correction-literal-${createUniqueId()}`;
  return (
    <div class="composer-correction-controls">
      <label class="composer-correction-controls__policy">
        <span>{t("chat.corrections.policy")}</span>
        <select
          value={props.policy}
          disabled={props.disabled}
          onChange={(event) =>
            props.onPolicyChange(event.currentTarget.value === "explicit" ? "explicit" : "off")
          }
        >
          <option value="off">{t("chat.corrections.off")}</option>
          <option value="explicit">{t("chat.corrections.explicit")}</option>
        </select>
      </label>
      <label class="composer-correction-controls__literal">
        <input
          type="checkbox"
          checked={props.literal}
          disabled={props.disabled || props.policy === "off"}
          aria-describedby={hintId}
          onChange={(event) => props.onLiteralChange(event.currentTarget.checked)}
        />
        <span>{t("chat.corrections.literal")}</span>
      </label>
      <span class="sr-only" id={hintId}>
        {t("chat.corrections.literalHint")}
      </span>
    </div>
  );
}
