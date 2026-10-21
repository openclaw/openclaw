import { Errored, Loading, Show, lazy, onCleanup, useContext } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { hasChatPullRequests } from "./chat-pull-requests.ts";

export type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";

export function ChatPullRequests(props: ChatPullRequestsProps) {
  const parentPresented = useContext(ContentPresentation);
  const Content = lazy(() => import("./chat-pull-requests-content.tsx"), {
    export: "ChatPullRequestsContent",
  });
  return (
    <Show when={hasChatPullRequests(props)}>
      <Errored
        fallback={(error, reset) => {
          let active = true;
          onCleanup(() => {
            active = false;
          });
          const retry = () => {
            if (!active) {
              return;
            }
            const failure = error();
            if (!isStaleChunkImportError(failure)) {
              reset();
              return;
            }
            const sessionKey = props.sessionKey;
            const sessionId = props.sessionId;
            const gateway = props.gateway;
            void retryStaleChunkReloadWhenReachable({
              canReload: () => {
                const presented = props.presented;
                return (
                  active &&
                  error() === failure &&
                  props.sessionKey === sessionKey &&
                  props.sessionId === sessionId &&
                  props.gateway === gateway &&
                  hasChatPullRequests(props) &&
                  !props.dismissed &&
                  parentPresented() &&
                  (typeof presented === "object" ? presented.isPresented() : (presented ?? true))
                );
              },
            });
          };
          return (
            <LazyViewError
              error={error()}
              stale={isStaleChunkImportError(error())}
              onRetry={retry}
              inline
            />
          );
        }}
      >
        <Loading
          fallback={
            <div class="chat-prs">
              <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
            </div>
          }
        >
          <Content {...props} />
        </Loading>
      </Errored>
    </Show>
  );
}
