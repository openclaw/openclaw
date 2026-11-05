import { onSettled, Show, type Element } from "solid-js";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

export function ChatDetailsLoading(props: { onChange?: (loading: boolean) => void }) {
  onSettled(() => {
    props.onChange?.(true);
    return () => props.onChange?.(false);
  });
  return <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />;
}

/** Share the cold-only lazy handoff with mobile and desktop without a second body owner. */
export function createDetailsContentBoundary(opened: () => boolean, cached: () => boolean) {
  return function SessionContent(content: {
    children: Element;
    onLoading?: (loading: boolean) => void;
  }) {
    return (
      <Show when={opened()}>
        <ChatLazyBoundary
          fallback={!cached() && <ChatDetailsLoading onChange={content.onLoading} />}
        >
          {content.children}
        </ChatLazyBoundary>
      </Show>
    );
  };
}
