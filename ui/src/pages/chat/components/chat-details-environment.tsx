import { Show, onSettled, createMemo, createSignal, lazy, merge } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import {
  animateDetailsDesktopEntrance,
  ChatDetailsDesktopSection,
} from "./chat-details-desktop-section.tsx";
import "./chat-details-environment-desktop.css";
import type { ChatDetailsEnvironmentDesktopProps } from "./chat-details-types.ts";
import { hasEnvironmentTextChanges } from "./chat-environment-content.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { createChatMachinePresentation } from "./chat-pane-placement.tsx";
import { retainedPublication, showWorkRow } from "./chat-pull-requests.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

const ChatDetailsEnvironmentBody = lazy(() => import("./chat-details-environment-body.tsx"), {
  export: "ChatDetailsEnvironmentBody",
});

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
    // The Gateway omits branch facts when this checkout has a live PR. Keep
    // uncertain attempts recoverable; a completed failure is not another publish offer.
    if (
      !candidate ||
      published() ||
      (!candidate.branch &&
        !candidate.publication?.locked &&
        candidate.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft"))
    ) {
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
    const result = work()?.branch ?? changes();
    return result && hasEnvironmentTextChanges(result) ? result : undefined;
  };
  const hasContent = createMemo(() =>
    Boolean(machineMenu() || host() || branchName() || work() || session()?.worktree || changes()),
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
              <ChatLazyBoundary>
                <ChatDetailsEnvironmentBody
                  {...props}
                  placement={placement}
                  expanded={expanded()}
                  machineMenu={machineMenu()}
                  host={host()}
                  branchName={branchName()}
                  work={work()}
                  fallbackWork={props.work}
                  diff={diff()}
                  changes={changes()}
                  renderMachineIcon={() => <MachineIcon />}
                />
              </ChatLazyBoundary>
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
