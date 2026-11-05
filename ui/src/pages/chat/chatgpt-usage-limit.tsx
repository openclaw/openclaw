import { action, createOptimistic, createSignal, Show } from "solid-js";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { registerChatSessionOptionalEnglish } from "../../i18n/locales/en-chat-session-optional.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import "./chatgpt-usage-limit.css";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

/** Presentation for one failed run; the parent keys its lifetime by session and run. */
export function ChatGPTUsageLimit(props: { presented: boolean; kind: "business" | "consumer" }) {
  const [open, setOpen] = createSignal(true);
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle");
  const [copying, setCopying] = createOptimistic(false);
  const body = () =>
    t(props.kind === "business" ? "chat.usageLimit.businessBody" : "chat.usageLimit.consumerBody");
  const copy = action(function* () {
    setCopying(true);
    const copied: boolean = yield copyToClipboard(t("chat.usageLimit.request"));
    setCopyState(copied ? "copied" : "failed");
  });
  return (
    <>
      <div class="chat-composer-neighbor-card chat-composer-neighbor-card--warn" role="status">
        <div class="chat-composer-neighbor-card__copy">
          <strong>{t("chat.usageLimit.title")}</strong>
          <span>{body()}</span>
        </div>
        <button class="btn btn--sm" type="button" onClick={() => setOpen(true)}>
          {t("chat.details")}
        </button>
      </div>
      <ModalDialog
        class="chatgpt-usage-limit-modal"
        open={props.presented && open()}
        label={t("chat.usageLimit.title")}
        description={body()}
        onOpenChange={(value) => {
          if (!value && props.presented) {
            setOpen(false);
          }
        }}
      >
        <div class="chatgpt-usage-limit">
          <button
            class="btn btn--icon chatgpt-usage-limit__close"
            type="button"
            aria-label={t("common.close")}
            onClick={() => setOpen(false)}
          >
            <Icon name="x" />
          </button>
          <ProviderBrandIcon provider="openai" class="chatgpt-usage-limit__logo" />
          <h2>{t("chat.usageLimit.title")}</h2>
          <p>{body()}</p>
          <Show when={!copying() && copyState() === "copied"}>
            <p role="status">{t("chat.usageLimit.copied")}</p>
          </Show>
          <Show when={!copying() && copyState() === "failed"}>
            <p role="alert">{t("chat.usageLimit.copyFailed")}</p>
            <blockquote>{t("chat.usageLimit.request")}</blockquote>
          </Show>
          <openclaw-modal-actions>
            <Show
              when={props.kind === "business"}
              fallback={
                <a
                  class="btn primary chatgpt-usage-limit__action"
                  href="https://chatgpt.com/settings/usage"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("chat.usageLimit.manage")}
                  <Icon name="externalLink" />
                </a>
              }
            >
              <button
                class="btn primary chatgpt-usage-limit__action"
                type="button"
                disabled={copying()}
                onClick={() => void copy()}
              >
                {t("chat.usageLimit.copy")}
              </button>
            </Show>
          </openclaw-modal-actions>
        </div>
      </ModalDialog>
    </>
  );
}
