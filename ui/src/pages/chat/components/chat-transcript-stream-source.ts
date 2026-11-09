import { createMemo } from "solid-js";
import { i18n } from "../../../i18n/index.ts";
import { localParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { projectChatReasoning } from "../chat-reasoning.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import {
  buildCachedChatItems,
  findLiveStreamIndex,
  getChatItemsGeneration,
} from "../chat-thread.ts";
import { buildChatArchiveNotice } from "./chat-divider.ts";
import { prepareChatStreamRender } from "./chat-message-markdown-view.tsx";
import type { StreamGroupOptions } from "./chat-message-stream-view.tsx";
import { isVisibleChatStream } from "./chat-position-projection.ts";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { projectThreadMediaMessages } from "./chat-thread-media-gallery.ts";
import { resolveTranscriptParticipants } from "./chat-transcript-identity.ts";
import { projectTranscriptRecovery } from "./chat-transcript-recovery.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

export function chatTranscriptInputs(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
  search = getTranscriptState(props.paneId).search.snapshot,
) {
  const activeSession = props.selectedSession;
  const { showOwnSenderName, replyPeople } = resolveTranscriptParticipants(props);
  const { showReasoning, reasoning } = projectChatReasoning(props);
  const locale = i18n.getLocale();
  const searchFiltering = search.open && Boolean(search.query.trim());
  const expandedAssistantMessages = transcript.expandedAssistantMessages;
  const recovery = projectTranscriptRecovery(expandedAssistantMessages, props);
  const subagents = projectSubagentStatus(props, searchFiltering);
  const chatItemsInput = {
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    archiveNotice: buildChatArchiveNotice(props.transcriptMetadata ?? activeSession),
    runId: props.runId ?? null,
    compactionStatus: props.compactionStatus,
    locale,
    messages: props.messages,
    toolMessages: props.toolMessages,
    guardianNotices: props.guardianNotices,
    streamSegments: props.streamSegments,
    get stream() {
      return props.stream ?? null;
    },
    reasoning,
    showReasoning,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    initialTurnId: props.initialTurnId,
    pendingInputs: props.pendingInputs,
    workerSetupPending: ["requested", "provisioning", "syncing", "starting"].includes(
      activeSession?.placement?.state ?? "",
    ),
    workspaceSyncPendingRunIds:
      (activeSession?.placement?.state === "active" ||
        activeSession?.placement?.state === "draining") &&
      activeSession.placement.workspaceResultReconciling === true
        ? activeSession.activeRunIds
        : undefined,
    showToolCalls: props.showToolCalls,
    persistCommentary: props.persistCommentary,
    runWorking: Boolean(props.runWorking),
    runFinalizing: props.runFinalizing,
    runActive: Boolean(props.runActive),
    subagentWait: subagents.placedWait,
    questionPrompts: props.questionPrompts,
    loading: props.loading,
    replyPeople,
    replyLocalPerson: localParticipantIdentityKey(props.userId),
    searchOpen: search.open,
    searchQuery: search.query,
    messageRecovery: searchFiltering
      ? {
          messages: expandedAssistantMessages,
          revision: recovery.revision,
          agentId: props.fullMessageAgentId,
          displayFacts: props.displayFacts,
          canFetchFullMessage: Boolean(props.loadFullAssistantMessage),
        }
      : undefined,
  } satisfies Parameters<typeof buildCachedChatItems>[0];
  return { chatItemsInput, searchFiltering, showReasoning, showOwnSenderName, recovery, subagents };
}

/** Keep row membership separate from the live text consumed by the bubble and open previews. */
export function createTranscriptStreamSource(
  input: Parameters<typeof buildCachedChatItems>[0],
  searchFiltering: boolean,
) {
  // The pane frame parks, but its live stream getter remains independently reactive.
  // The memo also owns the visibility lifecycle for imperative transcript callers.
  const visible = createMemo(createDocumentVisibility);
  const source = createParkedProjection(
    () => {
      const currentInput = { ...input };
      const items = buildCachedChatItems(currentInput);
      // The gallery retains this map; refresh its live slot without rebuilding rows.
      const threadMediaMessages = projectThreadMediaMessages(
        searchFiltering
          ? buildCachedChatItems(
              { ...currentInput, searchOpen: false, searchQuery: "", messageRecovery: undefined },
              "unfiltered",
            )
          : items,
      );
      return {
        items,
        generation: getChatItemsGeneration(items),
        threadMediaMessages,
      };
    },
    () => visible()(),
  );
  const snapshot = createMemo(source, {
    equals: (previous, next) =>
      previous.items === next.items && previous.generation === next.generation,
  })();
  // Text updates belong to the mounted bubble. Only grouping or visible-marker
  // changes rerun the projection and virtual rows below.
  const liveIndex = findLiveStreamIndex(snapshot.items);
  const live = createMemo(() => {
    const candidate = source().items[liveIndex];
    const part = candidate?.kind === "stream" ? candidate : undefined;
    return { part, prepared: part ? prepareChatStreamRender(part) : undefined };
  });
  const liveVisibility = createMemo(() => {
    const part = live().part;
    return Boolean(part && isVisibleChatStream(part));
  });
  liveVisibility();
  const resolveLiveStream: NonNullable<StreamGroupOptions["resolveLiveStream"]> = (part) => {
    const current = live().part;
    return current?.key === part.key ? current : part;
  };
  return { snapshot, live, resolveLiveStream };
}
