import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import { readNativeGitHubToken } from "../agents/github-read-identity.js";
import { withFactoryGitHubProof, FACTORY_GITHUB_PROOF_ENV } from "./factory-github-proof.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";
import type {
  FactoryPublicationActor,
  FactoryPublicationCredential,
} from "./github-publication-availability.js";

export async function withFactoryPublicationIdentity<T>(
  actor: FactoryPublicationActor | undefined,
  credential: FactoryPublicationCredential | undefined,
  run: (
    env: NodeJS.ProcessEnv | undefined,
    readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader,
  ) => Promise<T>,
): Promise<T> {
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return await run(undefined);
  }
  if (!actor || !credential) {
    throw new Error("GitHub publication requires current actor and credential authority.");
  }
  const sessionKey =
    credential.claim.binding.kind === "connection"
      ? credential.claim.binding.connectionId
      : credential.claim.binding.sessionKey;
  if (!actor.sessionKey || !sessionKey) {
    throw new Error("GitHub publication session authority changed.");
  }
  return await withFactoryGitHubProof(
    {
      profileId: actor.profileId,
      claim: credential.claim,
      assertCurrent: () => {
        actor.assertCurrent?.();
        credential.assertCurrent();
      },
    },
    async (proofEnv, assertCurrent) => {
      const { [FACTORY_GITHUB_PROOF_ENV]: proof, ...env } = proofEnv;
      return await run(env, async (nativeEnv, admission) => {
        assertCurrent();
        if (admission) {
          await readFactoryRepositoryAdmission({
            env: { ...nativeEnv, [FACTORY_GITHUB_PROOF_ENV]: proof },
            request: admission,
            claim: credential.claim,
            profileId: actor.profileId,
            assertCurrent,
          });
          return undefined;
        }
        const token = await readNativeGitHubToken(
          { ...nativeEnv, [FACTORY_GITHUB_PROOF_ENV]: proof },
          false,
          resolveGitHubHost(),
        );
        assertCurrent();
        if (!token) {
          throw new Error("Factory GitHub broker did not authorize this credential lookup.");
        }
        return token;
      });
    },
  );
}
