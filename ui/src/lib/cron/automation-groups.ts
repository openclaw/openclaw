export const automationGroups = ["active", "paused", "history"] as const;
export type AutomationGroup = (typeof automationGroups)[number];
