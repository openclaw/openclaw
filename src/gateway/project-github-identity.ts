import {
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import {
  prepareFactoryGitHubIdentity,
  type FactoryGitHubProofClaim,
} from "./factory-github-proof.js";
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
  withCredential?: <T extends { revoke?: () => Promise<void> }>(
    run: import("./control-ui-session-pr-request-read.js").RepositoryReadCredentialPreparation<T>,
  ) => Promise<T>;
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
  const appRead =
    selected?.kind === "app-installation" &&
    (params.factoryCredential !== undefined || params.withCredential !== undefined);
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
  if (appRead && params.withCredential) {
    return await params.withCredential(prepare);
  }
  if (!appRead) {
    return await prepare();
  }
  const credential = params.factoryCredential;
  if (!credential) {
    return await prepare();
  }
  return await prepareFactoryGitHubIdentity(
    {
      client: params.client,
      claim: credential.claim,
      assertCurrent: () => {
        params.assertActive();
        credential.assertCurrent();
      },
    },
    prepare,
  );
}
