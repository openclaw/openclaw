import type { JSX } from "@solidjs/web";
import { Show, onSettled, createMemo, createSignal, merge } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { SessionGitDiff } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { ChatBranchActions } from "./chat-branch-actions.tsx";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import { ChatDetailsContextContent, ChatDetailsContextSummary } from "./chat-details-context.tsx";
import {
  animateDetailsDesktopEntrance,
  ChatDetailsDesktopSection,
} from "./chat-details-desktop-section.tsx";
import type { ChatDetailsEnvironmentDesktopProps, ChatDetailsProps } from "./chat-details-types.ts";
import "./chat-details-environment-desktop.css";
import { ChatPanePlacement, createChatMachinePresentation } from "./chat-pane-placement.tsx";
import { retainedPublication, showWorkRow } from "./chat-pull-requests.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type Props = { details: ChatDetailsProps; presented: boolean };

export function EnvironmentAction(props: {
  presented: boolean;
  onOpen?: () => void;
  children: () => JSX.Element;
}) {
  return (
    <Show when={props.onOpen} fallback={props.children()}>
      <button
        class="chat-environment__action"
        type="button"
        onClick={() => {
          if (props.presented) {
            props.onOpen?.();
          }
        }}
      >
        {props.children()}
        <Icon name="chevronRight" />
      </button>
    </Show>
  );
}

export function hasEnvironmentTextChanges(result?: { additions?: number; deletions?: number }) {
  return (result?.additions ?? 0) > 0 || (result?.deletions ?? 0) > 0;
}

export function EnvironmentChangeCounts(props: { result: SessionsDiffResult }) {
  return (
    <span class="chat-environment__counts">
      <Show when={props.result.additions > 0}>
        <span class="chat-environment__added">+{props.result.additions}</span>
      </Show>
      <Show when={props.result.deletions > 0}>
        <span class="chat-environment__removed">−{props.result.deletions}</span>
      </Show>
    </span>
  );
}

export function ChatDetailsEnvironment(props: ChatDetailsEnvironmentDesktopProps) {
  const workspace = () => props.details.detailsWorkspace;
  const [localExpanded, setLocalExpanded] = createSignal(true);
  const expanded = () => props.expanded ?? localExpanded();
  const visible = createDocumentVisibility();
  const session = () => props.details.selectedSession;
  const placement = merge(
    () => ({ session: session() }),
    () => props.placement ?? {},
  );
  const machine = createChatMachinePresentation(placement);
  const machineMenu = () => props.placement && machine()?.showPlacementMenu;
  // Only a placed environment establishes another executor. execNode/deviceFolder
  // alone cannot distinguish the Gateway host from a separate computer.
  const host = () =>
    machine()?.showPlacementMenu && machine()?.environmentId ? machine()?.machineName : undefined;
  const summaryHost = () => (machine()?.placementState === "active" ? host() : undefined);
  const connection = () => {
    const current = machine();
    // Cloud placements do not carry the device-only runner status. Match the native machine view.
    return current?.placementState === "active"
      ? current.deviceOffline
        ? "offline"
        : "available"
      : undefined;
  };
  function MachineIcon() {
    return (
      <span class="chat-environment-desktop__machine-icon" data-connection={connection()}>
        <Icon name={machine()?.machineIcon === "cloud" ? "server" : "monitor"} />
        <Show when={connection()}>
          <i aria-hidden="true" />
        </Show>
      </span>
    );
  }
  const changes = () => {
    const result = props.uncommitted;
    return result && !result.unavailableReason && hasEnvironmentTextChanges(result)
      ? result
      : undefined;
  };
  const published = () => props.work?.publication?.result?.status === "published";
  const work = () => {
    const candidate = props.work;
    if (!candidate || published()) {
      return undefined;
    }
    const publication = candidate.publication;
    return showWorkRow(candidate) ||
      (retainedPublication(publication) &&
        (publication?.result?.status !== "published" || publication.error))
      ? candidate
      : undefined;
  };
  const branchName = () => workspace()?.branch ?? work()?.branch?.branch;
  const diff = () => {
    const result = published() ? undefined : (work()?.branch ?? changes());
    return result && hasEnvironmentTextChanges(result) ? result : undefined;
  };
  const hasContent = createMemo(() =>
    Boolean(
      machineMenu() ||
      host() ||
      branchName() ||
      work() ||
      session()?.worktree ||
      (!published() && changes()),
    ),
  );
  // Capture cache availability before the first asynchronous arrival.
  const [initiallyEmpty] = createSignal<boolean>((previous) => previous ?? !hasContent());
  // Empty sections must keep reading even when the saved disclosure choice is closed.
  const requestUncommitted = createMemo(() =>
    props.presented && visible() && (expanded() || !hasContent())
      ? props.onRequestUncommitted
      : undefined,
  );
  return [
    <Show when={requestUncommitted()} keyed>
      {(request) => {
        onSettled(request);
        return null;
      }}
    </Show>,
    <Show when={hasContent()}>
      {(_available) => {
        let shell!: HTMLDivElement;
        const content = (
          <div ref={(element) => (shell = element)} class="chat-details-desktop-environment">
            <ChatDetailsDesktopSection
              section="environment"
              title={t("chat.sessionDetails.environment")}
              expanded={expanded()}
              presented={props.presented}
              animateContentResize
              onExpandedChange={(next) => {
                if (props.expanded === undefined) {
                  setLocalExpanded(next);
                }
                props.onExpandedChange?.(next);
              }}
              metadata={
                <Show when={!expanded()}>
                  <span class="chat-environment-desktop__summary">
                    <Show
                      when={summaryHost()}
                      fallback={
                        <Show when={workspace()?.branch}>
                          {(branch) => {
                            const overflow = useScrollState(true, false);
                            return (
                              <span ref={overflow} class="chat-environment-desktop__branch">
                                {branch()}
                              </span>
                            );
                          }}
                        </Show>
                      }
                    >
                      <MachineIcon />
                      <span ref={createTextOverflow(summaryHost)} title={summaryHost()}>
                        {summaryHost()}
                      </span>
                    </Show>
                  </span>
                </Show>
              }
            >
              <Show
                when={machineMenu() && props.presented}
                fallback={
                  <Show when={host()}>
                    <div class="chat-details__row chat-environment__row">
                      <EnvironmentAction presented={props.presented} onOpen={props.onOpenMachine}>
                        {() => (
                          <>
                            <MachineIcon />
                            <span ref={createTextOverflow(host)} title={host()}>
                              {host()}
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
                    {...placement}
                    trigger={{
                      class: "chat-details__row chat-environment__machine-trigger",
                      label: (view) => (host() ? `${host()} · ${view.label}` : view.label),
                      content: (view) => (
                        <>
                          <MachineIcon />
                          <span
                            ref={createTextOverflow(() => host() ?? view.label)}
                            title={host() ?? view.label}
                          >
                            {host() ?? view.label}
                          </span>
                          <Icon name="moreHorizontal" />
                        </>
                      ),
                    }}
                  />
                </div>
              </Show>
              <Show when={branchName() || work()}>
                <div class="chat-environment__branch">
                  <div class="chat-details__row chat-environment__row" title={branchName()}>
                    <Icon name={branchName() ? "gitBranch" : "gitPullRequest"} />
                    <span
                      ref={createTextOverflow(branchName)}
                      class="chat-environment__branch-name"
                    >
                      {branchName() ?? t("chat.pullRequests.publishPr")}
                    </span>
                    <Show when={session()?.worktree}>
                      <small class="chat-details__badge">{t("chat.sessionDetails.worktree")}</small>
                    </Show>
                  </div>
                  <Show when={diff() || work()}>
                    <div class="chat-environment__branch-controls">
                      <Show when={diff()}>
                        {(value) => (
                          <SessionGitDiff
                            classPrefix="chat-pr"
                            item={value()}
                            onOpen={
                              work()?.branch ? work()?.onOpenSessionDiff : props.onOpenUncommitted
                            }
                          />
                        )}
                      </Show>
                      <Show when={work()}>
                        {(value) => (
                          <ChatBranchActions
                            branch={value().branch}
                            branchName={branchName() ?? t("chat.pullRequests.publishPr")}
                            status={value().status}
                            publication={value().publication}
                            presented={props.presented && expanded()}
                            onDismiss={value().onDismissBranch}
                          />
                        )}
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={session()?.worktree && !branchName()}>
                <div class="chat-details__row chat-environment__row chat-environment__worktree">
                  <Icon name="folder" />
                  <span>{t("chat.sessionDetails.worktree")}</span>
                </div>
              </Show>
              <Show when={!published() && !branchName() && !work() && changes()}>
                <div class="chat-details__row chat-environment__row">
                  <Show
                    when={props.onOpenUncommitted ?? props.work?.onOpenSessionDiff}
                    fallback={
                      <>
                        <Icon name="diff" />
                        <span>{t("chat.sessionDetails.changes")}</span>
                        <Show when={changes()}>
                          {(result) => <EnvironmentChangeCounts result={result()} />}
                        </Show>
                      </>
                    }
                  >
                    <button
                      class="chat-environment__action"
                      type="button"
                      onClick={() => {
                        if (props.presented) {
                          (props.onOpenUncommitted ?? props.work?.onOpenSessionDiff)?.();
                        }
                      }}
                    >
                      <Icon name="diff" />
                      <span>{t("chat.sessionDetails.changes")}</span>
                      <Show when={changes()}>
                        {(result) => <EnvironmentChangeCounts result={result()} />}
                      </Show>
                      <Icon name="chevronRight" />
                    </button>
                  </Show>
                </div>
              </Show>
            </ChatDetailsDesktopSection>
          </div>
        );
        // The disclosure must restore its initial body before measuring the whole entrance.
        onSettled(() =>
          initiallyEmpty() && props.presented ? animateDetailsDesktopEntrance(shell) : undefined,
        );
        return content;
      }}
    </Show>,
  ];
}

export function ChatDetailsContext(props: Props) {
  const context = createMemo(() => getContextNoticeViewModel(props.details.selectedSession));
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={context()}>
      <details
        class="chat-details__group chat-details__context"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary class="chat-details__caption">
          {t("chat.sessionDetails.context")}
          <ChatDetailsContextSummary details={props.details} />
          <Icon name="chevronDown" />
        </summary>
        <ChatDetailsContextContent
          details={props.details}
          presented={props.presented && expanded()}
        />
      </details>
    </Show>
  );
}
