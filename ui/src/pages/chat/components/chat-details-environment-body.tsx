import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { SessionGitDiff } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { PluginContributions } from "../../../plugins/control-ui-contributions.solid.tsx";
import type { ChatDetailsEnvironmentDesktopProps } from "./chat-details-types.ts";
import { EnvironmentAction, EnvironmentChangeCounts } from "./chat-environment-content.tsx";
import { ChatPanePlacement, type ChatPanePlacementProps } from "./chat-pane-placement.tsx";

type Props = ChatDetailsEnvironmentDesktopProps & {
  placement: ChatPanePlacementProps;
  expanded: boolean;
  machineMenu: boolean | undefined;
  host: string | undefined;
  branchName: string | undefined;
  worktree: boolean;
  diff: SessionsDiffResult | undefined;
  changes: SessionsDiffResult | undefined;
  accessoryPresent: boolean;
  accessoryPresented: boolean;
  onAccessoryPresenceChange: (present: boolean) => void;
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
      <PluginContributions
        kind="session-environment"
        sessionKey={props.details.sessionKey}
        agentId={props.details.currentAgentId ?? undefined}
        facts={props.details.sessionHeaderFacts}
        presented={props.accessoryPresented}
        onPresenceChange={props.onAccessoryPresenceChange}
        onOpenSessionDiff={props.details.onOpenSessionDiff}
      />
      <Show when={props.branchName && !props.accessoryPresent}>
        <div class="chat-environment__branch">
          <div class="chat-details__row chat-environment__row" title={props.branchName}>
            <Icon name={props.branchName ? "gitBranch" : "gitPullRequest"} />
            <span
              ref={createTextOverflow(() => props.branchName)}
              class="chat-environment__branch-name"
            >
              {props.branchName}
            </span>
            <Show when={props.worktree}>
              <small class="chat-details__badge">{t("chat.sessionDetails.worktree")}</small>
            </Show>
          </div>
          <Show when={props.diff}>
            <div class="chat-environment__branch-controls">
              <Show when={props.diff}>
                {(value) => (
                  <SessionGitDiff
                    classPrefix="chat-pr"
                    item={value()}
                    onOpen={props.onOpenUncommitted}
                  />
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.worktree && !props.branchName && !props.accessoryPresent}>
        <div class="chat-details__row chat-environment__row chat-environment__worktree">
          <Icon name="folder" />
          <span>{t("chat.sessionDetails.worktree")}</span>
        </div>
      </Show>
      <Show when={!props.branchName && !props.accessoryPresent && props.changes}>
        <div class="chat-details__row chat-environment__row">
          <EnvironmentAction
            presented={props.presented}
            onOpen={props.onOpenUncommitted ?? props.details.onOpenSessionDiff}
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
