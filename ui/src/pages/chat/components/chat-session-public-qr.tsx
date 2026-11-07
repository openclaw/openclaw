import { QrCode } from "../../../components/solid/qr-code.tsx";
import { registerChatPublicQrEnglish } from "../../../i18n/locales/en-chat-public-qr.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatPublicQrEnglish);

/**
 * Scannable twin of the copy action: encodes exactly the public URL it is given.
 * Sharing views load this lazily so the encoder stays off chat boot; layout is inline
 * so the chunk carries its own presentation instead of growing shared stylesheets.
 */
export function ChatSessionPublicQr(props: { url: string; compact?: boolean }) {
  return (
    <div
      class="chat-session-public-qr"
      style={{
        display: "flex",
        "flex-direction": props.compact ? "row" : "column",
        "align-items": "center",
        gap: props.compact ? "12px" : "8px",
        margin: props.compact ? "8px 8px 2px 36px" : "0 12px 12px",
        color: "var(--muted)",
        "font-size": props.compact ? "11px" : "13px",
        "text-align": props.compact ? "start" : "center",
      }}
    >
      <QrCode
        value={props.url}
        label={t("chat.publicQr.label")}
        size={props.compact ? "152px" : "min(232px, 100%)"}
      />
      <span>{t("chat.publicQr.scan")}</span>
    </div>
  );
}
