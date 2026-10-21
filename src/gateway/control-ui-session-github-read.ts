import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../agents/github-host.js";
import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import { createControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { gitHubPublicApi, type ControlUiGitHubSessionIdentity } from "./github-public-api.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-github-identity.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

type Target = NonNullable<ReturnType<typeof gitHubPublicApi.parseGitHubTarget>>;

/** Private presentation borrows the current visible session's existing App reader. */
export async function withControlUiSessionGitHubRead<T>(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  target: Target,
  run: (identity: ControlUiGitHubSessionIdentity) => Promise<T>,
  consume: (value: T) => void,
): Promise<T> {
  const { params, client, context, signal, hasCurrentClientAuthority } = options;
  const config = context.getRuntimeConfig();
  const host = resolveConfiguredGitHubHost(config);
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(config);
  const unavailable = () =>
    new gitHubPublicApi.ControlUiGitHubError(
      404,
      "GitHub link is outside the current session or unavailable to this reader",
    );
  if (
    !client ||
    typeof params.sessionKey !== "string" ||
    !params.sessionKey.trim() ||
    params.githubHost !== host ||
    host === "github.com"
  ) {
    throw unavailable();
  }
  const assertClient = () => {
    signal?.throwIfAborted();
    if (
      client.connectionSignal?.aborted ||
      client.invalidated ||
      context.getRuntimeConfig() !== config ||
      (hasCurrentClientAuthority
        ? !hasCurrentClientAuthority()
        : !client.connId ||
          !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw unavailable();
    }
  };
  assertClient();
  const read = createControlUiSessionPrRead({
    client,
    sessionKey: params.sessionKey,
    agentId,
    getRuntimeConfig: context.getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    isCurrentClient: () => {
      try {
        assertClient();
        return true;
      } catch {
        return false;
      }
    },
  });
  const session = await read?.();
  if (!session?.sessionId) {
    throw unavailable();
  }
  const sessionId = session.sessionId;
  return withControlUiSessionPrSource(session.readSource, async (assertSource) => {
    const assertCurrent = () => {
      assertClient();
      session.assertCurrent?.();
      assertSource();
    };
    assertCurrent();
    const repository =
      typeof session.source === "string"
        ? await runGitReadOperation({
            type: "checkout.context",
            input: { root: session.source, githubHost: host },
          })
        : session.source;
    assertCurrent();
    if (
      !repository ||
      (repository.host ?? "github.com") !== host ||
      repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
      repository.repo.toLowerCase() !== target.repo.toLowerCase()
    ) {
      throw unavailable();
    }
    const selected =
      resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "system" });
    const admitted =
      selected?.kind === "app-installation" &&
      selected.app.repositories.find(
        (entry) => entry.fullName.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase(),
      );
    if (!admitted) {
      throw unavailable();
    }
    const requestUrl = `https://${host}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${target.kind === "pull" ? "pull" : target.kind === "issue" ? "issues" : "commit"}/${target.kind === "commit" ? target.sha : target.number}`;
    const identity = await prepareGatewayProjectGitHubIdentity({
      config,
      context,
      client,
      agentId,
      requestedRepository: `${repository.owner}/${repository.repo}`,
      assertActive: assertCurrent,
      factoryCredential: {
        claim: {
          purpose: "session-item-read",
          binding: {
            kind: "session",
            agentId,
            sessionKey: session.params.sessionKey,
            sessionId,
            lifecycleRevision: session.lifecycleRevision ?? null,
            requestDigest: sha256Hex(requestUrl),
          },
        },
        assertCurrent,
      },
    });
    if (!identity?.token) {
      await identity?.revoke?.();
      throw unavailable();
    }
    let value: T;
    try {
      assertCurrent();
      const assertSelected = () => {
        assertCurrent();
        identity.assertSelected();
      };
      value = await run({
        ...identity,
        host,
        apiBaseUrl,
        signal,
        repository: { id: admitted.id, owner: repository.owner, repo: repository.repo },
        cacheScope: JSON.stringify([
          host,
          apiBaseUrl,
          admitted.id,
          client.authenticatedUserProfile?.profileId,
          client.authenticatedFactoryGitHubAccountId,
          session.identity,
          identity.cacheScope,
        ]),
        assertSelected,
        revalidate: async () => {
          assertCurrent();
          await identity.revalidate();
          assertCurrent();
        },
      });
      assertSelected();
    } finally {
      await identity.revoke?.();
    }
    assertCurrent();
    identity.assertSelected();
    consume(value);
    return value;
  });
}
