import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { createMemo } from "solid-js";
import type { WhatsAppStatus } from "../../api/types.ts";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { i18n } from "../../i18n/index.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import { ChannelConfig } from "./view.config.tsx";
import {
  booleanChannelFact,
  resolveChannelAccountCount,
  ChannelActions,
  ChannelError,
  ChannelFacts,
  resolveChannelDisplayState,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

export function WhatsAppCard(props: ChannelsProps) {
  const whatsapp = createMemo(() => {
    // SAFETY: The bundled WhatsApp plugin owns the channels.whatsapp status payload.
    return props.channels.channelsSnapshot?.channels.whatsapp as WhatsAppStatus | undefined;
  });
  const locale = projectI18n(i18n);
  const configured = createMemo(() => resolveChannelDisplayState("whatsapp", props).configured);
  const linked = createMemo(() => whatsapp()?.linked === true);
  const hasQr = createMemo(() => props.channels.whatsappLoginQrDataUrl != null);
  const rawPhoneNumber = createMemo(() => whatsapp()?.self?.e164);
  const phoneNumber = createMemo(() =>
    rawPhoneNumber()
      ? (formatInternationalPhoneNumberForDisplay(rawPhoneNumber() ?? "", locale.locale()) ??
        rawPhoneNumber())
      : undefined,
  );

  const facts = createMemo(() => {
    const state = whatsapp();
    return [
      booleanChannelFact("configured", configured()),
      booleanChannelFact("linked", state?.linked === true),
      ...(phoneNumber()
        ? [
            {
              label: t("channels.whatsapp.phoneNumber"),
              value: phoneNumber(),
            },
          ]
        : []),
      booleanChannelFact("running", state?.running === true),
      booleanChannelFact("connected", state?.connected === true),
      ...(
        [
          ["lastConnect", "lastConnectedAt"],
          ["lastMessage", "lastMessageAt"],
        ] as const
      ).map(([label, field]) => ({
        label: t(`common.${label}`),
        value: state?.[field] ? formatRelativeTimestamp(state?.[field]) : t("common.na"),
      })),
      {
        label: t("common.authAge"),
        value: state?.authAgeMs != null ? formatDurationHuman(state.authAgeMs) : t("common.na"),
      },
    ];
  });

  return (
    <SettingsSection
      title={t("channels.whatsapp.title")}
      description={t("channels.whatsapp.subtitle")}
      count={resolveChannelAccountCount(
        "whatsapp",
        props.channels.channelsSnapshot?.channelAccounts,
      )}
    >
      <ChannelFacts rows={facts()} />
      {whatsapp()?.lastError ? <ChannelError message={whatsapp()?.lastError} /> : undefined}
      <ChannelConfig channelId={"whatsapp"} props={props} />
      {props.channels.whatsappLoginMessage ? (
        <div class="settings-row" role="status">
          <div class="settings-row__text">
            <span class="settings-row__desc">{props.channels.whatsappLoginMessage}</span>
          </div>
        </div>
      ) : undefined}
      {props.channels.whatsappLoginQrDataUrl ? (
        <div class="settings-row settings-row--stacked">
          <div class="qr-wrap">
            <img
              src={props.channels.whatsappLoginQrDataUrl}
              alt={t("channels.setup.whatsappQrAlt")}
            />
          </div>
        </div>
      ) : undefined}
      <ChannelActions>
        <button
          class={linked() ? "btn" : "btn primary"}
          disabled={props.channels.whatsappBusy}
          onClick={() => props.onWhatsAppStart(linked())}
        >
          {t(
            linked()
              ? "common.relink"
              : props.channels.whatsappBusy
                ? "common.working"
                : "common.showQr",
          )}
        </button>
        {hasQr() ? (
          <button
            class="btn"
            disabled={props.channels.whatsappBusy}
            onClick={() => props.onWhatsAppWait()}
          >
            {t("common.waitForScan")}
          </button>
        ) : undefined}
        <button
          class="btn danger"
          disabled={props.channels.whatsappBusy}
          onClick={() => props.onWhatsAppLogout()}
        >
          {t("common.logout")}
        </button>
        <button class="btn" onClick={() => props.onRefresh(true)}>
          {t("common.refresh")}
        </button>
      </ChannelActions>
    </SettingsSection>
  );
}
