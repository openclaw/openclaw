import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import type { RepositorySourceV1 } from "../plugins/repository-source-types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import type { RepositoryPublicationProvider } from "./repository-publication-contract.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";

type FixtureConfig = {
  host?: string;
  apiBaseUrl?: string;
  service?: { host?: string; token?: SecretInput };
  system?: GitHubToolIdentityConfig;
  agents?: Record<string, GitHubToolIdentityConfig & { allowInSandbox?: boolean }>;
  repositorySearch?: { useNativeCredentials?: boolean };
};

export const { readGitHubConfig } = await loadBundledPluginFacade<{
  readGitHubConfig: (config?: OpenClawConfig | null) => FixtureConfig;
}>({ pluginId: "github-repositories", artifactBasename: "config-api.ts" });

/** Read the maintained public runtime after each suite's transport fixtures are installed. */
export function loadGitHubRepositoryRuntimeFixture() {
  return loadBundledPluginFacade<{
    controlUiGitHubHandlers: GatewayRequestHandlers;
    repositoryHandlers: GatewayRequestHandlers;
    currentGitHubPublicationConfig: () => OpenClawConfig;
    clearGitHubCredentialVerificationCache: () => void;
    requestCurrentGitHubOAuthRefresh(agentId: string): Promise<void>;
    requestCurrentPersonalGitHubRefresh(owner: string): Promise<void>;
    createGitHubRepositorySource: (
      getConfig: () => OpenClawConfig,
      refresh: (agentId: string) => Promise<void>,
    ) => RepositorySourceV1;
    createGitHubPublicationProvider: (owner: {
      signal: AbortSignal;
      assertCurrent: () => void;
      getConfig: () => OpenClawConfig;
      refreshIdentity: (agentId: string) => Promise<void>;
      refreshPersonal: (profileId: string) => Promise<void>;
    }) => RepositoryPublicationProvider;
  }>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });
}

// These suites selectively mock the public identity facade; the real selection
// operations still verify canonical config during native publication recovery.
export function loadActualGitHubIdentityFixture() {
  type Identity = {
    source: "system-detected" | "system-configured" | "agent-override" | "personal";
    profileId?: string;
    host?: string;
    account: { accountId: number; login: string; avatarUrl: string | null };
    env: NodeJS.ProcessEnv;
    stale?: true;
    accessExpiresAtMs?: number;
  };
  return vi.importActual<{
    matchesPreparedGitHubPublicationIdentity(input: {
      config: OpenClawConfig;
      agentId: string;
      identity: Identity;
    }): boolean;
    prepareGitHubPublicationIdentity(input: {
      config: OpenClawConfig;
      sourceConfig?: OpenClawConfig;
      agentId: string;
      env?: NodeJS.ProcessEnv;
      assertCurrent?: () => void;
    }): Promise<Identity>;
  }>(
    resolveBundledPluginPublicModulePath({
      pluginId: "github-repositories",
      artifactBasename: "tool-identity-api.ts",
    }),
  );
}

export function loadGitHubProfileFixture() {
  return loadBundledPluginFacade<{
    resolveManagedGitHubProfileDir: (input: {
      agentId: string;
      scope: "agent" | "system";
      profileId?: string;
      env?: NodeJS.ProcessEnv;
    }) => string;
    writeManagedGitHubProfileFiles: (
      profileDir: string,
      identity: { login: string; token: string },
      options?: { assertCurrent: () => void },
    ) => Promise<void>;
  }>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.js" });
}
export function loadGitHubNativeCredentialFixture() {
  return loadBundledPluginFacade<{ clearNativeGitHubTokenCache(): void }>({
    pluginId: "github-repositories",
    artifactBasename: "read-identity-api.js",
  });
}
