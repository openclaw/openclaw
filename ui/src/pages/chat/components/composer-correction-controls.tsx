import { createUniqueId } from "solid-js";
import { registerChatCorrectionsEnglish } from "../../../i18n/locales/en-chat-corrections.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

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
    <div class="filters composer-correction-controls">
      <label class="filters" style={{ "min-width": 0 }}>
        <span>{t("chat.corrections.policy")}</span>
        <select
          value={props.policy}
          style={{ "min-width": 0, "max-width": "100%" }}
          disabled={props.disabled}
          onChange={(event) =>
            props.onPolicyChange(event.currentTarget.value === "explicit" ? "explicit" : "off")
          }
        >
          <option value="off">{t("chat.corrections.off")}</option>
          <option value="explicit">{t("chat.corrections.explicit")}</option>
        </select>
      </label>
      <label class="field checkbox">
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
