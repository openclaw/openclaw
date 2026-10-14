export const ISSUE_TABS = ["all", "approvals", "mentions", "automations", "system"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];
