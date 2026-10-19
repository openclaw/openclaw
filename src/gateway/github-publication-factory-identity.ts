import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { withFactoryGitHubProof, FACTORY_GITHUB_PROOF_ENV } from "./factory-github-proof.js";
import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";

type FactoryPublicationActor = {
  actorId: number;
  profileId: string;
  sessionKey: string;
  assertCurrent: () => void;
};

type FactoryPublicationCredential = {
  claim: FactoryGitHubProofClaim;
  assertCurrent: () => void;
};

export async function withFactoryPublicationIdentity<T extends { revoke?: () => Promise<void> }>(
  actor: FactoryPublicationActor | undefined,
  credential: FactoryPublicationCredential | undefined,
  run: (
    env?: NodeJS.ProcessEnv,
    readNativeCredential?: GitHubCredentialReader,
    assertCurrent?: () => void,
  ) => Promise<T>,
): Promise<T> {
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return await run();
  }
  if (!actor || !credential || !actor.sessionKey) {
    throw new Error("GitHub publication requires current actor and session authority.");
  }
  let issued: T | undefined;
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
        issued = await run(
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
