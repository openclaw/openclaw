import type { GitHubPublicationPublisher } from "../../packages/gateway-protocol/src/index.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { readRuntimeConfig as getRuntimeConfig } from "../plugin-sdk/runtime-config-snapshot.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import {
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./github-publication-failure.js";

function publicationConfigSnapshot() {
  const active = getActiveSecretsRuntimeConfigSnapshot();
  if (active) {
    return active;
  }
  const config = getRuntimeConfig();
  return { config, sourceConfig: config };
}

export function assertExpectedSharedGitHubPublisher(
  expected: GitHubPublicationPublisher | undefined,
  actual: GitHubPublicationPublisher,
  preparation?: GitHubPublicationPreparation,
): void {
  if (
    actual.source === "personal" ||
    (expected &&
      (expected.source !== actual.source ||
        expected.accountId !== actual.accountId ||
        expected.login.toLowerCase() !== actual.login.toLowerCase()))
  ) {
    rejectGitHubPublicationSelection(
      "GitHub publication identity changed; review the current shared account and try again.",
      preparation,
    );
  }
}

export function currentGitHubPublicationConfig() {
  return publicationConfigSnapshot().config;
}

export async function prepareCurrentGitHubPublicationIdentity(
  agentId: string,
  assertCurrent?: () => void,
): Promise<PreparedGitHubPublicationIdentity> {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export async function prepareCurrentGitHubPublicationOptionsIdentity(
  agentId: string,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationOptionsIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export function matchesCurrentGitHubPublicationIdentity(params: {
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  return matchesPreparedGitHubPublicationIdentity({
    config: currentGitHubPublicationConfig(),
    ...params,
  });
}
