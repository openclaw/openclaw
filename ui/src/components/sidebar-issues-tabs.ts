export const ISSUE_TABS = ["all", "approvals", "mentions", "system"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];
