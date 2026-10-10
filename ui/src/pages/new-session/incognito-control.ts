import { html, nothing, svg } from "lit";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

const shredderIcon = strokeIcon(svg` <path
    d="M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5"
  />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M10 22v-5" />
  <path d="M14 19v-2" />
  <path d="M18 20v-3" />
  <path d="M2 13h20" />
  <path d="M6 20v-3" />`);

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
    const label = t(draft ? "newSession.draft" : "newSession.incognito");
    const description = draft
      ? t("newSession.draftDescription")
      : (disabledReason ?? t("newSession.incognitoDescription"));
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
          ${draft ? icons.pencil : shredderIcon}
          ${
            draft && active
              ? html`<span class="new-session-page__draft-toggle-label">${label}</span>`
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
  const description = t("newSession.incognitoDescription");
  return html`
    <div
      class="new-session-page__incognito-notice ${
        active ? "new-session-page__incognito-notice--visible" : ""
      }"
      role="status"
      aria-hidden=${String(!active)}
    >
      <span class="new-session-page__incognito-notice-icon" aria-hidden="true">
        ${shredderIcon}
      </span>
      <span>${description}</span>
    </div>
  `;
}
