import type { JSX } from "@solidjs/web";
import { lazy, Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { SessionGitDiff } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatDetailsEnvironmentDesktopProps } from "./chat-details-types.ts";
import { EnvironmentAction, EnvironmentChangeCounts } from "./chat-environment-content.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ChatPanePlacement, type ChatPanePlacementProps } from "./chat-pane-placement.tsx";

const ChatBranchActions = lazy(() => import("./chat-branch-actions.tsx"), {
  export: "ChatBranchActions",
});

type Props = ChatDetailsEnvironmentDesktopProps & {
  placement: ChatPanePlacementProps;
  expanded: boolean;
  machineMenu: boolean | undefined;
  host: string | undefined;
  branchName: string | undefined;
  diff: SessionsDiffResult | NonNullable<ChatDetailsEnvironmentDesktopProps["work"]>["branch"];
  changes: SessionsDiffResult | undefined;
  fallbackWork: ChatDetailsEnvironmentDesktopProps["work"];
  renderMachineIcon: () => JSX.Element;
};

/** The eager wrapper retains reads, section chrome, and first-arrival motion. */
export function ChatDetailsEnvironmentBody(props: Props) {
  return (
    <>
      <Show
        when={props.machineMenu && props.presented}
        fallback={
          <Show when={props.host}>
            <div class="chat-details__row chat-environment__row">
              <EnvironmentAction presented={props.presented} onOpen={props.onOpenMachine}>
                {() => (
                  <>
                    {props.renderMachineIcon()}
                    <span ref={createTextOverflow(() => props.host)} title={props.host}>
                      {props.host}
                    </span>
                  </>
                )}
              </EnvironmentAction>
            </div>
          </Show>
        }
      >
        <div class="chat-environment__machine">
          <ChatPanePlacement
            {...props.placement}
            trigger={{
              class: "chat-details__row chat-environment__machine-trigger",
              label: (view) => (props.host ? `${props.host} · ${view.label}` : view.label),
              content: (view) => (
                <>
                  {props.renderMachineIcon()}
                  <span
                    ref={createTextOverflow(() => props.host ?? view.label)}
                    title={props.host ?? view.label}
                  >
                    {props.host ?? view.label}
                  </span>
                  <Icon name="moreHorizontal" />
                </>
              ),
            }}
          />
        </div>
      </Show>
      <Show when={props.branchName || props.work}>
        <div class="chat-environment__branch">
          <div class="chat-details__row chat-environment__row" title={props.branchName}>
            <Icon name={props.branchName ? "gitBranch" : "gitPullRequest"} />
            <span
              ref={createTextOverflow(() => props.branchName)}
              class="chat-environment__branch-name"
            >
              {props.branchName ?? t("chat.pullRequests.publishPr")}
            </span>
            <Show when={props.details.selectedSession?.worktree}>
              <small class="chat-details__badge">{t("chat.sessionDetails.worktree")}</small>
            </Show>
          </div>
          <Show when={props.diff || props.work}>
            <div class="chat-environment__branch-controls">
              <Show when={props.diff}>
                {(value) => (
                  <SessionGitDiff
                    classPrefix="chat-pr"
                    item={value()}
                    onOpen={
                      props.work?.branch ? props.work?.onOpenSessionDiff : props.onOpenUncommitted
                    }
                  />
                )}
              </Show>
              <Show when={props.work}>
                {(value) => (
                  <ChatLazyBoundary>
                    <ChatBranchActions
                      branch={value().branch}
                      branchName={props.branchName ?? t("chat.pullRequests.publishPr")}
                      status={value().status}
                      publication={value().publication}
                      presented={props.presented && props.expanded}
                      onDismiss={value().onDismissBranch}
                    />
                  </ChatLazyBoundary>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.details.selectedSession?.worktree && !props.branchName}>
        <div class="chat-details__row chat-environment__row chat-environment__worktree">
          <Icon name="folder" />
          <span>{t("chat.sessionDetails.worktree")}</span>
        </div>
      </Show>
      <Show when={!props.branchName && !props.work && props.changes}>
        <div class="chat-details__row chat-environment__row">
          <EnvironmentAction
            presented={props.presented}
            onOpen={props.onOpenUncommitted ?? props.fallbackWork?.onOpenSessionDiff}
          >
            {() => (
              <>
                <Icon name="diff" />
                <span>{t("chat.sessionDetails.changes")}</span>
                <Show when={props.changes}>
                  {(result) => <EnvironmentChangeCounts result={result()} />}
                </Show>
              </>
            )}
          </EnvironmentAction>
        </div>
      </Show>
    </>
  );
}
