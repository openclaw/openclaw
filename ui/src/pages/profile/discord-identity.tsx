import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { For, onSettled, Show } from "solid-js";
import { SettingsRow, SettingsStatus, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { DiscordIdentityState } from "./discord-identity-state.ts";

export function DiscordIdentity() {
  const context = useApplication();
  const { owner: state, view } = projectCallbackOwner(
    (publish) => new DiscordIdentityState(publish),
    (owner) => owner,
  );
  const unavailable = () =>
    !view.read().loading &&
    !view.read().selected?.available &&
    !view.read().selected?.senderIds.length &&
    !view.read().error;
  onSettled(() => {
    const stop = context.gateway.subscribe((snapshot) => state.sync(snapshot));
    const stopEvents = context.gateway.subscribeEvents((event) => {
      if (
        event.event === "sessions.changed" &&
        asOptionalRecord(event.payload)?.reason === "profile-identity" &&
        !state.busy &&
        !state.flow
      ) {
        void state.load();
      }
    });
    state.sync(context.gateway.snapshot);
    return () => {
      stop();
      stopEvents();
      state.dispose();
    };
  });
  return (
    <SettingsRow
      title={t("profilePage.discord.title")}
      description={
        <>
          <span>{t("profilePage.discord.description")}</span>
          <Show when={view.read().error}>
            {(error) => (
              <div class="callout danger" role="alert">
                {error()}{" "}
                <button class="btn btn--sm" onClick={() => void state.load()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
          </Show>
          {/* Keep the availability hint's space while its first reply is pending. */}
          <span
            class="profile-discord-availability"
            style={{ visibility: unavailable() ? "visible" : "hidden" }}
            aria-hidden={unavailable() ? "false" : "true"}
          >
            {t("profilePage.discord.unavailable")}
          </span>
        </>
      }
      control={
        <>
          <Show when={view.read().accounts.length > 1}>
            <select
              aria-label={t("profilePage.discord.gatewayAccount")}
              value={view.read().accountId}
              disabled={view.read().busy || Boolean(view.read().flow)}
              onChange={(event) => {
                state.accountId = event.currentTarget.value;
                state.publish();
              }}
            >
              <For each={view.read().accounts}>
                {(account) => <option value={account.accountId}>{account.accountId}</option>}
              </For>
            </select>
          </Show>
          <Show
            when={!view.read().loading}
            fallback={
              <button class="btn btn--sm" disabled aria-busy="true">
                {t("profilePage.discord.connect")}
              </button>
            }
          >
            <Show
              when={view.read().selected?.senderIds.length}
              fallback={
                <Show
                  when={view.read().flow}
                  fallback={
                    <button
                      class="btn btn--sm"
                      disabled={
                        !view.read().available ||
                        !view.read().selected?.available ||
                        view.read().busy
                      }
                      onClick={() => void state.connect()}
                    >
                      {t("profilePage.discord.connect")}
                    </button>
                  }
                >
                  {(flow) => (
                    <>
                      <SettingsStatus kind="muted" label={t("profilePage.discord.waiting")} />
                      <a href={flow().url} target="_blank" rel="noopener noreferrer">
                        {t("profilePage.discord.continue")}
                      </a>
                      <button
                        class="btn btn--sm"
                        disabled={view.read().busy}
                        onClick={() => void state.mutate("cancel")}
                      >
                        {t("common.cancel")}
                      </button>
                    </>
                  )}
                </Show>
              }
            >
              <SettingsValue value={view.read().selected?.senderIds.join(", ") ?? ""} />
              <SettingsStatus kind="ok" label={t("profilePage.discord.verified")} />
              <button
                class="btn btn--sm"
                disabled={!view.read().available || view.read().busy}
                onClick={() => void state.mutate("disconnect")}
              >
                {t("profilePage.discord.disconnect")}
              </button>
            </Show>
          </Show>
        </>
      }
    />
  );
}
