import { resolveConfiguredGitHubHost, githubRepositoryUrl } from "../agents/github-host.js";
import { subscribeGitHubIdentityChanges } from "../agents/github-read-identity.js";
import {
  prepareGitHubPublicationIdentity,
  matchesPreparedGitHubPublicationIdentity,
  resolveConfiguredGitHubToolIdentity,
  onManagedGitHubProfileChanged,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../plugin-sdk/core.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { sameGitHubPublisherSelection } from "./github-publication-publisher.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import type { RepositoryWorkerIdentity } from "./repository-publication-contract.js";
import { performRepositoryWorkerIdentity } from "./repository-worker-identity-transfer.js";

export function subscribeGitHubWorkerIdentityChanges(listener: () => void) {
  const stopProfiles = onManagedGitHubProfileChanged(listener);
  const stopCredentials = subscribeGitHubIdentityChanges(listener);
  return () => {
    stopProfiles();
    stopCredentials();
  };
}

/** The account owner retains selected identity, credential renewal and vendor events. */
export async function prepareGitHubWorkerIdentity(
  owner: {
    getConfig: () => OpenClawConfig;
    refreshIdentity: (agentId: string) => Promise<void>;
    assertCurrent: () => void;
    signal: AbortSignal;
  },
  input: { agentId: string; originUrl: string; assertCurrent(this: void): void },
): Promise<RepositoryWorkerIdentity | undefined> {
  const prepare = async (assertOperation: () => void) => {
    owner.assertCurrent();
    assertOperation();
    await owner.refreshIdentity(input.agentId);
    owner.assertCurrent();
    assertOperation();
    const config = owner.getConfig();
    return await prepareGitHubPublicationIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId: input.agentId,
      assertCurrent: () => {
        owner.assertCurrent();
        assertOperation();
      },
    });
  };
  let identity = await prepare(input.assertCurrent);
  if (!identity.env.GH_TOKEN) {
    return undefined;
  }
  const selected = identity;
  const assertCurrent = () => {
    owner.assertCurrent();
    if (
      !matchesPreparedGitHubPublicationIdentity({
        config: owner.getConfig(),
        agentId: input.agentId,
        identity,
      })
    ) {
      throw new Error("Worker GitHub identity changed.");
    }
  };
  const remote = parseGitHubRemoteUrl(
    input.originUrl,
    resolveConfiguredGitHubHost(owner.getConfig()),
  );
  const remoteUrl =
    remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo)
      ? githubRepositoryUrl(`${remote.owner}/${remote.repo}`, identity.host)
      : undefined;
  const scope =
    identity.source === "agent-override"
      ? "agent"
      : identity.source === "system-configured"
        ? "system"
        : undefined;
  const gitAuthor = scope
    ? resolveConfiguredGitHubToolIdentity({
        config: owner.getConfig(),
        agentId: input.agentId,
        scope,
      })?.gitAuthor
    : undefined;
  return {
    assertCurrent,
    signal: owner.signal,
    async refresh(assertOperation) {
      assertCurrent();
      const next = await prepare(assertOperation);
      assertCurrent();
      if (!sameGitHubPublisherSelection(next, selected)) {
        return "retired";
      }
      identity = next;
      assertCurrent();
      return "ready";
    },
    subscribe(listener) {
      return onManagedGitHubProfileChanged(({ profileDir, kind }) => {
        if (profileDir === identity.env.GH_CONFIG_DIR) {
          listener(kind === "removed" ? "retired" : "changed");
        }
      });
    },
    async deliver(transfer) {
      assertCurrent();
      const token = identity.env.GH_TOKEN;
      if (!token) {
        throw new Error("Selected GitHub credential is unavailable.");
      }
      await performRepositoryWorkerIdentity(
        transfer,
        {
          token,
          login: identity.account.login,
          ...(remoteUrl ? { remoteUrl } : {}),
          ...(gitAuthor ? { gitAuthor } : {}),
          ...(identity.accessExpiresAtMs !== undefined
            ? { expiresAtMs: identity.accessExpiresAtMs }
            : {}),
        },
        assertCurrent,
      );
    },
  };
}
