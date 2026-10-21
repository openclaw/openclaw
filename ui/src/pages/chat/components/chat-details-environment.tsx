import type { JSX } from "@solidjs/web";
import { Show, onSettled, createMemo, createSignal, merge } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import { ChatDetailsContextContent, ChatDetailsContextSummary } from "./chat-details-context.tsx";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import "./chat-details-environment-desktop.css";
import type { ChatDetailsEnvironmentDesktopProps, ChatDetailsProps } from "./chat-details-types.ts";
import { ChatPanePlacement, createChatMachinePresentation } from "./chat-pane-placement.tsx";

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

export function EnvironmentChangeCounts(props: { result: SessionsDiffResult; mobile?: boolean }) {
  const binaryFiles = createMemo(() => props.result.files.filter((file) => file.binary).length);
  return (
    <span class="chat-environment__counts">
      <Show when={props.result.additions > 0}>
        <span class="chat-environment__added">+{props.result.additions}</span>
      </Show>
      <Show when={props.result.deletions > 0}>
        <span class="chat-environment__removed">−{props.result.deletions}</span>
      </Show>
      <Show when={binaryFiles() > 0}>
        <span
          title={props.mobile ? undefined : t("chat.sessionDiff.binaryFile")}
          aria-label={t("chat.sessionDiff.binaryFile")}
        >
          {binaryFiles()} <Icon name="file" />
        </span>
      </Show>
      <Show when={props.result.truncated}>
        <span
          title={props.mobile ? undefined : t("chat.sessionDiff.truncatedResult")}
          aria-label={t("chat.sessionDiff.truncatedResult")}
        >
          …
        </span>
      </Show>
    </span>
  );
}

export function ChatDetailsEnvironment(props: ChatDetailsEnvironmentDesktopProps) {
  const workspace = () => props.details.detailsWorkspace;
  const [localExpanded, setLocalExpanded] = createSignal(true);
  const expanded = () => props.expanded ?? localExpanded();
  const visible = createDocumentVisibility();
  // The checkout owner loads and publishes; this leaf only supplies visible demand.
  const requestUncommitted = createMemo(() =>
    props.presented && expanded() && visible() ? props.onRequestUncommitted : undefined,
  );
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
    return result && !result.unavailableReason && result.files.length > 0 ? result : undefined;
  };
  return [
    <Show when={requestUncommitted()} keyed>
      {(request) => {
        onSettled(request);
        return null;
      }}
    </Show>,
    <ChatDetailsDesktopSection
      section="environment"
      title={t("chat.sessionDetails.environment")}
      expanded={expanded()}
      presented={props.presented}
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
              <span>{summaryHost()}</span>
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
                    <span>{host()}</span>
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
                  <span>{host() ?? view.label}</span>
                  <Icon name="moreHorizontal" />
                </>
              ),
            }}
          />
        </div>
      </Show>
      <Show when={workspace()?.branch}>
        {(branch) => (
          <div class="chat-details__row chat-environment__row" title={branch()}>
            <Icon name="gitBranch" />
            <span>{branch()}</span>
            <Show when={session()?.worktree}>
              <small class="chat-details__badge">{t("chat.sessionDetails.worktree")}</small>
            </Show>
          </div>
        )}
      </Show>
      <Show when={session()?.worktree && !workspace()?.branch}>
        <div class="chat-details__row chat-environment__row chat-environment__worktree">
          <Icon name="folder" />
          <span>{t("chat.sessionDetails.worktree")}</span>
        </div>
      </Show>
      <Show when={changes()}>
        <div class="chat-details__row chat-environment__row">
          <EnvironmentAction presented={props.presented} onOpen={props.onOpenUncommitted}>
            {() => (
              <>
                <Icon name="diff" />
                <span>{t("chat.sessionDetails.changes")}</span>
                <Show when={changes()}>
                  {(result) => <EnvironmentChangeCounts result={result()} />}
                </Show>
              </>
            )}
          </EnvironmentAction>
        </div>
      </Show>
    </ChatDetailsDesktopSection>,
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
