import { Icon } from "../../components/solid/icon.tsx";
import "../../components/tooltip.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { NewSessionVisibility } from "./create-params.ts";

registerNewSessionSetupEnglish();

export type NewSessionVisibilityControl = {
  visibility: NewSessionVisibility;
  submitting: boolean;
  pendingPlacement: { sessionKey: string };
  incognitoDisabledReason: () => string | undefined;
  setVisibility: (visibility: NewSessionVisibility) => void;
};

function VisibilityToggle(props: {
  submission: NewSessionVisibilityControl;
  mode: "draft" | "incognito";
  inHeader?: boolean;
}) {
  const draft = () => props.mode === "draft";
  const active = () => props.submission.visibility === props.mode;
  const reason = () => props.submission.incognitoDisabledReason();
  const disabled = () =>
    props.submission.submitting ||
    Boolean(props.submission.pendingPlacement.sessionKey) ||
    (!draft() && Boolean(reason()));
  const label = () => t(draft() ? "newSession.draft" : "sessionsView.incognitoLabel");
  const description = () =>
    draft()
      ? t("newSession.draftDescription")
      : (reason() ?? t("sessionsView.incognitoDescription"));
  const toggleClass = () => `new-session-page__${props.mode}-toggle`;
  return (
    <openclaw-tooltip prop:content={description()}>
      <button
        type="button"
        class={[
          props.inHeader ? "mobile-header__control" : "shell-chrome-controls__button",
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
        <Icon name={draft() ? "draft" : "incognito"} />
        {active() && !props.inHeader ? (
          <span class={[`new-session-page__${props.mode}-toggle-label`]}>{label()}</span>
        ) : undefined}
      </button>
    </openclaw-tooltip>
  );
}

/** Bare toggles; chat's phone header puts them in its capsule, with the on state on the icon alone. */
export function NewSessionVisibilityToggles(props: {
  submission: NewSessionVisibilityControl;
  draftAvailable: boolean;
  inHeader?: boolean;
}) {
  return (
    <>
      {props.draftAvailable || props.submission.visibility === "draft" ? (
        <VisibilityToggle submission={props.submission} mode="draft" inHeader={props.inHeader} />
      ) : undefined}
      <VisibilityToggle submission={props.submission} mode="incognito" inHeader={props.inHeader} />
    </>
  );
}

export function NewSessionIncognitoControl(props: {
  submission: NewSessionVisibilityControl;
  draftAvailable: boolean;
}) {
  return (
    <div class="new-session-page__incognito-rail">
      <NewSessionVisibilityToggles
        submission={props.submission}
        draftAvailable={props.draftAvailable}
      />
    </div>
  );
}

export function NewSessionIncognitoNotice(props: {
  active: boolean;
  ref?: (element: HTMLDivElement) => void;
}) {
  return (
    <div
      ref={(element) => props.ref?.(element)}
      class={[
        "new-session-page__incognito-notice",
        { "new-session-page__incognito-notice--visible": props.active },
      ]}
      role="status"
      aria-hidden={props.active ? "false" : "true"}
    >
      <span class="new-session-page__incognito-notice-icon" aria-hidden="true">
        <Icon name="incognito" />
      </span>
      <span>
        {t("sessionsView.incognitoDescription")} {t("sessionsView.incognitoLimits")}
      </span>
    </div>
  );
}
