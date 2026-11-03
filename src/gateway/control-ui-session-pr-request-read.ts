import { AsyncLocalStorage } from "node:async_hooks";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareFactoryGitHubIdentity } from "./factory-github-proof.js";
import type {
  PreparedRepositorySessionRead,
  RepositoryReadCredentialPreparation,
} from "./repository-session-read.types.js";

/** Request-only source custody; callers cannot supply a client, profile or session incarnation. */
export function captureRepositorySessionRequestRead() {
  return createRepositorySessionRequestRead(getPluginRuntimeGatewayRequestScope());
}

function createRepositorySessionRequestRead(
  scope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>,
) {
  const context = scope?.resolveGatewayContext?.() ?? scope?.context;
  const client = scope?.client ?? null;
  const host = context?.repositorySessions;
  if (!scope || !context || !host) {
    throw new Error("Repository session reads require an admitted Gateway request");
  }
  const presentation = host.presentation;
  const invocation = pluginInstanceInvocation.getStore();
  const inInvocation = AsyncLocalStorage.snapshot();
  const instanceSignal = invocation?.instance.lifecycle.signal;
  const signal = AbortSignal.any(
    [scope.signal, client?.connectionSignal, instanceSignal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (
      (invocation && !inInvocation(() => invocation.instance.hasActiveCall)) ||
      client?.invalidated ||
      (scope.hasCurrentClientAuthority
        ? !scope.hasCurrentClientAuthority()
        : client &&
          (!client.connId ||
            !context.getClientConnIds?.((candidate) => candidate === client).has(client.connId))) ||
      (scope.resolveGatewayContext && scope.resolveGatewayContext() !== context) ||
      context.repositorySessions !== host ||
      host.presentation !== presentation
    ) {
      throw new Error("Repository session request authority changed");
    }
  };
  assertCurrent();
  return Object.freeze({
    signal,
    assertCurrent,
    viewerIdentity: JSON.stringify([
      client?.authenticatedUserProfile?.profileId,
      client?.authenticatedFactoryGitHubAccountId,
    ]),
    async withRead<T>(
      query: { sessionKey: string; agentId?: string; allowOwnImportedPullRequest?: boolean },
      operation: (
        read: PreparedRepositorySessionRead | undefined,
        request: {
          checks: NonNullable<typeof presentation>["checks"];
          withCredential: <TIdentity extends { revoke?: () => Promise<void> }>(
            requestUrl: string,
            run: RepositoryReadCredentialPreparation<TIdentity>,
          ) => Promise<TIdentity>;
        },
      ) => Promise<T>,
    ): Promise<T> {
      assertCurrent();
      return await host.withRequestRead(
        {
          client,
          signal,
          hasCurrentClientAuthority: () => {
            assertCurrent();
            return true;
          },
        },
        query,
        async (read) => {
          let active = true;
          const assertReadCurrent = () => {
            if (!active) {
              throw new Error("Repository session read is closed");
            }
            assertCurrent();
            read?.assertCurrent();
          };
          try {
            const result = await operation(read, {
              checks: async (selected, params, guard) => {
                assertReadCurrent();
                if (!presentation || selected !== read) {
                  throw new Error("Repository session review is unavailable");
                }
                const checks = await presentation.checks(selected, params, () => {
                  assertReadCurrent();
                  guard();
                });
                assertReadCurrent();
                return checks;
              },
              withCredential: async (requestUrl, run) => {
                if (!read) {
                  throw new Error("Repository session read is unavailable");
                }
                assertReadCurrent();
                const credential = {
                  claim: {
                    purpose: "session-item-read" as const,
                    binding: {
                      kind: "session" as const,
                      ...read.session,
                      lifecycleRevision: read.session.lifecycleRevision ?? null,
                      requestDigest: sha256Hex(requestUrl),
                    },
                  },
                  assertCurrent: assertReadCurrent,
                };
                return await prepareFactoryGitHubIdentity({ client, ...credential }, run);
              },
            });
            assertReadCurrent();
            return result;
          } finally {
            active = false;
          }
        },
      );
    },
    async replaceSubscriptions(input: {
      sessionKeys: readonly string[];
      refresh?: ReadonlySet<string>;
      passive?: ReadonlySet<string>;
      admitted?: () => void;
    }): Promise<void> {
      assertCurrent();
      if (!client?.connId || !presentation) {
        throw new Error("Repository session subscriptions unavailable");
      }
      await presentation.replace(
        client.connId,
        input.sessionKeys,
        input.refresh,
        () => {
          assertCurrent();
          input.admitted?.();
        },
        input.passive,
      );
      assertCurrent();
    },
  });
}
