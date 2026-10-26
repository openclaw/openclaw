import { t } from "../../i18n/index.ts";
import { ChatModelControls } from "./components/chat-model-controls.tsx";
import type { ChatComposerSnapshot } from "./session-message-cache.ts";

export function ChatPaneModelControl(props: {
  model: Parameters<typeof ChatModelControls>[0] & { snapshot?: ChatComposerSnapshot };
}) {
  const savedSession = () =>
    props.model.snapshot
      ? {
          ...props.model.snapshot,
          model: props.model.snapshot.id,
          modelProvider: props.model.snapshot.provider,
        }
      : undefined;
  return (
    <div
      class="chat-composer-model-control"
      data-composer-catalog-state={props.model.snapshot ? "stale" : undefined}
      title={props.model.snapshot ? t("chat.modelControls.refreshingModels") : undefined}
    >
      <ChatModelControls
        {...props.model}
        connected={props.model.snapshot ? false : props.model.connected}
        modelCatalog={props.model.snapshot ? [props.model.snapshot] : props.model.modelCatalog}
        modelCatalogState={
          props.model.snapshot
            ? { hasSnapshot: true, status: "offline" }
            : props.model.modelCatalogState
        }
        thinkingSession={savedSession() ?? props.model.thinkingSession}
        fastModeDisplay={props.model.snapshot?.speed}
        selectedSession={
          props.model.snapshot
            ? {
                key: props.model.sessionKey,
                kind: "direct",
                updatedAt: 0,
                model: props.model.snapshot.id,
                modelProvider: props.model.snapshot.provider,
                modelOverrideSource: "user",
              }
            : props.model.selectedSession
        }
      />
    </div>
  );
}
