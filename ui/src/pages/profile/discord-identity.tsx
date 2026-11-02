import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { onSettled, Show } from "solid-js";
import { Picker } from "../../components/select-picker.ts";
import { SettingsRow, SettingsStatus, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { DiscordIdentityState } from "./discord-identity-state.ts";

// The shared width of lone value controls in settings rows.
const PICKER_WIDTH = "width:340px;max-width:100%;min-width:0";

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
    <>
      <SettingsRow
        title={t("profilePage.discord.title")}
        description={t(
          unavailable() ? "profilePage.discord.unavailable" : "profilePage.discord.description",
        )}
        control={
          <>
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
                        <a
                          class="btn btn--sm"
                          href={flow().url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
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
      <Show when={view.read().accounts.length > 1}>
        <div class="settings-subrows">
          <SettingsRow
            title={t("profilePage.discord.gatewayAccount")}
            stackedOnNarrow
            control={
              <Picker
                style={PICKER_WIDTH}
                params={{
                  label: t("profilePage.discord.gatewayAccount"),
                  value: view.read().accountId,
                  options: view
                    .read()
                    .accounts.map(({ accountId }) => ({ value: accountId, label: accountId })),
                  disabled: view.read().busy || Boolean(view.read().flow),
                  onChange: (value) => {
                    state.accountId = value;
                    state.publish();
                  },
                }}
              />
            }
          />
        </div>
      </Show>
      <Show when={view.read().error}>
        {(error) => (
          <div class="settings-row identity-error" role="alert">
            <span class="settings-row__desc">{error()}</span>
            <div class="settings-row__control">
              <button class="btn btn--sm" onClick={() => void state.load()}>
                {t("common.retry")}
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
