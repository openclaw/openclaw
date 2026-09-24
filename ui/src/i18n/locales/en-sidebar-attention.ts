import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Inbox diagnostics follow their lazy presenters; the loader label stays eager.
const enSidebarAttention = {
  connection: {
    scopeUpgrade: {
      limited: "This browser has limited access.",
      guidance:
        "This browser has limited access. Manage it with openclaw devices on the Gateway or from Devices on an admin browser.",
      status: "Limited access",
      inboxState: "Administrator access required",
      showDetails: "Show limited access details",
      closeDetails: "Close limited access details",
      request: "Request admin",
      requesting: "Requesting administrator access…",
      requestingAction: "Requesting…",
      pending:
        "Approve this browser by running openclaw devices on the Gateway or from Devices on an admin browser. Retry reattaches to the request; Cancel stops waiting.",
      retry: "Retry",
      cancel: "Cancel",
      rejected: "The administrator access request was rejected.",
      expired: "The administrator access request expired.",
      error: "Administrator access request failed: {error}",
    },
  },
  attention: {
    cronErrorUnknown: "Unknown error",
    cronFailed: "{job} failed",
    cronOverdue: "{job} overdue",
    automationFailed: "Failed · {time}",
    automationOverdue: "Overdue · {time}",
    failed: "Failed",
    overdue: "Overdue",
    dismissItem: "Dismiss {item}",
    dismissShown: "Dismiss shown",
    emptyTitle: "Nothing waiting",
    emptyBody: "New requests and alerts land here.",
    issues: "Inbox",
    issueCount: "{count} inbox item",
    issueCountPlural: "{count} inbox items",
    tabs: {
      label: "Inbox categories",
      all: "All",
      approvals: "Approvals",
      mentions: "Mentions",
      automations: "Automations",
      system: "System",
    },
    mentions: {
      from: "{sender} mentioned you",
      mentionedYou: "mentioned you",
      viewSession: "View session",
      noExcerpt: "Open the session to read the message.",
      open: "Open",
      dismiss: "Dismiss",
      dismissing: "Dismissing…",
      emptyTitle: "No mentions yet",
      emptyBody: "When someone mentions you in a chat, it appears here.",
      retention: "Mentions expire after 7 days.",
      notifications: "Notification settings",
      loading: "Loading mentions…",
      unavailable: "Sign in and connect to the Gateway to see your mentions.",
      refresh: "Refresh mentions",
      error: "Mentions could not be updated. Refresh or try dismissing again.",
    },
    outbox: {
      conversation: "Conversation",
      failed: "Your message wasn’t sent",
      unconfirmed: "Your message may not have arrived",
      commandFailed: "Your command failed",
      commandUnconfirmed: "Your command may not have run",
      review: "Review in chat",
      reviewShort: "Review",
      reviewHint: "Open the conversation to review it before trying again.",
      checkBeforeRetry: "Open the conversation to check whether it arrived before trying again.",
      checkCommandBeforeRetry:
        "The command may already have run. Review the conversation before retrying.",
      offline: "Offline",
      offlineHint: "Offline: reconnect before retrying.",
    },
    modelAuthExpired: "Model auth expired: {providers}",
    authExpired: "Auth expired",
    modelAuthExpiredState: "Auth expired · {time}",
    modelAuthExpiredWithScope: "{scope} · Auth expired · {time}",
    reconnect: "Reconnect",
    pendingApproval: "{count} pending approval",
    pendingApprovals: "{count} pending approvals",
    alerts: {
      updateQuestion:
        "These are the available update facts:\n{facts}\nSummarize what is new and whether anything needs my attention before updating.",
      cronFailedQuestion:
        "These automations failed:\n{facts}\nExplain why they failed and how to fix them.",
      cronOverdueFact: "{job}: {duration} late",
      cronOverdueQuestion:
        "These automations are overdue:\n{facts}\nExplain why they have not run and how to fix them.",
      modelAuthExpiredQuestion:
        "These model-provider credentials need attention:\n{facts}\nExplain what expired and how to re-authenticate them.",
    },
  },
} satisfies TranslationMap;

export const registerSidebarAttentionEnglish = Object.assign(
  () => {
    Object.assign(en.connection, enSidebarAttention.connection);
    en.attention = enSidebarAttention.attention;
  },
  { catalog: enSidebarAttention },
);
