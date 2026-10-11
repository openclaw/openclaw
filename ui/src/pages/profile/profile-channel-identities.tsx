import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import {
  ProfileChannelIdentitiesController,
  type ProfileChannelIdentityBusyState,
  type ProfileChannelIdentityInputs,
} from "./profile-channel-identities-controller.ts";

registerEnglishCatalog(registerProfileEnglish);

const ChannelIdentities = defineSolidBridge<ProfileChannelIdentityInputs>(
  "openclaw-profile-channel-identities",
  (props, host) => {
    const application = useApplication();
    const [revision, setRevision] = createSignal(0);
    const controller = new ProfileChannelIdentitiesController(() =>
      setRevision((value) => value + 1),
    );
    const readInputs = (): ProfileChannelIdentityInputs => ({
      profileId: props.profileId,
      visible: props.visible,
      profileReady: props.profileReady,
      identityBusy: props.identityBusy,
      identityGeneration: props.identityGeneration,
      targetGeneration: props.targetGeneration,
      generations: props.generations,
    });
    const unsubscribe = application.gateway.subscribe((snapshot) =>
      controller.update(readInputs(), snapshot),
    );
    createEffect(readInputs, (inputs) => controller.update(inputs, application.gateway.snapshot));
    onCleanup(() => {
      unsubscribe();
      controller.dispose();
    });
    host.style.display = "contents";

    let lastReportedBusy: string | null = null;
    createEffect(
      () => {
        revision();
        return controller.busyState;
      },
      (busyState) => {
        const key = `${busyState.loading}:${busyState.mutation}`;
        if (key === lastReportedBusy) {
          return;
        }
        lastReportedBusy = key;
        host.dispatchEvent(
          new CustomEvent<ProfileChannelIdentityBusyState>(
            "profile-channel-identities-busy-changed",
            {
              detail: busyState,
              bubbles: true,
              composed: true,
            },
          ),
        );
      },
    );

    const state = () => {
      revision();
      return controller;
    };

    return (
      <Show when={state().canManageChannelIdentities}>
        <form
          id="settings-profile-channel-identities"
          aria-busy={state().busy ? "true" : "false"}
          onSubmit={(event) => {
            event.preventDefault();
            void controller.linkIdentity();
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
                        onClick={() => void controller.loadLinks()}
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
                            onClick={() => void controller.unlinkIdentity(link)}
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
                      onInput={(event) => controller.setDraft(field, event.currentTarget.value)}
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
    );
  },
  {
    properties: {
      profileId: { default: null, attribute: false },
      visible: { default: false, attribute: false },
      profileReady: { default: false, attribute: false },
      identityBusy: { default: false, attribute: false },
      identityGeneration: { default: 0, attribute: false },
      targetGeneration: { default: 0, attribute: false },
      generations: { default: null, attribute: false },
    },
  },
);

export default ChannelIdentities;
