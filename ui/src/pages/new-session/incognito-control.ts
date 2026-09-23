import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

/** Page-level session privacy control for the fixed new-session rail. */
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
  const active = submission.visibility === "incognito";
  const draftActive = submission.visibility === "draft";
  const disabledReason = submission.incognitoDisabledReason();
  const disabled =
    submission.submitting ||
    Boolean(submission.pendingPlacement.sessionKey) ||
    Boolean(disabledReason);
  const description = disabledReason ?? t("sessionsView.incognitoDescription");
  return html`
    <div class="new-session-page__incognito-rail">
      ${
        draftAvailable
          ? html`
              <openclaw-tooltip
                class="new-session-page__draft-tooltip"
                .content=${t("newSession.draftDescription")}
              >
                <button
                  type="button"
                  class="shell-chrome-controls__button new-session-page__draft-toggle ${
                    draftActive ? "new-session-page__draft-toggle--active" : ""
                  }"
                  role="switch"
                  aria-label=${`${t("newSession.draft")}: ${t("newSession.draftDescription")}`}
                  aria-checked=${String(draftActive)}
                  ?disabled=${
                    submission.submitting || Boolean(submission.pendingPlacement.sessionKey)
                  }
                  title=${t("newSession.draftDescription")}
                  @click=${() => submission.setVisibility(draftActive ? "normal" : "draft")}
                >
                  ${icons.pencil}
                  ${
                    draftActive
                      ? html`<span class="new-session-page__draft-toggle-label"
                          >${t("newSession.draft")}</span
                        >`
                      : nothing
                  }
                </button>
              </openclaw-tooltip>
            `
          : nothing
      }
      <openclaw-tooltip .content=${description}>
        <button
          type="button"
          class="shell-chrome-controls__button new-session-page__incognito-toggle ${
            active ? "new-session-page__incognito-toggle--active" : ""
          }"
          role="switch"
          aria-label=${t("sessionsView.incognitoLabel")}
          aria-checked=${String(active)}
          ?disabled=${disabled}
          title=${description}
          @click=${() => {
            if (!disabled) {
              submission.setVisibility(active ? "normal" : "incognito");
            }
          }}
        >
          ${icons.incognito}
          ${
            active
              ? html`<span class="new-session-page__incognito-toggle-label"
                  >${t("sessionsView.incognitoLabel")}</span
                >`
              : nothing
          }
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

/** Persistent context beside the draft while ephemeral session mode is active. */
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
