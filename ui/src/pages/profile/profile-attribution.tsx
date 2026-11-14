import { Show } from "solid-js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/index.ts";
import { SettingsSectionHelp } from "../../components/solid/settings-section-help.tsx";
import { SettingsSection, SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import type { IdentityChange, ProfileState } from "./profile-state.ts";

export function ProfileAttribution(props: {
  getView: () => ProfileState;
  canEdit: boolean;
  busy: IdentityChange["kind"] | "loading" | null;
  gitCoauthorEnabled: boolean;
  prAttributionEnabled: boolean;
  onSave: (change: IdentityChange) => Promise<void>;
}) {
  const isOwnerProfile = () => props.getView().ownProfile?.id === GATEWAY_OWNER_PROFILE_ID;
  return (
    <Show when={props.getView().selfUser && props.getView().ownProfile}>
      <div id={PROFILE_SETTINGS_TARGET_IDS.attribution}>
        <SettingsSection
          title={t("profilePage.identity.attribution")}
          actions={
            <SettingsSectionHelp
              id="settings-profile-attribution-help"
              section={t("profilePage.identity.attribution")}
            >
              <p>
                <strong>{t("profilePage.identity.gitCoauthor")}</strong>{" "}
                {t("profilePage.identity.gitCoauthorDescription")}
              </p>
              <p>
                <strong>{t("profilePage.identity.prAttribution")}</strong>{" "}
                {t("profilePage.identity.prAttributionDescription")}
              </p>
            </SettingsSectionHelp>
          }
        >
          <SettingsToggleRow
            title={t("profilePage.identity.gitCoauthor")}
            description={
              <span class="settings-row__text">
                <span>
                  {isOwnerProfile()
                    ? t("profilePage.identity.ownerGitCoauthorDescription")
                    : props.getView().gitCoauthorOrganization
                      ? t("profilePage.identity.gitCoauthorOrganization")
                      : props.getView().ownProfile?.gitCoauthorIdentity
                        ? t("profilePage.identity.gitCoauthorGithub")
                        : props.getView().gitCoauthorAvailable
                          ? t("profilePage.identity.gitCoauthorShort")
                          : t("profilePage.identity.gitCoauthorConfigure")}
                </span>
                <Show
                  when={
                    !isOwnerProfile() &&
                    props.getView().gitCoauthorAvailable &&
                    props.getView().gitCoauthorIdentity
                  }
                >
                  {(identity) => (
                    <code class="identity-account">{`${identity().name} <${identity().email}>`}</code>
                  )}
                </Show>
              </span>
            }
            checked={
              !isOwnerProfile() && props.getView().gitCoauthorAvailable && props.gitCoauthorEnabled
            }
            disabled={
              !props.canEdit ||
              (props.busy !== null && props.busy !== "git-coauthor") ||
              isOwnerProfile() ||
              !props.getView().gitCoauthorAvailable
            }
            saving={props.busy === "git-coauthor"}
            onChange={(enabled) => void props.onSave({ kind: "git-coauthor", enabled })}
          />
          <SettingsToggleRow
            title={t("profilePage.identity.prAttribution")}
            description={
              <>
                {t("profilePage.identity.prAttributionShort")}{" "}
                <a
                  class="identity-attribution-link"
                  href="https://openclaw.ai"
                  target={EXTERNAL_LINK_TARGET}
                  rel={buildExternalLinkRel()}
                >
                  {t("profilePage.identity.prAttributionLink")}
                </a>
              </>
            }
            checked={props.prAttributionEnabled}
            disabled={!props.canEdit || props.busy !== null}
            onChange={(enabled) => void props.onSave({ kind: "pr-attribution", enabled })}
          />
          <Show when={props.getView().attributionError}>
            <div class="settings-row identity-error" role="alert">
              <span class="settings-row__desc">{props.getView().attributionError}</span>
            </div>
          </Show>
        </SettingsSection>
      </div>
    </Show>
  );
}
