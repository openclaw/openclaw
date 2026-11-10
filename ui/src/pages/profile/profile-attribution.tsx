import { Show } from "solid-js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/index.ts";
import { SettingsSectionHelp } from "../../components/solid/settings-section-help.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import type { IdentityChange, ProfileState } from "./profile-state.ts";

export function ProfileAttribution(props: {
  state: ProfileState;
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
              // Publication selects its host independently of the displayed primary account.
              isOwnerProfile()
                ? t("profilePage.identity.ownerGitCoauthorDescription")
                : props.getView().gitCoauthorAvailable
                  ? t("profilePage.identity.gitCoauthorShort")
                  : t("profilePage.identity.gitCoauthorConfigure")
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
          <Show when={!isOwnerProfile()}>
            <SettingsRow
              title={t("profilePage.identity.gitCoauthorSource")}
              description={
                props.getView().gitCoauthorIdentity
                  ? t("profilePage.identity.gitCoauthorCustom")
                  : props.getView().gitCoauthorOrganization
                    ? t("profilePage.identity.gitCoauthorOrganization")
                    : props.getView().ownProfile?.githubIdentity
                      ? t("profilePage.identity.gitCoauthorGithub")
                      : props.getView().ownProfile?.gitCoauthorAvailable
                        ? t("profilePage.identity.gitCoauthorGithubHost")
                        : t("profilePage.identity.gitCoauthorNoSource")
              }
              control={
                <Show
                  when={
                    props.getView().gitCoauthorIdentity ?? props.getView().gitCoauthorOrganization
                  }
                >
                  {(identity) => (
                    <SettingsValue value={`${identity().name} <${identity().email}>`} />
                  )}
                </Show>
              }
            />
            <SettingsRow
              title={t("profilePage.identity.gitCoauthorDetails")}
              description={t("profilePage.identity.gitCoauthorDetailsDescription")}
              stacked
              control={
                <form
                  class="identity-coauthor-form model-accounts-flow"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void props.onSave({ kind: "git-coauthor-identity" });
                  }}
                >
                  <label for="git-coauthor-name">{t("profilePage.identity.gitCoauthorName")}</label>
                  <input
                    id="git-coauthor-name"
                    class="settings-input"
                    type="text"
                    maxlength={256}
                    value={props.getView().gitCoauthorName}
                    disabled={!props.canEdit || props.busy !== null}
                    onInput={(event) => {
                      props.state.gitCoauthorName = event.currentTarget.value;
                      props.state.publish();
                    }}
                  />
                  <label for="git-coauthor-email">
                    {t("profilePage.identity.gitCoauthorEmail")}
                  </label>
                  <input
                    id="git-coauthor-email"
                    class="settings-input"
                    type="email"
                    maxlength={254}
                    value={props.getView().gitCoauthorEmail}
                    disabled={!props.canEdit || props.busy !== null}
                    onInput={(event) => {
                      props.state.gitCoauthorEmail = event.currentTarget.value;
                      props.state.publish();
                    }}
                  />
                  <button
                    type="submit"
                    class="btn btn--sm"
                    disabled={
                      !props.canEdit ||
                      props.busy !== null ||
                      (props.getView().gitCoauthorName ===
                        (props.getView().gitCoauthorIdentity?.name ?? "") &&
                        props.getView().gitCoauthorEmail ===
                          (props.getView().gitCoauthorIdentity?.email ?? ""))
                    }
                  >
                    {props.busy === "git-coauthor-identity" ? t("common.saving") : t("common.save")}
                  </button>
                  <Show when={props.getView().gitCoauthorIdentity}>
                    <button
                      type="button"
                      class="btn btn--sm identity-coauthor-clear"
                      disabled={!props.canEdit || props.busy !== null}
                      onClick={() =>
                        void props.onSave({ kind: "git-coauthor-identity", clear: true })
                      }
                    >
                      {t("profilePage.identity.gitCoauthorClear")}
                    </button>
                  </Show>
                </form>
              }
            />
          </Show>
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
