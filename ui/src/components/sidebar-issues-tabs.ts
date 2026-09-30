import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";

registerSidebarAttentionEnglish();

export const ISSUE_TABS = ["all", "approvals", "mentions", "automations", "system"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];

export function issueTabLabel(tab: IssueTab): string {
  return t(`attention.tabs.${tab}`);
}
