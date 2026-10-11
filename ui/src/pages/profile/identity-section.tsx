import { Show } from "solid-js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import "../../components/viewer-facepile.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

registerEnglishCatalog(registerProfileEnglish);

type ViewerAvatarElement = HTMLElementTagNameMap["openclaw-viewer-avatar"];

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-viewer-avatar": HTMLAttributes<ViewerAvatarElement> & {
        "prop:user": ViewerAvatarElement["user"];
        variant?: ViewerAvatarElement["variant"];
      };
    }
  }
}

export type IdentitySectionProps = {
  config?: ApplicationConfigCapability;
  profile: UserProfile;
  canWrite?: boolean;
  avatarUrl: string | null;
  displayName: string;
  gitCoauthorEnabled: boolean;
  busy: "display-name" | "avatar" | "git-coauthor" | "loading" | null;
  error: string | null;
  onDisplayNameInput: (value: string) => void;
  onSaveDisplayName: () => void;
  onAvatarSelect: (file: File) => void;
  onGitCoauthorChange: (enabled: boolean) => void;
};

export function IdentitySection(props: IdentitySectionProps) {
  const canWrite = () => props.canWrite !== false;
  const isOwnerProfile = () => props.profile.id === GATEWAY_OWNER_PROFILE_ID;
  return (
    <div id={PROFILE_SETTINGS_TARGET_IDS.identity}>
      <SettingsSection
        title={t("profilePage.identity.title")}
        description={t("profilePage.identity.description")}
      >
        <Show when={!canWrite()}>
          <SettingsRow title={t("profilePage.identity.writeRequired")} />
        </Show>
        <SettingsRow
          title={t("profilePage.identity.avatar")}
          description={t("profilePage.identity.avatarDescription")}
          control={
            <span class="identity-avatar-control">
              <openclaw-viewer-avatar
                prop:user={{
                  id: props.profile.id,
                  name: props.profile.displayName ?? undefined,
                  email: props.profile.emails[0],
                  avatarUrl: props.avatarUrl ?? undefined,
                  watchedSessions: [],
                }}
                variant="profile"
              />
              <Show when={canWrite() && uploadsEnabled(props.config)}>
                <button
                  type="button"
                  class="btn btn--sm"
                  disabled={props.busy !== null}
                  onClick={(event) => {
                    const input = event.currentTarget.nextElementSibling;
                    if (
                      canWrite() &&
                      uploadsEnabled(props.config) &&
                      input instanceof HTMLInputElement
                    ) {
                      input.click();
                    }
                  }}
                >
                  {props.busy === "avatar"
                    ? t("profilePage.identity.processingAvatar")
                    : t("profilePage.identity.chooseAvatar")}
                </button>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  disabled={props.busy !== null}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    input.value = "";
                    if (file && canWrite() && uploadsEnabled(props.config)) {
                      props.onAvatarSelect(file);
                    }
                  }}
                />
              </Show>
            </span>
          }
        />
        <SettingsRow
          title={t("profilePage.identity.displayName")}
          description={t("profilePage.identity.displayNameDescription")}
          control={
            <form
              class="identity-name-control"
              onSubmit={(event) => {
                event.preventDefault();
                props.onSaveDisplayName();
              }}
            >
              <input
                class="settings-input"
                type="text"
                maxlength={256}
                aria-label={t("profilePage.identity.displayName")}
                value={props.displayName}
                disabled={!canWrite() || props.busy !== null}
                onInput={(event) => props.onDisplayNameInput(event.currentTarget.value)}
              />
              <button
                type="submit"
                class="btn btn--sm"
                disabled={
                  !canWrite() ||
                  props.busy !== null ||
                  props.displayName.trim() === (props.profile.displayName ?? "")
                }
              >
                {props.busy === "display-name" ? t("common.saving") : t("common.save")}
              </button>
            </form>
          }
        />
        <Show when={!isOwnerProfile()}>
          <SettingsRow
            title={t("profilePage.identity.linkedEmails")}
            description={t("profilePage.identity.linkedEmailsDescription")}
            control={
              props.profile.emails.length ? (
                <SettingsValue value={props.profile.emails.join(", ")} />
              ) : undefined
            }
          />
        </Show>
        <SettingsRow
          title={t("profilePage.identity.githubAccount")}
          description={
            isOwnerProfile()
              ? t("profilePage.identity.ownerGithubDescription")
              : props.profile.githubIdentity
                ? t("profilePage.identity.githubAccountDescription")
                : t("profilePage.identity.githubUnavailableDescription")
          }
          control={
            <Show
              when={props.profile.githubIdentity}
              fallback={
                <SettingsStatus kind="muted" label={t("profilePage.identity.githubUnavailable")} />
              }
            >
              {(identity) => (
                <>
                  <a
                    class="settings-account"
                    href={identity().profileUrl}
                    target={EXTERNAL_LINK_TARGET}
                    rel={buildExternalLinkRel()}
                  >
                    <img class="settings-account__avatar" src={identity().avatarUrl} alt="" />
                    <span class="settings-row__value settings-row__value--mono">
                      @{identity().login}
                    </span>
                  </a>
                  <SettingsStatus kind="ok" label={t("profilePage.identity.githubVerified")} />
                </>
              )}
            </Show>
          }
        />
        <SettingsToggleRow
          title={t("profilePage.identity.gitCoauthor")}
          description={
            isOwnerProfile()
              ? t("profilePage.identity.ownerGitCoauthorDescription")
              : props.profile.githubIdentity
                ? t("profilePage.identity.gitCoauthorDescription")
                : t("profilePage.identity.gitCoauthorUnavailable")
          }
          checked={Boolean(props.profile.githubIdentity && props.gitCoauthorEnabled)}
          disabled={!canWrite() || props.busy !== null || !props.profile.githubIdentity}
          onChange={props.onGitCoauthorChange}
        />
        <Show when={props.error}>
          <div class="settings-row identity-error" role="alert">
            <span class="settings-row__desc">{props.error}</span>
          </div>
        </Show>
      </SettingsSection>
    </div>
  );
}
