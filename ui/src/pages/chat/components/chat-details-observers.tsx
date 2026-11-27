import { Show, createMemo, onSettled } from "solid-js";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { projectMutableSource } from "../../../lib/reactive/projection.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import { hasLoadedDetailsSubagents } from "../chat-spawned-subagent.ts";
import { hasListedDetailsSubagents } from "../chat-subagent-wait.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import { hasDesktopEnvironment } from "./chat-details-environment-data.ts";
import { hasDesktopDetailsPeople } from "./chat-details-people-data.ts";
import { createDetailsProcessesPresentation } from "./chat-details-processes-presentation.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { getChatOutputsCount, hasChatDesktopOutputs } from "./chat-outputs-data.ts";
import {
  createSessionAutomationInventory,
  readCachedSessionAutomations,
  type SessionAutomationInventory,
} from "./session-automation-inventory.tsx";

export type DesktopDetailsObservers = {
  automations: SessionAutomationInventory;
  processes: () => ProcessesPanelData | undefined;
  hasKnownContent: () => boolean;
  hasContent: () => boolean;
};

/** Retain the shared data owners without mounting closed Details renderers. */
export function ChatDetailsObservers(props: {
  chat?: ChatDetailsProps;
  host: () => HTMLElement;
  observing: boolean;
  visible: boolean;
  onReady: (observers: DesktopDetailsObservers) => void;
}) {
  const app = useOptionalApplication();
  const gateway = app ? projectGateway(app.gateway) : undefined;
  const hasEnvironment = createMemo(() => Boolean(props.chat && hasDesktopEnvironment(props.chat)));
  const hasKnownContent = createMemo(() => {
    const chat = props.chat;
    return Boolean(
      chat &&
      (hasEnvironment() ||
        hasDesktopDetailsPeople(chat, gateway?.read().snapshot.selfUser?.identity) ||
        hasListedDetailsSubagents(chat) ||
        (!hasLoadedDetailsSubagents(chat) &&
          !chat.subagentSessionsUnavailable &&
          chat.cachedDetails?.subagents?.total)),
    );
  });
  const hasOutputs = () => {
    const chat = props.chat;
    const outputs = chat?.desktopPresentation && chat.outputs;
    return Boolean(
      outputs &&
      (hasChatDesktopOutputs(outputs) ||
        (getChatOutputsCount(outputs) === null && (chat?.cachedDetails?.outputs ?? 0) > 0)),
    );
  };
  const outputsDemand = () => props.observing && props.chat?.outputs && props.chat.retainOutputs;
  const environmentDemand = () => {
    const chat = props.chat;
    if (
      props.observing &&
      props.visible &&
      (chat?.desktopDisclosures?.expanded.environment !== false || !hasEnvironment())
    ) {
      return chat?.environment?.onRequestUncommitted;
    }
    return undefined;
  };
  const automationInventory = createSessionAutomationInventory(
    {
      get gateway() {
        return props.chat?.pullRequestsGateway;
      },
      get sessionKey() {
        const chat = props.chat;
        return chat
          ? scopedSessionArtifactKey(chat.sessionKey, chat.currentAgentId ?? undefined)
          : "";
      },
      get presented() {
        return props.observing;
      },
    },
    props.host,
  );
  const hasAutomations = () =>
    (automationInventory.readable() &&
      (automationInventory.jobs().length > 0 ||
        (automationInventory.connected() && automationInventory.denied()))) ||
    Boolean(
      readCachedSessionAutomations(
        automationInventory,
        props.chat?.pullRequestsGateway,
        props.chat?.cachedDetails?.automations,
      )?.rows.length,
    );
  const processSource = (() => {
    if (!app) {
      return undefined;
    }
    const data = new ProcessesPanelData(app, () => view.publish());
    const view = projectMutableSource(data, (source) => source);
    onSettled(() => () => data.dispose());
    return { data, read: view.read };
  })();
  const processes = () => processSource?.read();
  const processRequest = createMemo(
    () =>
      [
        props.chat?.sessionKey ?? "",
        props.chat?.currentAgentId ?? "main",
        Boolean(processSource && props.observing && props.chat?.onOpenProcesses),
      ] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  const processSnapshot = () => processes()?.snapshot;
  const running = createDetailsProcessesPresentation(() => processSnapshot()?.rows ?? []);
  const hasProcesses = () => {
    if (!props.chat?.onOpenProcesses) {
      return false;
    }
    const snapshot = processSnapshot();
    return Boolean(
      (snapshot?.hasResult || snapshot?.errorKind === "access"
        ? running().length
        : props.chat.cachedDetails?.processes?.rows.length) ||
      (snapshot?.errorKind !== "read" && snapshot?.error),
    );
  };
  onSettled(() =>
    props.onReady({
      automations: automationInventory,
      processes,
      hasKnownContent,
      hasContent: () => hasOutputs() || hasAutomations() || hasProcesses(),
    }),
  );
  return (
    <>
      {automationInventory.lifecycle}
      <Show when={outputsDemand()} keyed>
        {(retain) => {
          onSettled(retain);
          return null;
        }}
      </Show>
      <Show when={environmentDemand()} keyed>
        {(retain) => {
          onSettled(retain);
          return null;
        }}
      </Show>
      <Show when={processSource && processRequest()} keyed>
        {([sessionKey, agentId, presented]) => {
          onSettled(() => {
            processSource?.data.sync({ sessionKey, agentId, presented });
          });
          return null;
        }}
      </Show>
    </>
  );
}
