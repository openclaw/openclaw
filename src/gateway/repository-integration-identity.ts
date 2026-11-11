import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { resolveGitHubHost, resolveGitHubApiBaseUrl } from "../agents/github-host-runtime.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import type {
  RepositoryActor,
  RepositoryOperation,
} from "../plugins/repository-integration.types.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
type RepositoryCredential = { claim: RepositoryOperation; assertCurrent: () => void };

/** Native lifetimes surround policy; plugins never replace current session/profile owners. */
export async function withRepositoryIdentity<T>(
  actor: RepositoryActor,
  credential: RepositoryCredential,
  run: (
    env: NodeJS.ProcessEnv,
    readNativeCredential: GitHubCredentialReader,
    assertCurrent: () => void,
  ) => Promise<T>,
): Promise<T> {
  const integration = getRepositoryIntegration();
  if (!integration) {
    throw new Error("Repository integration is no longer selected");
  }
  if (!actor.sessionKey) {
    throw new Error("Repository operation requires current actor and session authority");
  }
  actor.assertCurrent();
  credential.assertCurrent();
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const profile = captureResidentUserProfileAccess(actor.profileId);
  const operation = structuredClone(credential.claim);
  Object.freeze(operation.binding);
  Object.freeze(operation);
  const authorization =
    actor.authorization?.kind === "connection"
      ? Object.freeze({
          ...actor.authorization,
          scopes: Object.freeze([...actor.authorization.scopes]),
        })
      : Object.freeze({ kind: "admitted-operation" as const });
  const actorFacts = Object.freeze({ ...actor, authorization });
  const assertCurrent = () => {
    if (
      getRepositoryIntegration() !== integration ||
      resolveGitHubHost() !== host ||
      resolveGitHubApiBaseUrl() !== apiBaseUrl
    ) {
      throw new Error("Repository operation authority changed");
    }
    actor.assertCurrent();
    credential.assertCurrent();
    profile.readCurrentFacts();
  };
  assertCurrent();
  const result = await integration.withIdentity(
    {
      actor: actorFacts,
      operation,
      env: process.env,
      host,
      apiBaseUrl,
      readCurrentProfile: () => {
        assertCurrent();
        const facts = profile.readCurrentFacts();
        return Object.freeze({
          emails: Object.freeze([...facts.emails]),
          assignedRole: facts.assignedRole,
        });
      },
      assertCurrent,
    },
    async (scope) => {
      assertCurrent();
      scope.assertCurrent();
      const issued = await run(
        scope.env,
        async (env, admission) => {
          assertCurrent();
          scope.assertCurrent();
          const value = await scope.readNativeCredential(
            env,
            admission
              ? {
                  kind: admission.kind,
                  host: admission.host,
                  selection: {
                    kind: admission.selection.kind,
                    profileId: admission.selection.profileId,
                    app: {
                      appId: admission.selection.app.appId,
                      installationId: admission.selection.app.installationId,
                      accountId: admission.selection.app.accountId,
                      repositories: admission.selection.app.repositories,
                      permissions: admission.selection.app.permissions,
                    },
                  },
                }
              : undefined,
          );
          assertCurrent();
          scope.assertCurrent();
          return value;
        },
        () => {
          assertCurrent();
          scope.assertCurrent();
        },
      );
      assertCurrent();
      scope.assertCurrent();
      return issued;
    },
  );
  assertCurrent();
  return result;
}
