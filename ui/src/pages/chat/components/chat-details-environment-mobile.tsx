import { onSettled, createMemo, merge, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { EnvironmentChangeCounts } from "./chat-details-environment.tsx";
import type { ChatDetailsEnvironmentProps, ChatDetailsProps } from "./chat-details-types.ts";
import {
  createChatMachinePresentation,
  type ChatPanePlacementProps,
} from "./chat-pane-placement.tsx";

export type ChatDetailsEnvironmentMobileProps = Omit<
  ChatDetailsEnvironmentProps,
  "details" | "expanded" | "onExpandedChange"
> & {
  details: Pick<ChatDetailsProps, "detailsWorkspace" | "selectedSession">;
  placement?: ChatPanePlacementProps;
};

/** A controlled leaf: the mobile host owns routes, facts, and retained state. */
export function ChatDetailsEnvironmentMobile(props: ChatDetailsEnvironmentMobileProps) {
  const requestUncommitted = createMemo(() =>
    props.presented ? props.onRequestUncommitted : undefined,
  );
  const workspace = () => props.details.detailsWorkspace;
  const session = () => props.details.selectedSession;
  const placement = merge(
    () => ({ session: session() }),
    () => props.placement ?? {},
  );
  const machine = createChatMachinePresentation(placement);
  const host = () =>
    machine()?.showPlacementMenu && machine()?.environmentId ? machine()?.machineName : undefined;
  const project = createMemo(
    () =>
      workspace()?.label ||
      workspace()
        ?.root?.replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop(),
  );
  const changes = () => {
    const result = props.uncommitted;
    return result && !result.unavailableReason && result.files.length > 0 ? result : undefined;
  };
  return [
    <Show when={requestUncommitted()} keyed>
      {(request) => {
        onSettled(request);
        return null;
      }}
    </Show>,
    <Show when={host() || project() || workspace()?.branch || session()?.worktree || changes()}>
      <section class="chat-environment-mobile" aria-label={t("chat.sessionDetails.environment")}>
        <h3>{t("chat.sessionDetails.environment")}</h3>
        <div class="chat-environment-mobile__group">
          <Show when={host()}>
            <div class="chat-environment-mobile__row" aria-label={host()}>
              <Show
                when={props.onOpenMachine}
                fallback={
                  <>
                    <Icon name={machine()?.machineIcon === "cloud" ? "server" : "monitor"} />
                    <span>{host()}</span>
                  </>
                }
              >
                <button
                  class="chat-environment__action"
                  type="button"
                  onClick={() => {
                    if (props.presented) {
                      props.onOpenMachine?.();
                    }
                  }}
                >
                  <Icon name={machine()?.machineIcon === "cloud" ? "server" : "monitor"} />
                  <span>{host()}</span>
                  <Icon name="chevronRight" />
                </button>
              </Show>
            </div>
          </Show>
          <Show when={project() && !workspace()?.branch}>
            <div class="chat-environment-mobile__row" aria-label={project()}>
              <Show
                when={props.onOpenProject}
                fallback={
                  <>
                    <Icon name="folder" />
                    <span>{project()}</span>
                  </>
                }
              >
                <button
                  class="chat-environment__action"
                  type="button"
                  onClick={() => {
                    if (props.presented) {
                      props.onOpenProject?.();
                    }
                  }}
                >
                  <Icon name="folder" />
                  <span>{project()}</span>
                  <Icon name="chevronRight" />
                </button>
              </Show>
            </div>
          </Show>
          <Show when={workspace()?.branch}>
            {(branch) => (
              <div class="chat-environment-mobile__row" aria-label={branch()}>
                <Icon name="gitBranch" />
                <span>{branch()}</span>
                <Show when={session()?.worktree}>
                  <small>{t("chat.sessionDetails.worktree")}</small>
                </Show>
              </div>
            )}
          </Show>
          <Show when={session()?.worktree && !workspace()?.branch}>
            <div class="chat-environment-mobile__row">
              <Icon name="folder" />
              <span>{t("chat.sessionDetails.worktree")}</span>
            </div>
          </Show>
          <Show when={changes()}>
            {(result) => (
              <div class="chat-environment-mobile__row">
                <Show
                  when={props.onOpenUncommitted}
                  fallback={
                    <>
                      <Icon name="diff" />
                      <span>{t("chat.sessionDetails.changes")}</span>
                      <EnvironmentChangeCounts result={result()} mobile />
                    </>
                  }
                >
                  <button
                    class="chat-environment__action"
                    type="button"
                    onClick={() => {
                      if (props.presented) {
                        props.onOpenUncommitted?.();
                      }
                    }}
                  >
                    <Icon name="diff" />
                    <span>{t("chat.sessionDetails.changes")}</span>
                    <EnvironmentChangeCounts result={result()} mobile />
                    <Icon name="chevronRight" />
                  </button>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </section>
    </Show>,
  ];
}
