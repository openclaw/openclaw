import { createMemo, For, Show } from "solid-js";
import { readMessageWorkContext } from "../../../../../src/chat/work-context.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

const fields = ["title", "page", "agentId", "workspace", "file", "selection"] as const;

export function MessageWorkContext(props: { message: unknown }) {
  const attached = createMemo(() => readMessageWorkContext(props.message));
  const snapshot = () => attached()!.snapshot;
  return (
    <Show when={attached()}>
      <details class="chat-context-attachment">
        <summary class="chat-context-attachment__summary">
          <span aria-hidden="true">
            <Icon name="layers" />
          </span>
          {t("chat.messages.attachedContext.label")}
          <span class="chat-context-attachment__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </summary>
        <div class="chat-context-attachment__body">
          <p>{t("chat.messages.attachedContext.captured")}</p>
          <dl>
            <For each={fields}>
              {(field) => (
                <Show when={snapshot()[field]}>
                  <dt>{t(`chat.messages.attachedContext.${field}`)}</dt>
                  <dd>{snapshot()[field]}</dd>
                </Show>
              )}
            </For>
          </dl>
          <details class="chat-context-attachment__technical">
            <summary>{t("chat.messages.attachedContext.technical")}</summary>
            <pre>{JSON.stringify(snapshot(), null, 2)}</pre>
          </details>
          <p>{t("chat.messages.attachedContext.reference")}</p>
        </div>
      </details>
    </Show>
  );
}
