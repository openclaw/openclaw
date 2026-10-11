import { Icon } from "../../components/solid/icon.tsx";
import "../../components/tooltip.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { NewSessionVisibilityControl } from "./incognito-control.ts";

registerNewSessionSetupEnglish();

function ShredderIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 22v-5" />
      <path d="M14 19v-2" />
      <path d="M18 20v-3" />
      <path d="M2 13h20" />
      <path d="M6 20v-3" />
    </svg>
  );
}

function VisibilityToggle(props: {
  submission: NewSessionVisibilityControl;
  mode: "draft" | "incognito";
}) {
  const draft = () => props.mode === "draft";
  const active = () => props.submission.visibility === props.mode;
  const reason = () => props.submission.incognitoDisabledReason();
  const disabled = () =>
    props.submission.submitting ||
    Boolean(props.submission.pendingPlacement.sessionKey) ||
    (!draft() && Boolean(reason()));
  const label = () => t(draft() ? "newSession.draft" : "newSession.incognito");
  const description = () =>
    draft() ? t("newSession.draftDescription") : (reason() ?? t("newSession.incognitoDescription"));
  const toggleClass = () => `new-session-page__${props.mode}-toggle`;
  return (
    <openclaw-tooltip
      class={draft() ? "new-session-page__draft-tooltip" : undefined}
      prop:content={description()}
    >
      <button
        type="button"
        class={[
          "shell-chrome-controls__button",
          toggleClass(),
          { [`${toggleClass()}--active`]: active() },
        ]}
        role="switch"
        aria-label={draft() ? `${label()}: ${description()}` : label()}
        aria-checked={active() ? "true" : "false"}
        disabled={disabled()}
        title={description()}
        onClick={() => {
          if (draft() || !disabled()) {
            props.submission.setVisibility(active() ? "normal" : props.mode);
          }
        }}
      >
        {draft() ? <Icon name="pencil" /> : <ShredderIcon />}
        {draft() && active() ? (
          <span class="new-session-page__draft-toggle-label">{label()}</span>
        ) : undefined}
      </button>
    </openclaw-tooltip>
  );
}

export function NewSessionIncognitoControl(props: {
  submission: NewSessionVisibilityControl;
  draftAvailable: boolean;
}) {
  return (
    <div class="new-session-page__incognito-rail">
      {props.draftAvailable ? (
        <VisibilityToggle submission={props.submission} mode="draft" />
      ) : undefined}
      <VisibilityToggle submission={props.submission} mode="incognito" />
    </div>
  );
}

export function NewSessionIncognitoNotice(props: { active: boolean }) {
  return (
    <div
      class={[
        "new-session-page__incognito-notice",
        { "new-session-page__incognito-notice--visible": props.active },
      ]}
      role="status"
      aria-hidden={props.active ? "false" : "true"}
    >
      <span class="new-session-page__incognito-notice-icon" aria-hidden="true">
        <ShredderIcon />
      </span>
      <span>{t("newSession.incognitoDescription")}</span>
    </div>
  );
}
