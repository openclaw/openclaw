import { Errored, Loading, Repeat, Show, lazy, onSettled, useContext } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { chatPullRequestRows } from "./chat-pull-request-rows.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { hasChatPullRequests, showWorkRow } from "./chat-pull-requests.ts";

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
          onSettled(() => () => {
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
            <Show
              when={props.compact}
              fallback={
                <div class="chat-prs">
                  <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
                </div>
              }
            >
              <div class="chat-prs" role="status" aria-busy="true" aria-label={t("common.loading")}>
                <Repeat
                  count={
                    !props.publishedOnly && showWorkRow(props)
                      ? 1
                      : chatPullRequestRows(props).length
                  }
                >
                  {() => (
                    <div class="chat-pr chat-pr--compact chat-pr--summary" aria-hidden="true">
                      <span class="skeleton skeleton-line skeleton-line--long" />
                    </div>
                  )}
                </Repeat>
              </div>
            </Show>
          }
        >
          <Content {...props} />
        </Loading>
      </Errored>
    </Show>
  );
}
