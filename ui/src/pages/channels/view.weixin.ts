import { html, nothing } from "lit";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerWeixinEnglish } from "../../i18n/locales/en-weixin.ts";
import { initialWeixinQrState } from "../../lib/channels/weixin-qr-state.ts";
import { isWeixinQrImage } from "../../lib/channels/weixin-qr.ts";
import { WEIXIN_CHANNEL_ICON } from "./plugin-presentation.ts";
import { resolveChannelDisplayState } from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

registerWeixinEnglish();

/** An installed personal-Weixin plugin has a QR entry even before its channel is enabled. */
export function renderWeixinLogin(props: ChannelsProps) {
  const plugin = props.presentation.pluginCatalog?.plugins.find(
    (entry) => entry.id === "openclaw-weixin",
  );
  const loaded =
    props.channels.channelsSnapshot?.channelOrder.includes("openclaw-weixin") ||
    props.channels.channelsSnapshot?.channelMeta?.some((entry) => entry.id === "openclaw-weixin");
  if (!plugin && !loaded) {
    return nothing;
  }
  const login = props.channels.weixinLogin ?? initialWeixinQrState();
  const busy = login.busy || props.weixinActivationBusy;
  const active = login.phase !== "idle";
  const displayState = resolveChannelDisplayState("openclaw-weixin", props);
  const configured = displayState.configured === true;
  const qr =
    isWeixinQrImage(login.qrDataUrl) && login.expiresAtMs !== null && login.expiresAtMs > Date.now()
      ? login.qrDataUrl
      : null;
  return html` <section class="weixin-login" aria-labelledby="weixin-login-title">
    <div class="weixin-login__heading">
      <div class="weixin-login__identity">
        ${renderChannelIcon("openclaw-weixin", t("channels.weixin.title"), "tile", {
          pluginIconUrl:
            props.presentation.pluginIconUrls?.["openclaw-weixin"] ?? WEIXIN_CHANNEL_ICON,
        })}
        <div>
          <h2 id="weixin-login-title">${t("channels.weixin.title")}</h2>
          <p class="muted">
            ${t(configured ? "channels.weixin.savedDescription" : "channels.weixin.description")}
          </p>
          ${
            !active && (configured || displayState.running === true)
              ? renderSettingsStatus({
                  kind: displayState.running === true ? "ok" : "muted",
                  label: t(
                    displayState.running === true
                      ? "channels.hub.stateRunning"
                      : "channels.hub.stateConfigured",
                  ),
                })
              : nothing
          }
        </div>
      </div>
      ${
        props.canAdmin && !active
          ? html`<button
              class="btn primary"
              type="button"
              ?disabled=${busy || props.weixinRestartRequired || !props.channels.connected || props.config.configFormDirty}
              @click=${props.onWeixinStart}
            >
              ${busy ? t("common.loading") : plugin?.enabled === false ? t("channels.weixin.enable") : configured ? t("channels.weixin.reconnect") : t("common.connect")}
            </button>`
          : nothing
      }
    </div>
    ${!props.canAdmin ? html`<div class="callout info">${t("channels.hub.adminRequired")}</div>` : nothing}
    ${props.config.configFormDirty ? html`<div class="callout warn">${t("channels.hub.saveBeforeSetup")}</div>` : nothing}
    ${props.weixinActivationMessage ? html`<div class="callout info" role="status">${props.weixinActivationMessage}</div>` : nothing}
    ${
      props.canAdmin && active
        ? html` <div class="weixin-login__body" aria-busy=${busy}>
            ${login.phase === "starting" ? html`<p role="status">${t("common.loading")}</p>` : nothing}
            ${
              qr
                ? html`<div class="channels-wizard__qr">
                      <img src=${qr} alt=${t("channels.weixin.qrAlt")} width="256" height="256" />
                    </div>
                    <p>${t("channels.weixin.scan")}</p>`
                : nothing
            }
            ${login.phase === "expired" ? html`<div class="callout warn" role="status">${t("channels.weixin.expired")}</div>` : nothing}
            ${login.phase === "connected" ? html`<div class="callout info" role="status">${t("channels.weixin.authenticated")}</div>` : nothing}
            ${login.message ? html`<div class=${login.phase === "error" ? "callout danger" : "callout info"} role="status">${login.message}</div>` : nothing}
            ${
              login.phase === "verification"
                ? html` <form
                    @submit=${(event: SubmitEvent) => {
                      event.preventDefault();
                      const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
                        "weixin-code",
                      ) as HTMLInputElement;
                      const code = input.value;
                      input.value = "";
                      props.onWeixinVerify(code);
                    }}
                  >
                    <label class="field"
                      ><span>${t("channels.weixin.verify")}</span>
                      <input
                        name="weixin-code"
                        type="password"
                        autocomplete="one-time-code"
                        required
                        maxlength="10"
                        inputmode="numeric"
                        pattern="[0-9]{1,10}"
                        ?disabled=${busy}
                    /></label>
                    <button class="btn primary" type="submit" ?disabled=${busy}>
                      ${t("common.confirm")}
                    </button>
                  </form>`
                : nothing
            }
            <div class="weixin-login__actions">
              <button class="btn" type="button" @click=${props.onWeixinClose}>
                ${t("common.close")}
              </button>
              ${login.phase === "error" || login.phase === "expired" ? html`<button class="btn primary" type="button" ?disabled=${busy} @click=${props.onWeixinStart}>${t("common.retry")}</button>` : nothing}
            </div>
          </div>`
        : nothing
    }
  </section>`;
}
