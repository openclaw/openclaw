import {
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import {
  factoryGitHubClientProof,
  withFactoryGitHubProof,
  FACTORY_GITHUB_PROOF_ENV,
  type FactoryGitHubProofClaim,
} from "./factory-github-proof.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** App reads require a session-owned cleanup path; native project reads remain opt-in. */
export async function prepareGatewayProjectGitHubIdentity(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  client?: GatewayClient | null;
  /** Configured owner/repository to admit and issue an App token for. */
  requestedRepository?: string;
  factoryCredential?: { claim: FactoryGitHubProofClaim; assertCurrent: () => void };
}) {
  const selected =
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "agent",
    }) ??
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "system",
    });
  const appRead = selected?.kind === "app-installation" && params.factoryCredential !== undefined;
  if (!appRead && params.config.gateway?.projects?.nativeGitHubSearch !== true) {
    return undefined;
  }
  const prepare = (
    env = process.env,
    readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader,
    assertActive = params.assertActive,
  ) =>
    prepareGitHubReadIdentity({
      config: params.config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
      agentId: params.agentId,
      env,
      readNativeCredential,
      allowAppInstallation: appRead,
      requestedRepository: params.requestedRepository,
      getCurrentConfig: params.context.getRuntimeConfig,
      assertActive,
      // A protected identity executable owns token refresh and revalidation.
      refresh: async () => {},
    });
  if (!appRead) {
    return await prepare();
  }
  const credential = params.factoryCredential;
  if (!credential) {
    return await prepare();
  }
  const actor =
    process.env.FACTORY_AUTH_MODE === "github"
      ? factoryGitHubClientProof({
          client: params.client,
          claim: credential.claim,
          assertCurrent: params.assertActive,
        })
      : undefined;
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return await prepare();
  }
  if (!actor || !credential || !credential.claim.binding.sessionKey) {
    throw new Error("GitHub publication requires current actor and session authority.");
  }
  let issued: Awaited<ReturnType<typeof prepare>> | undefined;
  try {
    return await withFactoryGitHubProof(
      {
        actorId: actor.actorId,
        profileId: actor.profileId,
        claim: credential.claim,
        assertCurrent: () => {
          actor.assertCurrent();
          credential.assertCurrent();
        },
      },
      async (proofEnv, assertCurrent) => {
        const { [FACTORY_GITHUB_PROOF_ENV]: proof, ...env } = proofEnv;
        issued = await prepare(
          env,
          async (nativeEnv, admission) => {
            assertCurrent();
            if (!admission) {
              throw new Error(
                "Factory requires GitHub App execution; human execution credentials are disabled.",
              );
            }
            await readFactoryRepositoryAdmission({
              env: { ...nativeEnv, [FACTORY_GITHUB_PROOF_ENV]: proof },
              request: admission,
              claim: credential.claim,
              profileId: actor.profileId,
              assertCurrent,
            });
            assertCurrent();
            return undefined;
          },
          assertCurrent,
        );
        return issued;
      },
    );
  } catch (error) {
    await issued?.revoke?.();
    throw error;
  }
}
