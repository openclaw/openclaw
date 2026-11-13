import type { StreamGroupOptions } from "./chat-message-stream-view.tsx";
import type { ChatThreadProps, ChatThreadState } from "./chat-thread-interactions.ts";

/** Retained rows dispatch through the current pane owner, with availability tracked separately. */
export function createTranscriptActions(
  context: ChatThreadState["transcriptRenderContext"],
  props: ChatThreadProps,
) {
  context.actions = props;
  const displayFacts = props.displayFacts;
  // Retained parts keep these dispatchers; each call uses the current pane owner.
  const actions: NonNullable<typeof context.actions> = {
    onOpenSidebar: props.onOpenSidebar
      ? (content) => context.actions?.onOpenSidebar?.(content)
      : undefined,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile
      ? (target) => context.actions?.onOpenWorkspaceFile?.(target)
      : undefined,
    onFindWorkspaceFile: props.onFindWorkspaceFile
      ? (target) => context.actions?.onFindWorkspaceFile?.(target)
      : undefined,
    onPermissionRetry: props.onPermissionRetry
      ? (message) => context.actions?.onPermissionRetry?.(message)
      : undefined,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded
      ? () => context.actions?.onAssistantAttachmentLoaded?.()
      : undefined,
    onOpenSessionLink: props.onOpenSessionLink
      ? (target) => context.actions?.onOpenSessionLink?.(target)
      : undefined,
    onOpenSubagent: props.onOpenSubagent
      ? (key) => context.actions?.onOpenSubagent?.(key)
      : undefined,
    onOpenSubagents: props.onOpenSubagents
      ? (focus) => context.actions?.onOpenSubagents?.(focus)
      : undefined,
    onRetryQueuedMessage: props.onRetryQueuedMessage
      ? (id) => context.actions?.onRetryQueuedMessage?.(id)
      : undefined,
    onSteerNow: props.onSteerNow ? (runId) => context.actions?.onSteerNow?.(runId) : undefined,
    onFocusComposer: props.onFocusComposer ? () => context.actions?.onFocusComposer?.() : undefined,
    onOpenImage: props.onOpenImage
      ? (item, requestVersion) => context.actions?.onOpenImage?.(item, requestVersion)
      : undefined,
    onRewindMessage: props.onRewindMessage
      ? (entryId) => context.actions?.onRewindMessage?.(entryId) ?? false
      : undefined,
    loadFullAssistantMessage: props.loadFullAssistantMessage
      ? async (request) => context.actions?.loadFullAssistantMessage?.(request)
      : undefined,
    personActivity: props.personActivity
      ? {
          basePath: props.personActivity.basePath,
          navigate: (personId, label) => context.actions?.personActivity?.navigate(personId, label),
        }
      : undefined,
    displayFacts: displayFacts
      ? {
          forRow: (id) => {
            const original = displayFacts.forRow(id);
            return original
              ? {
                  read: () => {
                    const current = context.actions?.displayFacts?.forRow(id)?.read();
                    return current && current.scope === original.read()?.scope
                      ? current
                      : undefined;
                  },
                  write: (update) => {
                    const current = context.actions?.displayFacts?.forRow(id);
                    const scope = original.read()?.scope;
                    // An old row must not write into a different session's display cache.
                    if (scope && current?.read()?.scope === scope) {
                      current.write(update);
                    }
                  },
                }
              : undefined;
          },
        }
      : undefined,
  };
  return {
    actions,
    dependencies: [
      props.widgetLayout,
      Boolean(props.displayFacts),
      props.personActivity?.basePath,
      Boolean(props.personActivity),
      Boolean(props.onOpenSidebar),
      Boolean(props.onOpenWorkspaceFile),
      Boolean(props.onFindWorkspaceFile),
      Boolean(props.onPermissionRetry),
      props.resolveArtifactDownload,
      props.onRequestOpenImage,
      Boolean(props.onOpenImage),
      Boolean(props.onAssistantAttachmentLoaded),
      Boolean(props.onOpenSessionLink),
      Boolean(props.onOpenSubagent),
      Boolean(props.onOpenSubagents),
      Boolean(props.onRewindMessage),
      Boolean(props.onFocusComposer),
    ],
  };
}

export function createTranscriptMessageOptions(
  props: ChatThreadProps,
  actions: ReturnType<typeof createTranscriptActions>["actions"],
  context: ChatThreadState["transcriptRenderContext"],
  presentation: Pick<
    StreamGroupOptions,
    | "resolveLiveStream"
    | "resolveReplyPreview"
    | "presented"
    | "handoffSessionLinks"
    | "agentId"
    | "mediaPolicyKey"
    | "showAssistantAvatar"
    | "bubbleMode"
  >,
): StreamGroupOptions {
  return {
    ...presentation,

    onReply: props.onSetReply ? (target) => context.onSetReply?.(target) : undefined,
    onOpenReply: (replyToId: string) => context.onOpenReply?.(replyToId),
    replyNavigationId: props.replyMessageAccess?.navigationId,
    onOpenSidebar: actions.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    widgetLayout: props.widgetLayout,
    displayFacts: actions.displayFacts,
    runActive: props.runActive,
    asyncQuestions: props.asyncQuestions,
    onOpenWorkspaceFile: actions.onOpenWorkspaceFile,
    onFindWorkspaceFile: actions.onFindWorkspaceFile,
    onPermissionRetry: actions.onPermissionRetry,
    mediaOwner: props.mediaOwner,
    toolMessageSource: props.toolMessageSource,
    mediaReadAllowed: props.mediaReadAllowed,
    resourceBasePath: props.resourceBasePath,
    connectionEpoch: props.connectionEpoch,
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    getThreadMediaMessages: (key) => context.threadMediaMessages?.get(key),
    onRequestOpenImage: props.onRequestOpenImage,
    onOpenImage: actions.onOpenImage,
    onAssistantAttachmentLoaded: actions.onAssistantAttachmentLoaded,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode ?? "scripts",
    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
    fetchLinkFavicon: props.fetchLinkFavicon,
    pluginToolIcons: props.pluginToolIcons,
  };
}
