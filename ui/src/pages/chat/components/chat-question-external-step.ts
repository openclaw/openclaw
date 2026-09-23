import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../../lib/external-link.ts";

export function renderQuestionExternalStep(url: string | undefined) {
  return url
    ? html`<div class="chat-question-panel__external">
        <a
          class="btn btn--sm"
          href=${url}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
        >
          ${icons.externalLink} ${t("chat.questions.openLink")}
        </a>
        <span class="muted">${t("chat.questions.externalStepHint")}</span>
      </div>`
    : nothing;
}
