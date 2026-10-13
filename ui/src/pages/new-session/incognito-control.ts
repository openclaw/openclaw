import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

export function renderNewSessionIncognitoControl(
  submission: {
    visibility: NewSessionVisibility;
    submitting: boolean;
    pendingPlacement: { sessionKey: string };
    incognitoDisabledReason: () => string | undefined;
    setVisibility: (visibility: NewSessionVisibility) => void;
  },
  draftAvailable: boolean,
) {
  const visibility = submission.visibility;
  const disabledReason = submission.incognitoDisabledReason();
  const busy = submission.submitting || Boolean(submission.pendingPlacement.sessionKey);
  const renderToggle = (mode: "draft" | "incognito") => {
    const draft = mode === "draft";
    const active = visibility === mode;
    const disabled = busy || (!draft && Boolean(disabledReason));
    const label = t(draft ? "newSession.draft" : "sessionsView.incognitoLabel");
    const description = draft
      ? t("newSession.draftDescription")
      : (disabledReason ?? t("sessionsView.incognitoDescription"));
    const toggleClass = `new-session-page__${mode}-toggle`;
    return html`
      <openclaw-tooltip
        class=${draft ? "new-session-page__draft-tooltip" : nothing}
        .content=${description}
      >
        <button
          type="button"
          class="shell-chrome-controls__button ${toggleClass} ${active ? `${toggleClass}--active` : ""}"
          role="switch"
          aria-label=${draft ? `${label}: ${description}` : label}
          aria-checked=${String(active)}
          ?disabled=${disabled}
          title=${description}
          @click=${() => {
            if (draft || !disabled) {
              submission.setVisibility(active ? "normal" : mode);
            }
          }}
        >
          ${draft ? icons.pencil : icons.incognito}
          ${
            active
              ? html`<span class=${`new-session-page__${mode}-toggle-label`}>${label}</span>`
              : nothing
          }
        </button>
      </openclaw-tooltip>
    `;
  };
  return html`
    <div class="new-session-page__incognito-rail">
      ${draftAvailable ? renderToggle("draft") : nothing} ${renderToggle("incognito")}
    </div>
  `;
}

export function renderNewSessionIncognitoNotice(active: boolean) {
  const description = t("sessionsView.incognitoDescription");
  return html`
    <div
      class="new-session-page__incognito-notice ${
        active ? "new-session-page__incognito-notice--visible" : ""
      }"
      role="status"
      aria-hidden=${String(!active)}
    >
      <span class="new-session-page__incognito-notice-icon" aria-hidden="true">
        ${icons.incognito}
      </span>
      <span>${description} ${t("sessionsView.incognitoLimits")}</span>
    </div>
  `;
}
