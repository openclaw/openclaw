import { Show } from "solid-js";
import { registerChatDictationEnglish } from "../../../i18n/locales/en-chat-dictation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";

registerChatDictationEnglish();

export function DictationRefinementView(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  const owner = () => props.readDictation();
  const refinement = () => owner()?.refinement;
  const phase = () => refinement()?.phase;
  const status = () => {
    switch (phase()) {
      case "finishing":
        return t("chat.dictation.refinementFinishing");
      case "refined":
        return t("chat.dictation.refinementReady");
      case "raw-fallback":
        return t("chat.dictation.refinementRaw");
      case "needs-review":
        return t("chat.dictation.refinementReview");
      case "cancelled":
        return t("chat.dictation.refinementCancelled");
      case "unavailable":
        return t(
          refinement()?.captionLimitExceeded
            ? "chat.dictation.refinementLimit"
            : "chat.dictation.refinementUnavailable",
        );
      default:
        return "";
    }
  };
  return (
    <Show when={owner()?.refinementAvailable}>
      <div class="agent-chat__dictation-refinement" style={{ "min-width": "0" }}>
        <details
          open={owner()?.refinementOptionsOpen === true}
          onToggle={(event) => owner()?.setRefinementOptionsOpen(event.currentTarget.open)}
        >
          <summary>{t("chat.dictation.refinementOptions")}</summary>
          <label>
            <input
              type="checkbox"
              checked={owner()?.refinementEnabled === true}
              onChange={(event) => owner()?.setRefinementEnabled(event.currentTarget.checked)}
            />{" "}
            {t("chat.dictation.refinementEnable")}
          </label>
          <p class="muted">{t("chat.dictation.refinementLocalScope")}</p>
          <p class="muted">{t("chat.dictation.refinementModelUnavailable")}</p>
        </details>
        <Show when={owner()?.refinementEnabled}>
          <p role="status" aria-live="polite" aria-atomic="true">
            {status()}
          </p>
          <Show when={owner()?.active && owner()?.provisionalTranscript}>
            <label>
              {t("chat.dictation.refinementCaption")}
              <textarea
                readOnly
                dir="auto"
                aria-live="off"
                value={owner()?.provisionalTranscript ?? ""}
                style={{ width: "100%", "box-sizing": "border-box" }}
              />
            </label>
          </Show>
          <Show when={refinement()?.result?.text}>
            <label>
              {t("chat.dictation.refinementPreview")}
              <textarea
                readOnly
                dir="auto"
                value={refinement()?.result?.candidateText ?? refinement()?.result?.text ?? ""}
                style={{ width: "100%", "box-sizing": "border-box" }}
              />
            </label>
            <details>
              <summary>{t("chat.dictation.refinementInspect")}</summary>
              <label>
                {t("chat.dictation.refinementOriginal")}
                <textarea
                  readOnly
                  dir="auto"
                  value={refinement()?.result?.rawText ?? ""}
                  style={{ width: "100%", "box-sizing": "border-box" }}
                />
              </label>
              <p class="muted">{t("chat.dictation.refinementMeaning")}</p>
            </details>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "0.5rem" }}>
              <button type="button" onClick={() => refinement()?.accept("raw")}>
                {t("chat.dictation.refinementKeepRaw")}
              </button>
              <button type="button" onClick={() => refinement()?.accept("candidate")}>
                {t("chat.dictation.refinementUse")}
              </button>
            </div>
          </Show>
          <Show when={refinement()?.incompleteCaption}>
            <label>
              {t("chat.dictation.refinementIncomplete")}
              <textarea
                readOnly
                dir="auto"
                value={refinement()?.incompleteCaption ?? ""}
                style={{ width: "100%", "box-sizing": "border-box" }}
              />
            </label>
          </Show>
          <Show when={owner()?.active || refinement()?.pending}>
            <button type="button" onClick={() => owner()?.cancel()}>
              {t("chat.dictation.refinementCancel")}
            </button>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
