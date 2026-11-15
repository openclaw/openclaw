import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { resolveGitHubHost, resolveGitHubApiBaseUrl } from "../agents/github-host-runtime.js";
import {
  GitHubIdentityError,
  type GitHubIdentityPreparation,
} from "../agents/github-read-identity.js";
import {
  prepareGitHubPublicationIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import type {
  RepositoryActor,
  RepositoryOperation,
} from "../plugins/repository-integration.types.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
export type RepositoryPublicationActor = RepositoryActor;
export type RepositoryPublicationCredential = {
  claim: RepositoryOperation;
  assertCurrent: () => void;
};

export function repositoryPublicationPreflightCredential(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  requestDigest?: string;
  assertCurrent: () => void;
}): RepositoryPublicationCredential {
  return {
    claim: {
      purpose: "publication-preflight",
      binding: {
        kind: "session",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        ...(params.requestDigest ? { requestDigest: params.requestDigest } : {}),
      },
    },
    assertCurrent: params.assertCurrent,
  };
}

/** Native lifetimes surround policy; plugins never replace current session/profile owners. */
export async function withRepositoryIdentity<T>(
  actor: RepositoryActor,
  credential: RepositoryPublicationCredential,
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

/** Project the original admitted requester; plugin policy does not own session lifetimes. */
export function repositoryPublicationPreflightActor(
  requester: Pick<GitHubPublicationRequesterPolicyV2, "snapshot" | "repositoryCredentialSource">,
  sessionKey: string,
  assertCurrent: () => void,
): RepositoryPublicationActor | undefined {
  const actor = requester.snapshot.actor;
  return actor.kind === "operator"
    ? {
        profileId: actor.profileId,
        credentialSource: requester.repositoryCredentialSource,
        sessionKey,
        assertCurrent,
      }
    : undefined;
}

/** Resolve the effective identity before selecting App broker admission or native credentials. */
export async function preparePublicationGitHubIdentity(
  snapshot: Pick<GitHubIdentityPreparation, "config" | "sourceConfig">,
  agentId: string,
  actor?: RepositoryPublicationActor | (() => void),
  credential?: RepositoryPublicationCredential,
  allowAppInstallation = true,
) {
  const callerAssert = typeof actor === "function" ? actor : actor?.assertCurrent;
  const repositoryActor = typeof actor === "function" ? undefined : actor;
  const assertCurrent = () => {
    callerAssert?.();
    credential?.assertCurrent();
  };
  const prepare = (
    env?: NodeJS.ProcessEnv,
    readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader,
  ) =>
    prepareGitHubPublicationIdentity({
      config: snapshot.config,
      sourceConfig: snapshot.sourceConfig,
      agentId,
      env,
      readNativeCredential,
      assertCurrent,
    });
  const selected =
    resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope: "system" });
  if (selected?.kind === "app-installation" && !allowAppInstallation) {
    throw new GitHubIdentityError("unavailable");
  }
  let issued: Awaited<ReturnType<typeof prepare>> | undefined;
  let identity: Awaited<ReturnType<typeof prepare>>;
  try {
    if (selected?.kind === "app-installation" && getRepositoryIntegration()) {
      if (!repositoryActor || !credential) {
        throw new Error("Repository operation requires current actor and session authority");
      }
      identity = await withRepositoryIdentity(
        repositoryActor,
        credential,
        async (env, reader, assertPolicyCurrent) => {
          issued = await prepareGitHubPublicationIdentity({
            config: snapshot.config,
            sourceConfig: snapshot.sourceConfig,
            agentId,
            env,
            readNativeCredential: reader,
            assertCurrent: () => {
              assertCurrent();
              assertPolicyCurrent();
            },
          });
          return issued;
        },
      );
    } else {
      identity = await prepare();
    }
  } catch (error) {
    await issued?.revoke?.();
    throw error;
  }
  try {
    assertCurrent();
  } catch (error) {
    await identity.revoke?.();
    throw error;
  }
  return identity;
}
