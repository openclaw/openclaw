import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

/** Copies the author's own text from a queued input that access loss cancelled. */
export function ChatQueueCopyAction(props: { onCopy: () => void }) {
  return (
    <button
      type="button"
      class="chat-queue__action"
      aria-label={t("common.copy")}
      onClick={() => props.onCopy()}
    >
      <Icon name="copy" />
    </button>
  );
}
