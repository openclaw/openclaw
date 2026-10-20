import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enApprovals = {
  standingGrants: {
    title: "Standing grants",
    description:
      "Allow-always on an automation approval mints a standing grant for that exact command. Revoking one makes the next occurrence ask again.",
    historyTitle: "Approval history",
    empty: "No standing grants. Answer an automation approval with Always allow to mint one.",
    stateUntilRevoked: "Until revoked",
    stateExpiresIn: "Expires in {count}d",
    stateExpired: "Expired",
    stateRevoked: "Revoked",
    revoke: "Revoke",
    revoking: "Revoking…",
    columns: {
      automation: "Automation",
      command: "Command",
      uses: "Uses",
      state: "State",
    },
  },
  approvalHistory: {
    description:
      "Terminal exec, plugin, and system-agent approvals recorded by this gateway, newest first.",
    loading: "Loading approval history…",
    loadingMore: "Loading…",
    loadMore: "Load more",
    empty: "No resolved approvals in the rolling 30-day window.",
    retention: "Approval history is a rolling 30-day window.",
    offline: "Connect to the gateway to load approval history.",
    invalidResponse: "The gateway returned an invalid approval history response.",
    unknown: "Unknown",
    notApplicable: "N/A",
    columns: {
      resolved: "Resolved",
      kind: "Kind",
      request: "Request",
      decision: "Decision",
      reason: "Resolution reason",
      source: "Source agent / session",
      resolver: "Resolver",
    },
    kinds: {
      exec: "Exec",
      plugin: "Plugin",
      systemAgent: "System agent",
    },
    statuses: {
      allowed: "Allowed",
      denied: "Denied",
      expired: "Expired",
      cancelled: "Cancelled",
    },
    decisions: {
      allowOnce: "Allow once",
      allowAlways: "Always allow",
      deny: "Deny",
    },
    reasons: {
      user: "User decision",
      timeout: "Timed out",
      malformedVerdict: "Malformed verdict",
      noRoute: "No route",
      runAborted: "Run aborted",
      gatewayRestart: "Gateway restart",
      storageCorrupt: "Storage corrupt",
    },
  },
} satisfies TranslationMap;

export const registerApprovalsEnglish = Object.assign(
  () => {
    Object.assign(en.standingGrants, enApprovals.standingGrants);
    Object.assign(en.approvalHistory, enApprovals.approvalHistory);
  },
  { catalog: enApprovals },
);
