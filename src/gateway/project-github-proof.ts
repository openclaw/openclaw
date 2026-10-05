import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";
import {
  factoryGitHubClientProof,
  factoryGitHubRequestDigest,
  readFactoryGitHubToken,
} from "./factory-github-proof.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

export async function readFactoryProjectToken(
  options: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "hasCurrentClientAuthority"
  > & { assertCurrent?: () => void },
  purpose: "project-add" | "project-search",
  request: string,
  admission?: import("../agents/github-credential-reader.js").GitHubRepositoryAdmissionRequest,
) {
  const { client, context, signal, hasCurrentClientAuthority } = options;
  const connectionId = client?.connId;
  const env = factoryGitHubActorEnvironment(client, connectionId ?? "");
  if (!env || !connectionId) {
    throw new Error("Factory GitHub connection is unavailable.");
  }
  const assertCurrent = () => {
    options.assertCurrent?.();
    signal?.throwIfAborted();
    if (
      hasCurrentClientAuthority?.() === false ||
      context.isConnectionActive?.(connectionId) === false ||
      context.getClientConnIds?.((current) => current === client).has(connectionId) === false
    ) {
      throw new Error("Factory GitHub connection authority changed.");
    }
  };
  return await readFactoryGitHubToken(
    env,
    factoryGitHubClientProof({
      client,
      claim: {
        purpose,
        binding: {
          kind: "connection",
          connectionId,
          requestDigest: factoryGitHubRequestDigest(request),
        },
      },
      assertCurrent,
    }),
    admission,
  );
}

/** Project reads retain their connection-bound human admission through the shared selector. */
export function factoryProjectCredentialReader(
  options: Parameters<typeof readFactoryProjectToken>[0],
  purpose: "project-add" | "project-search",
  request: string,
): import("../agents/github-credential-reader.js").GitHubCredentialReader | undefined {
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return undefined;
  }
  return (_env, admission) => readFactoryProjectToken(options, purpose, request, admission);
}

export async function prepareFactoryProjectIdentity(
  options: Parameters<typeof readFactoryProjectToken>[0],
  params: Parameters<
    typeof import("./project-github-identity.js").prepareConfiguredProjectGitHubIdentity
  >[0],
  purpose: "project-add" | "project-search",
  request: string,
) {
  const { prepareConfiguredProjectGitHubIdentity } = await import("./project-github-identity.js");
  return prepareConfiguredProjectGitHubIdentity({
    ...params,
    readNativeCredential: factoryProjectCredentialReader(options, purpose, request),
  });
}
