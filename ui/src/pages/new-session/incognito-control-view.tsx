import { Show, createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import "../../components/tooltip.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import * as catalog from "./catalog-target.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { NewSessionPageOwner } from "./new-session-page-owner.ts";

registerNewSessionSetupEnglish();

/** Matches the docked layout in new-session.css, where the inline notice would move the draft. */
export const NEW_SESSION_DOCKED_LAYOUT_QUERY =
  "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

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
      : (reason() ?? t("sessionsView.incognitoDescriptionTooltip"));
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

/** The docked layout swaps the hint for this line in place, so turning Incognito on moves nothing. */
export function DraftWelcomeHint(props: {
  page: NewSessionPageOwner;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const hint = createMemo(() => props.page.welcomeHint());
  return (
    <Show when={!catalog.isTarget(props.page.data)} fallback={hint()}>
      <Show when={hint() || props.page.submission.visibility === "incognito"}>
        <span class="new-session-page__welcome-hint">
          <Show when={hint()}>
            <span class="new-session-page__welcome-hint-text">{hint()}</span>
          </Show>
          <Popover
            id="new-session-incognito-note"
            lazy="while-open"
            label={t("sessionsView.incognitoLabel")}
            class="new-session-page__incognito-note"
            triggerClass="new-session-page__incognito-status"
            trigger={
              <>
                <span>{t("sessionsView.incognitoLabel")}</span>
                <Icon name="info" />
              </>
            }
            placement="bottom"
            open={props.open}
            onOpenChange={props.setOpen}
          >
            {/* Read-only, and it can cover the composer on short screens: any tap dismisses it. */}
            <div onClick={() => props.setOpen(false)}>
              <p>{t("sessionsView.incognitoDescription")}</p>
              <p>{t("sessionsView.incognitoLimits")}</p>
            </div>
          </Popover>
        </span>
      </Show>
    </Show>
  );
}
