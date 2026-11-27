// The note under Turn on remote access's steps when the admin's OpenClaw ID isn't linked to
// their profile at commit. When the Gateway no longer holds this browser's sign-in, it offers
// Link your profile: a device sign-in with `link`, the same fallback Settings → Profile uses
// (lib/openclaw-id/link-profile.ts). A device sign-in links a first account only when its
// verified email is this sign-in's own email; otherwise an owner-approved invitation does.
import { createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveControlUiPaths } from "../../app/browser.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { openClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { InlineAlert } from "../solid/inline-alert.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerProfileEnglish);

// The device sign-in dialog loads on demand.
const loadDeviceSignIn = () => import("./device-sign-in-dialog.tsx");

/** Why the admin's profile isn't linked after setup, and whether a sign-in here can link it. */
export type ProfileNotice = { message: string; canLink: boolean };

/**
 * The note for a profile-link outcome (commit's `profileLink` or a later link), or null once
 * linked. `sign_in_not_held` means the Gateway no longer holds this browser's sign-in, as after
 * a restart; a fresh device sign-in tries the link again.
 */
export function profileNotice(outcome: string | null): ProfileNotice | null {
  switch (outcome) {
    case "linked":
      return null;
    case "sign_in_not_held":
      return { message: t("openclawId.profileLinkSignIn"), canLink: true };
    case "linked_elsewhere":
      return { message: t("profilePage.openclawId.linkedElsewhere"), canLink: false };
    // The admin who just ran setup reads this. People and the invite form need an owner
    // browser, so the steps hand off to one and back.
    case "link_approval_required":
      return { message: t("openclawId.stepProfileLinkSteps"), canLink: false };
    case "profile_linked":
      return { message: t("profilePage.openclawId.profileLinked"), canLink: false };
    default:
      return { message: t("openclawId.stepProfileNotLinked"), canLink: false };
  }
}

/**
 * Shows `notice`, with Link your profile when a sign-in can link it. Reports the link's outcome through
 * `onChange` while `active()`; closing the sign-in dialog first keeps the note. Once setup
 * has closed, a pending link opens no sign-in dialog.
 */
export function SetupProfileNotice(props: {
  notice: ProfileNotice;
  client: GatewayBrowserClient;
  active: () => boolean;
  onChange: (notice: ProfileNotice | null) => void;
}) {
  const [linking, setLinking] = createSignal(false);
  const link = async () => {
    if (linking() || !props.active()) {
      return;
    }
    setLinking(true);
    try {
      const { showDeviceSignInDialog } = await loadDeviceSignIn();
      if (!props.active()) {
        return;
      }
      const done = await showDeviceSignInDialog({
        client: props.client,
        basePath: resolveControlUiPaths(window.location.pathname)[0],
        link: true,
      });
      if (done && props.active()) {
        props.onChange(profileNotice(done.link ?? null));
      }
    } catch (error) {
      if (props.active()) {
        props.onChange({ message: openClawIdUiError(error, "signIn").message, canLink: true });
      }
    } finally {
      setLinking(false);
    }
  };
  return (
    <InlineAlert
      tone="warning"
      class="openclaw-id-setup__profile"
      action={
        props.notice.canLink ? (
          <button
            type="button"
            class="btn btn--sm"
            disabled={linking()}
            onClick={() => void link()}
          >
            {t("openclawId.linkProfile")}
          </button>
        ) : undefined
      }
    >
      {props.notice.message}
    </InlineAlert>
  );
}
