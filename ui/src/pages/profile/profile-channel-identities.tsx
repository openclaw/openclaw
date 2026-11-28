import { For, Show } from "solid-js";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ProfileState } from "./profile-state.ts";

registerEnglishCatalog(registerProfileEnglish);

export type ProfileChannelIdentitiesProps = {
  getState: () => ProfileState;
  canManage: () => boolean;
};

export function ProfileChannelIdentities(props: ProfileChannelIdentitiesProps) {
  const state = () => props.getState();

  return (
    <openclaw-profile-channel-identities style={{ display: "contents" }}>
      <Show when={props.canManage()}>
        <form
          id="settings-profile-channel-identities"
          aria-busy={
            state().channelIdentityBusy || state().identityLoading || state().identityBusy !== null
              ? "true"
              : "false"
          }
          onSubmit={(event) => {
            event.preventDefault();
            void state().linkChannelIdentity();
          }}
        >
          <SettingsSection
            title={t("profilePage.channelIdentities.title")}
            description={t("profilePage.channelIdentities.description")}
          >
            <Show
              when={
                (state().channelIdentityLoading || state().identityLoading) &&
                state().channelIdentityLinks === null
              }
            >
              <SettingsLoadingSkeleton
                label={t("profilePage.channelIdentities.loading")}
                rows={1}
              />
            </Show>
            <Show when={state().channelIdentityError}>
              {(error) => (
                <SettingsRow
                  title={t("profilePage.channelIdentities.errorTitle")}
                  description={error()}
                  role="alert"
                  stackedOnNarrow
                  control={
                    state().channelIdentityLinks === null ? (
                      <button
                        type="button"
                        class="btn"
                        aria-label={t("profilePage.channelIdentities.retry")}
                        disabled={
                          state().channelIdentityLoading || state().channelIdentityMutation !== null
                        }
                        onClick={() => void state().loadChannelIdentityLinks()}
                      >
                        {t("profilePage.channelIdentities.retry")}
                      </button>
                    ) : undefined
                  }
                />
              )}
            </Show>
            <Show when={state().channelIdentityStatus}>
              {(status) => <SettingsRow title={status()} role="status" />}
            </Show>
            <Show when={state().channelIdentityLinks}>
              {(links) => (
                <For
                  each={links()}
                  fallback={<SettingsEmpty message={t("profilePage.channelIdentities.empty")} />}
                >
                  {(link) => (
                    <SettingsRow
                      title={<code>{link.identity.channelId}</code>}
                      description={
                        <>
                          {t("profilePage.channelIdentities.accountId")}:{" "}
                          <code>{link.identity.accountId}</code> ·{" "}
                          {t("profilePage.channelIdentities.senderId")}:{" "}
                          <code>{link.identity.senderId}</code>
                        </>
                      }
                      stackedOnNarrow
                      control={
                        <button
                          type="button"
                          class="btn"
                          aria-label={`${t("profilePage.channelIdentities.remove")} ${[
                            link.identity.channelId,
                            link.identity.accountId,
                            link.identity.senderId,
                          ].join(", ")}`}
                          disabled={state().channelIdentityFormDisabled}
                          onClick={() => void state().unlinkChannelIdentity(link)}
                        >
                          {state().isRemovingChannelIdentity(link)
                            ? t("profilePage.channelIdentities.removing")
                            : t("profilePage.channelIdentities.remove")}
                        </button>
                      }
                    />
                  )}
                </For>
              )}
            </Show>
            <For each={["channelId", "accountId", "senderId"] as const}>
              {(field) => (
                <SettingsRow
                  title={t(`profilePage.channelIdentities.${field}`)}
                  stacked
                  control={
                    <input
                      class="settings-input"
                      type="text"
                      aria-label={t(`profilePage.channelIdentities.${field}`)}
                      autocomplete="off"
                      maxlength="512"
                      pattern={"\\S(?:.*\\S)?"}
                      required
                      value={state()[field]}
                      disabled={state().channelIdentityFormDisabled}
                      onInput={(event) =>
                        state().setChannelIdentityDraft(field, event.currentTarget.value)
                      }
                    />
                  }
                />
              )}
            </For>
            <SettingsRow
              title={t("profilePage.channelIdentities.addTitle")}
              stackedOnNarrow
              control={
                <button type="submit" class="btn" disabled={state().channelIdentityFormDisabled}>
                  {state().channelIdentityMutation?.kind === "link"
                    ? t("profilePage.channelIdentities.linking")
                    : t("profilePage.channelIdentities.add")}
                </button>
              }
            />
          </SettingsSection>
        </form>
      </Show>
    </openclaw-profile-channel-identities>
  );
}
