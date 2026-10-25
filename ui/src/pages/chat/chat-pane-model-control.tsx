import { Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { ChatComposerSnapshot } from "./chat-composer-snapshot.ts";
import { ChatModelControls } from "./components/chat-model-controls.tsx";

export function ChatPaneModelControl(props: {
  model: Parameters<typeof ChatModelControls>[0] & { snapshot?: ChatComposerSnapshot };
}) {
  return (
    <div
      class="chat-composer-model-control"
      data-composer-catalog-state={props.model.snapshot ? "stale" : undefined}
      title={props.model.snapshot ? t("chat.modelControls.refreshingModels") : undefined}
    >
      <Show when={props.model.snapshot} fallback={<ChatModelControls {...props.model} />}>
        {(snapshot) => (
          <ChatModelControls
            {...props.model}
            connected={false}
            modelCatalog={[snapshot()]}
            modelCatalogState={{ hasSnapshot: true, status: "offline" }}
            selectedSession={{
              key: props.model.sessionKey,
              kind: "direct",
              updatedAt: 0,
              model: snapshot().id,
              modelProvider: snapshot().provider,
              modelOverrideSource: "user",
            }}
          />
        )}
      </Show>
    </div>
  );
}
