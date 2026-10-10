import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { createMemo } from "solid-js";
import type { WhatsAppStatus } from "../../api/types.ts";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { i18n } from "../../i18n/index.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import { renderChannelConfigSection } from "./view.config.tsx";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelActionRow,
  renderChannelErrorRow,
  renderChannelFacts,
  resolveChannelDisplayState,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCount?: number;
}) {
  const locale = projectI18n(i18n);
  const configured = createMemo(
    () => resolveChannelDisplayState("whatsapp", params.props).configured,
  );
  const linked = createMemo(() => params.whatsapp?.linked === true);
  const hasQr = createMemo(() => params.props.channels.whatsappLoginQrDataUrl != null);
  const rawPhoneNumber = createMemo(() => params.whatsapp?.self?.e164);
  const phoneNumber = createMemo(() =>
    rawPhoneNumber()
      ? (formatInternationalPhoneNumberForDisplay(rawPhoneNumber() ?? "", locale.locale()) ??
        rawPhoneNumber())
      : undefined,
  );
  const booleanFact = (field: "linked" | "running" | "connected") => ({
    label: t(`common.${field}`),
    value: params.whatsapp?.[field] ? t("common.yes") : t("common.no"),
    kind: boolStatusKind(params.whatsapp?.[field]),
  });

  return (
    <SettingsSection
      {...{
        title: t("channels.whatsapp.title"),
        description: t("channels.whatsapp.subtitle"),
        count: params.accountCount,
      }}
    >
      {
        <>
          {renderChannelFacts([
            {
              label: t("common.configured"),
              value: formatNullableBoolean(configured()),
              kind: boolStatusKind(configured()),
            },
            booleanFact("linked"),
            ...(phoneNumber()
              ? [
                  {
                    label: t("channels.whatsapp.phoneNumber"),
                    value: phoneNumber(),
                  },
                ]
              : []),
            booleanFact("running"),
            booleanFact("connected"),
            ...(
              [
                ["lastConnect", "lastConnectedAt"],
                ["lastMessage", "lastMessageAt"],
              ] as const
            ).map(([label, field]) => ({
              label: t(`common.${label}`),
              value: params.whatsapp?.[field]
                ? formatRelativeTimestamp(params.whatsapp[field])
                : t("common.na"),
            })),
            {
              label: t("common.authAge"),
              value:
                params.whatsapp?.authAgeMs != null
                  ? formatDurationHuman(params.whatsapp.authAgeMs)
                  : t("common.na"),
            },
          ])}
          {params.whatsapp?.lastError
            ? renderChannelErrorRow(params.whatsapp.lastError)
            : undefined}
          {renderChannelConfigSection({ channelId: "whatsapp", props: params.props })}
          {params.props.channels.whatsappLoginMessage ? (
            <div class="settings-row" role="status">
              <div class="settings-row__text">
                <span class="settings-row__desc">{params.props.channels.whatsappLoginMessage}</span>
              </div>
            </div>
          ) : undefined}
          {params.props.channels.whatsappLoginQrDataUrl ? (
            <div class="settings-row settings-row--stacked">
              <div class="qr-wrap">
                <img
                  src={params.props.channels.whatsappLoginQrDataUrl}
                  alt={t("channels.setup.whatsappQrAlt")}
                />
              </div>
            </div>
          ) : undefined}
          {renderChannelActionRow(
            <>
              <button
                class={linked() ? "btn" : "btn primary"}
                disabled={params.props.channels.whatsappBusy}
                onClick={() => params.props.onWhatsAppStart(linked())}
              >
                {t(
                  linked()
                    ? "common.relink"
                    : params.props.channels.whatsappBusy
                      ? "common.working"
                      : "common.showQr",
                )}
              </button>
              {hasQr() ? (
                <button
                  class="btn"
                  disabled={params.props.channels.whatsappBusy}
                  onClick={() => params.props.onWhatsAppWait()}
                >
                  {t("common.waitForScan")}
                </button>
              ) : undefined}
              <button
                class="btn danger"
                disabled={params.props.channels.whatsappBusy}
                onClick={() => params.props.onWhatsAppLogout()}
              >
                {t("common.logout")}
              </button>
              <button class="btn" onClick={() => params.props.onRefresh(true)}>
                {t("common.refresh")}
              </button>
            </>,
          )}
        </>
      }
    </SettingsSection>
  );
}
