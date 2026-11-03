import type {
  PersonalGitHubStatus,
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
  ToolsGitHubStatusResult,
  UsersGitHubAuthorizePollResult,
  UsersGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { GitHubIdentityScope } from "../agents/github-oauth-records.js";

/** Released caller authority; the plugin retains account and credential policy. */
type LegacyPersonalGitHubAction = { owner: string; assertCurrent: () => void };

export type LegacyPersonalGitHubService = {
  status: (action: LegacyPersonalGitHubAction) => Promise<PersonalGitHubStatus>;
  revalidateStatus: (
    action: LegacyPersonalGitHubAction,
    prepared: PersonalGitHubStatus,
  ) => PersonalGitHubStatus;
  startAuthorization(action: LegacyPersonalGitHubAction): Promise<UsersGitHubAuthorizeStartResult>;
  pollAuthorization(
    action: LegacyPersonalGitHubAction,
    requestId: string,
  ): Promise<UsersGitHubAuthorizePollResult>;
  cancelAuthorization(action: LegacyPersonalGitHubAction, requestId: string): boolean;
  cancelAuthorizationAsync(action: LegacyPersonalGitHubAction, requestId: string): Promise<boolean>;
  disconnect(action: LegacyPersonalGitHubAction): void;
  disconnectAsync(action: LegacyPersonalGitHubAction): Promise<void>;
  refresh: (owner: string) => Promise<void>;
  maintain(): Promise<void>;
  stop(): Promise<void>;
};

/** Shipped context lookup retained through 2026-12-31; no native lifecycle is created. */
export type LegacyGitHubOAuthService = {
  personal: LegacyPersonalGitHubService;
  startAuthorization: (input: {
    scope: GitHubIdentityScope;
    agentId: string;
  }) => Promise<ToolsGitHubAuthorizeStartResult>;
  pollAuthorization: (requestId: string) => Promise<ToolsGitHubAuthorizePollResult>;
  cancelAuthorization(requestId: string): boolean;
  cancelAuthorizationAsync: (requestId: string) => Promise<boolean>;
  status: (agentId: string, selectedScope: GitHubIdentityScope) => Promise<ToolsGitHubStatusResult>;
  retireProfile(profileId: string): void;
  retireProfileAsync: (profileId: string) => Promise<void>;
  refreshEffectiveIdentity: (agentId: string) => Promise<void>;
  maintain: () => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};
