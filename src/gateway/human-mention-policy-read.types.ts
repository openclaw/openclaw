import type { CurrentUserProfileDisplay } from "./current-user-profile-display.types.js";

// Read/discovery budgets, not a limit on the complete retained Inbox cohort.
export const MAX_MENTION_POLICY_PROFILES_PER_READ = 10_000;
export const MAX_MENTION_POLICY_DIRECTORY_PROFILES = 10_000;
export const MAX_MENTION_POLICY_TARGETS = 10_000;

export type HumanMentionProfileFacts = {
  requestedId: string;
  display: CurrentUserProfileDisplay;
  role: string | null;
  aliases: string[];
};

export type HumanMentionPolicyReadInput = {
  profileIds: readonly string[];
  directory: boolean;
};

export type HumanMentionPolicyReadResult = {
  profiles: HumanMentionProfileFacts[];
  directory?: { profiles: { id: string; logins: string[] }[]; truncated: boolean };
};
