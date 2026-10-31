import { lazy, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { downloadImageBlob } from "../../../lib/image-download.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { copyImageToClipboard } from "./chat-image-clipboard.ts";

registerEnglishCatalog(registerChatMediaEnglish);

const ComparisonDialog = lazy(() => import("../../../components/image-comparison-dialog.tsx"), {
  export: "ImageComparison",
});

let nextMenuId = 0;

export function ChatImageActions(props: {
  disabled?: boolean;
  title: string;
  readOriginalBlob: () => Promise<Blob>;
  overlay?: boolean;
}) {
  const lifetime = new AbortController();
  onSettled(() => () => lifetime.abort());
  let comparing = false;
  const compare = async () => {
    if (comparing || lifetime.signal.aborted) {
      return;
    }
    comparing = true;
    const readOriginalBlob = props.readOriginalBlob;
    const title = props.title;
    try {
      const { showImageComparison } = await ComparisonDialog.preload();
      await showImageComparison(readOriginalBlob, title, lifetime.signal);
    } catch {
      if (!lifetime.signal.aborted) {
        showToast({ message: t("chat.imageLightbox.loadFailed"), severity: "error" });
      }
    } finally {
      comparing = false;
    }
  };
  const download = async () => {
    if (props.disabled) {
      return;
    }
    try {
      const blob = await props.readOriginalBlob();
      downloadImageBlob(blob, props.title);
    } catch {
      showToast({ message: t("chat.imageLightbox.downloadFailed") });
    }
  };
  const copy = async () => {
    if (props.disabled) {
      return;
    }
    try {
      await copyImageToClipboard(props.readOriginalBlob);
      showToast({ message: t("common.copied") });
    } catch {
      showToast({ message: t("chat.imageLightbox.copyFailed") });
    }
  };
  const id = `chat-image-actions-${++nextMenuId}`;
  return (
    <Show
      when={props.overlay}
      fallback={
        <Menu
          id={id}
          class="chat-image-actions"
          triggerClass="chat-image-action"
          placement="bottom-end"
          label={t("chat.imageLightbox.actions")}
          triggerAttributes={{
            title: t("chat.imageLightbox.actions"),
            "aria-disabled": props.disabled ? "true" : undefined,
          }}
          onBeforeShow={(event) => {
            if (props.disabled) {
              event.preventDefault();
            }
          }}
          trigger={<Icon name="moreHorizontal" />}
          items={[
            {
              id: "compare",
              label: t("chat.imageLightbox.compare"),
              class: "session-menu__item",
              icon: <Icon name="image" />,
            },
            {
              id: "copy",
              label: t("chat.imageLightbox.copy"),
              class: "session-menu__item",
              icon: (
                <span class="session-menu__icon">
                  <Icon name="copy" />
                </span>
              ),
              content: <span class="session-menu__text">{t("chat.imageLightbox.copy")}</span>,
            },
            {
              id: "download",
              label: t("chat.imageLightbox.download"),
              class: "session-menu__item",
              icon: (
                <span class="session-menu__icon">
                  <Icon name="download" />
                </span>
              ),
              content: <span class="session-menu__text">{t("chat.imageLightbox.download")}</span>,
            },
          ]}
          onSelect={(item) => {
            void (item.id === "copy" ? copy() : item.id === "compare" ? compare() : download());
          }}
        />
      }
    >
      <span class="chat-image-actions chat-image-actions--overlay">
        <button
          type="button"
          class="chat-image-action"
          title={t("chat.imageLightbox.download")}
          aria-label={t("chat.imageLightbox.download")}
          aria-disabled={props.disabled ? "true" : undefined}
          onClick={() => void download()}
        >
          <Icon name="download" />
        </button>
        <button
          type="button"
          class="chat-image-action"
          title={t("chat.imageLightbox.copy")}
          aria-label={t("chat.imageLightbox.copy")}
          aria-disabled={props.disabled ? "true" : undefined}
          onClick={() => void copy()}
        >
          <Icon name="copy" />
        </button>
      </span>
    </Show>
  );
}
