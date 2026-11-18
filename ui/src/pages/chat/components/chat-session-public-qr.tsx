import { createMemo, createSignal, Loading, Show } from "solid-js";
import { QrCode } from "../../../components/solid/qr-code.tsx";
import { registerChatPublicQrEnglish } from "../../../i18n/locales/en-chat-public-qr.ts";
import { createPublicShareQr } from "../../../lib/public-share-qr.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";

registerEnglishCatalog(registerChatPublicQrEnglish);

// The decorated symbol can lose scan reliability when downscaled on narrow surfaces.
const CLAW_QR_SIZE = 240;

/** One lazy public-link presentation for the desktop menu and mobile sharing page. */
export function ChatSessionPublicQr(props: { url: string }) {
  let slot: HTMLDivElement | undefined;
  const [fitsClaw, setFitsClaw] = createSignal(false);
  createResizeObserver(
    () => (slot ? [slot] : []),
    ([entry]) => setFitsClaw((entry?.contentRect.width ?? 0) >= CLAW_QR_SIZE),
  );
  const code = createMemo(() => (fitsClaw() ? createPublicShareQr(props.url) : undefined));
  const plain = () => <QrCode value={props.url} label={t("chat.publicQr.label")} size="100%" />;
  return (
    <div
      class="chat-session-public-qr"
      style={{
        display: "grid",
        "grid-template-columns": "minmax(0, 1fr)",
        "justify-items": "center",
        gap: "8px",
        margin: "8px 12px 12px",
        "font-size": "12px",
        "text-align": "center",
        color: "var(--muted)",
      }}
    >
      <div
        ref={(element) => {
          slot = element;
        }}
        style={{ width: `min(${CLAW_QR_SIZE}px, 100%)`, "aspect-ratio": "1" }}
      >
        <Loading on={props.url} fallback={plain()}>
          <Show when={code()} fallback={plain()}>
            {(qr) => (
              <img
                src={qr().halftone}
                alt={t("chat.publicQr.clawLabel")}
                width={CLAW_QR_SIZE}
                height={CLAW_QR_SIZE}
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                  "image-rendering": "pixelated",
                }}
              />
            )}
          </Show>
        </Loading>
      </div>
      <span>{t("chat.publicQr.scan")}</span>
    </div>
  );
}
