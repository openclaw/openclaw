import { createMemo, createSignal, Loading, Show } from "solid-js";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

/** Optional view of an already-published URL; never enables public sharing. */
export function ChatSessionPublicQr(props: { url: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <details
      class="public-share-qr"
      data-form-control=""
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("chat.sessionSharing.scanQr")}</summary>
      <Show when={open()}>
        <Loading
          fallback={
            <div class="public-share-qr__frame" role="status">
              {t("chat.sessionSharing.qrLoading")}
            </div>
          }
        >
          <PublicQrPreview url={props.url} />
        </Loading>
      </Show>
    </details>
  );
}

function PublicQrPreview(props: { url: string }) {
  const [standard, setStandard] = createSignal(false);
  const code = createMemo(async () => {
    try {
      const url = props.url;
      const { createPublicShareQr } = await import("../../../lib/public-share-qr.ts");
      return await createPublicShareQr(url);
    } catch {
      return undefined;
    }
  });
  return (
    <Show when={code()} fallback={<p role="status">{t("chat.sessionSharing.qrUnavailable")}</p>}>
      {(qr) => {
        const source = () => (!standard() && qr().halftone ? qr().halftone : qr().plain);
        return (
          <div class="public-share-qr__preview">
            <div class="public-share-qr__frame">
              <img src={source()} width="240" height="240" alt={t("chat.sessionSharing.qrAlt")} />
            </div>
            <Show
              when={qr().halftone}
              fallback={<p class="muted">{t("chat.sessionSharing.qrDenseFallback")}</p>}
            >
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => setStandard((value) => !value)}
              >
                {t(
                  standard()
                    ? "chat.sessionSharing.useHalftoneQr"
                    : "chat.sessionSharing.useStandardQr",
                )}
              </button>
            </Show>
            <a class="btn btn--sm" href={source()} download="openclaw-public-link-qr.png">
              {t("chat.sessionSharing.downloadQr")}
            </a>
            <p class="muted">{t("chat.sessionSharing.qrHint")}</p>
          </div>
        );
      }}
    </Show>
  );
}
