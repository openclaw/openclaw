import { createMemo } from "solid-js";
import { t } from "../../i18n/index.ts";
import { ChatModelControls } from "./components/chat-model-controls.tsx";
import type { ChatComposerSnapshot } from "./session-message-cache.ts";

export function ChatPaneModelControl(props: {
  model: Parameters<typeof ChatModelControls>[0] & { snapshot?: ChatComposerSnapshot };
}) {
  const snapshot = createMemo(() => props.model.snapshot);
  const sessionKey = createMemo(() => props.model.sessionKey);
  // Unrelated pane frames must not manufacture a new offline catalog and selection.
  const savedModel = createMemo(() => {
    const saved = snapshot();
    return saved
      ? {
          catalog: [saved],
          catalogState: { hasSnapshot: true, status: "offline" } as const,
          thinkingSession: { ...saved, model: saved.id, modelProvider: saved.provider },
          session: {
            key: sessionKey(),
            kind: "direct" as const,
            updatedAt: 0,
            model: saved.id,
            modelProvider: saved.provider,
            modelOverrideSource: "user" as const,
          },
        }
      : undefined;
  });
  return (
    <div
      class="chat-composer-model-control"
      data-composer-catalog-state={props.model.snapshot ? "stale" : undefined}
      title={props.model.snapshot ? t("chat.modelControls.refreshingModels") : undefined}
    >
      <ChatModelControls
        {...props.model}
        connected={props.model.snapshot ? false : props.model.connected}
        modelCatalog={savedModel()?.catalog ?? props.model.modelCatalog}
        modelCatalogState={savedModel()?.catalogState ?? props.model.modelCatalogState}
        thinkingSession={savedModel()?.thinkingSession ?? props.model.thinkingSession}
        fastModeDisplay={snapshot()?.speed}
        selectedSession={savedModel()?.session ?? props.model.selectedSession}
      />
    </div>
  );
}
