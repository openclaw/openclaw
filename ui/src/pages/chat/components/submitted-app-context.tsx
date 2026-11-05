import "../../../styles/mcp-app-extensions.css";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show } from "solid-js";
import { readChatAppContext } from "../../../../../packages/gateway-protocol/src/chat-app-context.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerMcpAppEnglish } from "../../../i18n/locales/en-mcp-app.ts";
import { t } from "../../../lib/reactive/i18n.ts";

registerMcpAppEnglish();

export function SubmittedAppContext(props: { message: unknown }) {
  const items = () =>
    readChatAppContext(
      asNullableRecord(asNullableRecord(props.message)?.["__openclaw"])?.appContext,
    );
  return (
    <Show when={items()?.length}>
      <section
        class="mcp-app-context mcp-app-context--submitted"
        aria-label={t("mcpApp.contextTitle")}
      >
        <div class="mcp-app-context__items">
          <For each={items()}>
            {(item) => (
              <div class="mcp-app-context__item" title={item.description || item.uri || item.title}>
                <Show when={item.icon} fallback={<Icon name="fileText" />}>
                  {(src) => (
                    <img
                      class="mcp-app-context__icon"
                      src={src()}
                      alt=""
                      referrerpolicy="no-referrer"
                      loading="lazy"
                    />
                  )}
                </Show>
                <span class="mcp-app-context__label">{item.title}</span>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
