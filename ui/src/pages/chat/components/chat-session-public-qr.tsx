import { createMemo, createSignal, Loading, Show } from "solid-js";
import type { MenuControls } from "../../../components/solid/menu.tsx";
import { QrCode } from "../../../components/solid/qr-code.tsx";
import { registerChatPublicQrEnglish } from "../../../i18n/locales/en-chat-public-qr.ts";
import { createPublicShareQr } from "../../../lib/public-share-qr.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatPublicQrEnglish);

/** One lazy public-link presentation for the desktop menu and mobile sharing page. */
export function ChatSessionPublicQr(props: {
  url: string;
  compact?: boolean;
  controls?: MenuControls;
}) {
  // Changing the published link retires the user's artwork selection with it.
  const [artwork, setArtwork] = createSignal(() => {
    return !props.url;
  });
  return (
    <div
      class="chat-session-public-qr"
      style={{
        display: "grid",
        "justify-items": "center",
        gap: "8px",
        margin: "8px 12px 12px",
        "font-size": "12px",
        "text-align": "center",
        color: "var(--muted)",
      }}
    >
      <Show
        when={artwork()}
        fallback={
          <QrCode
            value={props.url}
            label={t("chat.publicQr.label")}
            size={props.compact ? "152px" : "min(232px, 100%)"}
          />
        }
      >
        <Loading fallback={<span role="status">{t("chat.publicQr.loading")}</span>}>
          <LobsterQr url={props.url} controls={props.controls} />
        </Loading>
      </Show>
      <button
        ref={[props.controls?.ref()]}
        type="button"
        data-form-control=""
        class="btn btn--sm"
        onClick={() => setArtwork((value) => !value)}
      >
        {t(artwork() ? "chat.publicQr.standard" : "chat.publicQr.lobster")}
      </button>
      <span>{t("chat.publicQr.scan")}</span>
    </div>
  );
}

function LobsterQr(props: { url: string; controls?: MenuControls }) {
  const code = createMemo(() => createPublicShareQr(props.url));
  return (
    <Show
      when={code()}
      fallback={
        <>
          <QrCode value={props.url} label={t("chat.publicQr.label")} size="232px" />
          <span role="status">{t("chat.publicQr.unavailable")}</span>
        </>
      }
    >
      {(qr) => (
        <>
          <img
            src={qr().halftone}
            alt={t("chat.publicQr.lobsterLabel")}
            width={240}
            height={240}
            style={{
              display: "block",
              width: "240px",
              "max-width": "100%",
              height: "auto",
              "image-rendering": "pixelated",
            }}
          />
          <a
            ref={[props.controls?.ref()]}
            data-form-control=""
            class="btn btn--sm"
            href={qr().halftone}
            download="openclaw-public-link-qr.png"
          >
            {t("chat.publicQr.download")}
          </a>
        </>
      )}
    </Show>
  );
}
