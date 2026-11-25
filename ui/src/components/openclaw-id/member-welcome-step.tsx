// A member's first arrival, asked in the new-session page where the composer will be: their
// name, then a photo. Nothing here is a message; both answers are saved to this Gateway's profile.
import "./member-welcome-step.css";
import { createSignal, onSettled, Show } from "solid-js";
import type {
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { MemberWelcomeState } from "../../lib/openclaw-id/member-welcome.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import { processProfileAvatar, ProfileAvatarError } from "../../pages/profile/avatar-processing.ts";
import { userProfileAvatarUrl } from "../../pages/profile/profile-avatar-url.ts";
import { clawNameFromHostname } from "./claw-name.ts";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);

export function MemberWelcomeStep(props: {
  context: Pick<ApplicationContext, "gateway" | "config" | "resourceBasePath">;
  due: Extract<MemberWelcomeState, { kind: "due" }>;
  /** Called once the member has named themselves or skipped. */
  onAnswered: () => void;
}) {
  const [name, setName] = createSignal("");
  const [savedName, setSavedName] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let input: HTMLInputElement | undefined;
  onSettled(() => input?.focus());
  const finish = (shownName: string | null) => {
    if (shownName) {
      showToast({ severity: "success", message: t("openclawId.welcomeDone", { name: shownName }) });
    }
    props.onAnswered();
  };
  const settle = async (work: Promise<void>, failed: string) => {
    setBusy(true);
    setError(null);
    try {
      await work;
    } catch (cause) {
      setError(
        cause instanceof ProfileAvatarError
          ? t(
              cause.code === "source-too-large"
                ? "openclawId.welcomePhotoSourceTooLarge"
                : cause.code === "too-large"
                  ? "openclawId.welcomePhotoTooLarge"
                  : "openclawId.welcomePhotoInvalid",
            )
          : formatUiError(cause, failed),
      );
    } finally {
      setBusy(false);
    }
  };
  async function writeName(displayName: string) {
    await props.due.client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
      profileId: props.due.self.id,
      displayName,
    });
    props.context.gateway.updateSelfUser?.({ name: displayName });
    if (uploadsEnabled(props.context.config)) {
      setSavedName(displayName);
    } else {
      finish(displayName);
    }
  }
  async function writePhoto(file: File, displayName: string) {
    const avatar = await processProfileAvatar(file);
    const result = await props.due.client.request<UsersSetAvatarResult>("users.setAvatar", {
      profileId: props.due.self.id,
      mime: avatar.mime,
      avatarBase64: avatar.avatarBase64,
    });
    const avatarUrl = userProfileAvatarUrl(
      props.context.gateway.connection.gatewayUrl,
      result.profile.id,
      result.avatarRevision,
      props.context.resourceBasePath,
    );
    if (avatarUrl) {
      props.context.gateway.updateSelfUser?.({ avatarUrl });
    }
    finish(displayName);
  }
  return (
    <section class="openclaw-id-welcome-step" aria-live="polite">
      <Show
        when={savedName()}
        fallback={
          <>
            <p>
              {props.due.welcome.hostname
                ? t("openclawId.welcomeTitle", {
                    name: clawNameFromHostname(props.due.welcome.hostname),
                  })
                : t("openclawId.welcomeTitlePlain")}
              <Show when={props.due.welcome.inviter}>
                {(inviter) => <> {t("openclawId.welcomeInvitedBy", { inviter: inviter() })}</>}
              </Show>
            </p>
            <Show when={props.due.welcome.email}>
              {(email) => (
                <p class="openclaw-id-welcome-step__account">
                  {t("openclawId.welcomeAccount", { account: email() })}
                </p>
              )}
            </Show>
            <p class="openclaw-id-welcome-step__ask">{t("openclawId.welcomeAskName")}</p>
            <form
              class="openclaw-id-welcome-step__row"
              onSubmit={(event) => {
                event.preventDefault();
                const displayName = name().trim();
                if (displayName && !busy()) {
                  void settle(writeName(displayName), t("openclawId.welcomeNameFailed"));
                }
              }}
            >
              <input
                ref={(element) => {
                  input = element;
                }}
                type="text"
                name="name"
                maxlength="256"
                autocomplete="name"
                aria-label={t("openclawId.welcomeName")}
                placeholder={t("openclawId.welcomeName")}
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
              <button type="submit" class="btn primary" disabled={!name().trim() || busy()}>
                {t("common.continue")}
              </button>
              <button
                type="button"
                class="btn"
                disabled={busy()}
                onClick={() => finish(props.due.welcome.currentName)}
              >
                {t("openclawId.welcomeSkip")}
              </button>
            </form>
          </>
        }
      >
        {(displayName) => (
          <>
            <p class="openclaw-id-welcome-step__ask">
              {t("openclawId.welcomeAskPhoto", { name: displayName() })}
            </p>
            <div class="openclaw-id-welcome-step__row">
              <button
                type="button"
                class="btn primary"
                disabled={busy()}
                onClick={(event) => {
                  const file = event.currentTarget.nextElementSibling;
                  if (file instanceof HTMLInputElement) {
                    file.click();
                  }
                }}
              >
                <Show when={busy()}>
                  <span class="btn__spinner" aria-hidden="true" />
                </Show>
                {t("openclawId.welcomePhoto")}
              </button>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                disabled={busy()}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) {
                    void settle(
                      writePhoto(file, displayName()),
                      t("openclawId.welcomePhotoFailed"),
                    );
                  }
                }}
              />
              <button
                type="button"
                class="btn"
                disabled={busy()}
                onClick={() => finish(displayName())}
              >
                {t("openclawId.welcomePhotoSkip")}
              </button>
            </div>
          </>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="openclaw-id-welcome-step__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </section>
  );
}
