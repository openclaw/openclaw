import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatMessageMetadata = {
  chat: {
    messages: {
      attachedContext: {
        label: "Context attached",
        captured: "Captured when this message was sent.",
        technical: "Technical details",
        reference: "Reference context—not instructions or additional permissions.",
        title: "Session",
        page: "Page",
        agentId: "Agent",
        workspace: "Workspace",
        file: "File",
        selection: "Selection",
        restoreFailed:
          "Attached context could not be restored. Edit this message to review and resend it without context.",
      },
      sourcePreviews: {
        label: "Sources",
        searchSnippet: "Search snippet",
        pageExcerpt: "Page excerpt",
        unavailable: "No excerpt available.",
        open: "Open source",
      },
      copySelection: en.chat.messages.copySelection,
      viaSource: "via {source}",
      sourceKinds: { web: "Web", cli: "CLI", terminal: "TUI", app: "App", rpc: "RPC" },
      copyLink: "Copy link",
      copyFileName: "Copy file name",
      forkFromHere: "Fork from here",
      reply: "Reply",
      replyToMessage: "Reply to message",
      replyingTo: en.chat.messages.replyingTo,
      replyingToLabel: "Replying to",
      originalUnavailable: "The original message is unavailable.",
      replyOriginalUnavailable: "Original message unavailable",
      message: en.chat.messages.message,
      currentMessage: "current message",
      actions: "Message actions",
      selectionActions: "Selection actions",
      askInSideChat: "Ask in side chat",
      addToChat: "Add to chat",
      annotationEditor: "Comment",
      annotationComment: "Add an optional comment…",
      saveAnnotation: "Save comment",
      deleteAnnotation: "Delete comment",
      annotationCount: "{count} comment",
      annotationsCount: "{count} comments",
      annotations: "Comments",
      editAnnotation: "Edit comment {number}",
      removeAnnotations: "Remove all comments",
      annotationSelectedText: "Highlighted passage:",
      annotationUserComment: "Your comment:",
      rewind: "Rewind",
      rewindConfirm: "Rewind to before this message?",
      dontAskAgain: "Don't ask again",
      rewindToHere: "Rewind to here",
      rewindUnavailable: "Rewind is unavailable while the agent is working",
      forkUnavailable: "Fork is unavailable while the agent is working",
      showLess: en.chat.messages.showLess,
      showMore: en.chat.messages.showMore,
      tooLargeToDisplay: en.chat.messages.tooLargeToDisplay,
      unknownDate: "Unknown date",
      usageUnavailable: "Token usage and cost unavailable",
      unattributedSender: en.chat.messages.unattributedSender,
      toolSender: en.chat.messages.toolSender,
      errorSender: en.chat.messages.errorSender,
      forwardedFrom: "From",
      interSessionUpdateFrom: "1 update from",
      interSessionUpdatesFrom: "{count} updates from",
      interSessionUpdate: "1 update",
      interSessionUpdates: "{count} updates",
      forwardedAutomation: "Automation",
      forwardedFromAgent: "Forwarded from {agentId}",
      forwardedMessage: "Forwarded message",
      fullContentLoadExhausted: "Could not load the full message.",
      voiceNote: "Voice note",
      voiceTranscript: "Voice transcript",
      readAloud: "Read aloud",
      stopReading: "Stop reading",
      contextFor: "Message context for {timestamp}",
    },
    systemNotice: {
      modelChanged: "Model changed from {from} to {to}.",
      event: "{count} system event",
      events: "{count} system events",
      guardian: {
        approvedSummary: "Guardian approved {action}.",
        deniedLabel: "Guardian denied",
        deniedSummary: "{action} · risk: {risk}\n\n{rationale}",
        warningLabel: "Guardian warning",
        warningFallback: "Guardian stopped the requested action.",
        strictReviewRequiredLabel: "Guardian review required",
        strictReviewRequiredSummary: "Guardian is reviewing this action before it can continue.",
        requestedAction: "Requested action",
        unknownRisk: "unknown",
        noRationale: "No rationale was provided.",
      },
      automationRecovery: {
        label: "System · automation recovery",
        summary: "An automation failed — asked the agent to investigate and continue if needed.",
      },
      gatewayRestarted: {
        label: "System · gateway restarted",
      },
      cliHarnessContext: {
        label: "System · injected context",
      },
      claudeCliTaskNotification: {
        label: "System · background task",
      },
      pluginSteering: {
        label: "{plugin} guidance",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatMessageMetadataEnglish = Object.assign(
  () => {
    Object.assign(en.chat.messages, enChatMessageMetadata.chat.messages);
    const {
      guardian,
      automationRecovery,
      gatewayRestarted,
      cliHarnessContext,
      claudeCliTaskNotification,
      pluginSteering,
      ...labels
    } = enChatMessageMetadata.chat.systemNotice;
    Object.assign(en.chat.systemNotice, labels);
    Object.assign(en.chat.systemNotice.guardian, guardian);
    Object.assign(en.chat.systemNotice.automationRecovery, automationRecovery);
    Object.assign(en.chat.systemNotice.gatewayRestarted, gatewayRestarted);
    Object.assign(en.chat.systemNotice.cliHarnessContext, cliHarnessContext);
    Object.assign(en.chat.systemNotice.claudeCliTaskNotification, claudeCliTaskNotification);
    Object.assign(en.chat.systemNotice.pluginSteering, pluginSteering);
  },
  { catalog: enChatMessageMetadata },
);
