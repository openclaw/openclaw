import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Inbox diagnostics follow their lazy presenters; the loader label stays eager.
const enSidebarAttention = {
  connection: {
    scopeUpgrade: {
      limited: "This browser has limited access.",
      guidance: "Ask an admin to approve this browser in Devices.",
      roleGuidance: "Only admins can manage access. Ask an admin for access.",
      roleState: "Access follows your role",
      status: "Limited access",
      inboxState: "Admin access required",
      showDetails: "Show limited access details",
      closeDetails: "Close limited access details",
      request: "Request admin",
      requesting: "Requesting admin access…",
      requestingAction: "Requesting…",
      pending:
        "Ask an admin to approve this browser in Devices or run {command} on the Gateway. Retry checks the same request. Cancel stops waiting.",
      retry: "Retry",
      cancel: "Cancel",
      rejected: "The admin access request was rejected.",
      expired: "The admin access request expired. Request access again.",
      error: "Couldn’t request admin access. Try again. {error}",
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
    emptyTitle: "No requests or alerts yet.",
    emptyBody: "New requests and alerts land here.",
    issues: "Inbox",
    issueCount: "{count} inbox item",
    issueCountPlural: "{count} inbox items",
    tabs: {
      label: "Inbox categories",
      all: "All",
      approvals: "Approvals",
      mentions: "Mentions",
      system: "System",
    },
    mentions: {
      from: "{sender} mentioned you",
      open: "Open",
      dismiss: "Dismiss",
      dismissing: "Dismissing…",
      emptyTitle: "No mentions yet.",
      emptyBody: "When someone mentions you in a session, it appears here.",
      retention: "Mentions expire after 7 days.",
      notifications: "Notification settings",
      loading: "Loading mentions…",
      unavailable: "Sign in and connect to the Gateway to see your mentions.",
      refresh: "Refresh mentions",
      error: "Couldn’t update mentions. Refresh or try dismissing again.",
    },
    outbox: {
      conversation: "Conversation",
      failed: "Couldn’t send your message.",
      held: "Your message needs review",
      commandFailed: "Couldn’t complete your command.",
      review: "Review in chat",
      reviewShort: "Review",
      reviewHint: "Open the conversation to review it before trying again.",
      offline: "Disconnected",
      offlineHint: "Reconnect to try again.",
    },
    modelAuthExpired: "Account needs attention: {providers}",
    authExpired: "Account needs attention",
    signInRequired: "Sign-in required",
    apiKeyRequired: "API key needs attention",
    signIn: "Sign in",
    updateApiKey: "Update API key",
    modelAuthExpiredState: "{status} · {time}",
    modelAuthExpiredWithScope: "{scope} · {status} · {time}",
    reconnect: "Review account",
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
