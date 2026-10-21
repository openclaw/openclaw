import { For, Show, createMemo, onSettled } from "solid-js";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ProfileChannelIdentitiesState } from "./profile-channel-identities-state.ts";

registerEnglishCatalog(registerProfileEnglish);

export type ProfileChannelIdentitiesProps = {
  identitiesState: ProfileChannelIdentitiesState;
  onPresentationDisposed: (identitiesState: ProfileChannelIdentitiesState) => void;
};

export function ProfileChannelIdentities(props: ProfileChannelIdentitiesProps) {
  const state = createMemo(() => props.identitiesState.state());
  onSettled(() => {
    const identitiesState = props.identitiesState;
    const onPresentationDisposed = props.onPresentationDisposed;
    return () => onPresentationDisposed(identitiesState);
  });

  return (
    <openclaw-profile-channel-identities style={{ display: "contents" }}>
      <Show when={state().canManageChannelIdentities}>
        <form
          id="settings-profile-channel-identities"
          aria-busy={state().busy ? "true" : "false"}
          onSubmit={(event) => {
            event.preventDefault();
            void props.identitiesState.linkIdentity();
          }}
        >
          <SettingsSection
            title={t("profilePage.channelIdentities.title")}
            description={t("profilePage.channelIdentities.description")}
          >
            <Show when={state().loading && state().links === null}>
              <SettingsLoadingSkeleton
                label={t("profilePage.channelIdentities.loading")}
                rows={1}
              />
            </Show>
            <Show when={state().error}>
              {(error) => (
                <SettingsRow
                  title={t("profilePage.channelIdentities.errorTitle")}
                  description={error()}
                  role="alert"
                  stackedOnNarrow
                  control={
                    state().links === null ? (
                      <button
                        type="button"
                        class="btn"
                        aria-label={t("profilePage.channelIdentities.retry")}
                        disabled={state().loading || state().mutation !== null}
                        onClick={() => void props.identitiesState.loadLinks()}
                      >
                        {t("profilePage.channelIdentities.retry")}
                      </button>
                    ) : undefined
                  }
                />
              )}
            </Show>
            <Show when={state().status}>
              {(status) => <SettingsRow title={status()} role="status" />}
            </Show>
            <Show when={state().links}>
              {(links) =>
                links().length === 0 ? (
                  <SettingsEmpty message={t("profilePage.channelIdentities.empty")} />
                ) : (
                  <For each={links()}>
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
                            disabled={state().busy}
                            onClick={() => void props.identitiesState.unlinkIdentity(link)}
                          >
                            {state().isRemoving(link)
                              ? t("profilePage.channelIdentities.removing")
                              : t("profilePage.channelIdentities.remove")}
                          </button>
                        }
                      />
                    )}
                  </For>
                )
              }
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
                      disabled={state().formDisabled}
                      onInput={(event) =>
                        props.identitiesState.setDraft(field, event.currentTarget.value)
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
                <button type="submit" class="btn" disabled={state().formDisabled}>
                  {state().mutation?.kind === "link"
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
