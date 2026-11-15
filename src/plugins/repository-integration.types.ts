import type { IncomingHttpHeaders } from "node:http";
import type { GitHubAppSelection } from "../agents/github-credential-reader.js";

/** Host-authenticated connection metadata. Values alone never grant current authority. */
export type RepositoryConnectionIdentity = Readonly<{
  accountId: number;
  credentialSource?: Readonly<{ id: string; expiresAtMs: number }>;
  profile?: Readonly<{
    principal: string;
    login: string;
    name?: string;
    email?: string;
    avatarUrl?: string;
  }>;
}>;
type SessionDispatchBinding = {
  kind: "session-dispatch";
  agentId: string;
  sessionKey: string;
  sessionId: string;
  requestDigest: string;
};

export type RepositoryOperation = {
  purpose: "session-dispatch-project";
  binding: SessionDispatchBinding;
};

type RepositoryAuthorization = Readonly<
  | {
      kind: "connection";
      role: string;
      scopes: readonly string[];
      authenticatedOperator: boolean;
      directPerson: boolean;
      principal?: string;
    }
  | { kind: "admitted-operation" }
>;
export type RepositoryActor = Readonly<{
  actorId?: number;
  authorization?: RepositoryAuthorization;
  profileId: string;
  sessionKey: string;
  credentialSource?: RepositoryConnectionIdentity["credentialSource"];
  assertCurrent: () => void;
}>;
export type RepositoryCredentialScope = Readonly<{
  env: NodeJS.ProcessEnv;
  readNativeCredential: (
    env: NodeJS.ProcessEnv,
    admission?: RepositoryAdmission,
  ) => Promise<string | undefined>;
  assertCurrent: () => void;
}>;

/** Public App selection facts for policy; signing keys stay with the native issuer. */
export type RepositoryAdmission = {
  kind: "repository-admission";
  host: string;
  selection: Pick<GitHubAppSelection, "kind" | "profileId"> & {
    app: Pick<
      GitHubAppSelection["app"],
      "appId" | "installationId" | "accountId" | "repositories" | "permissions"
    >;
  };
};
/** Registered callbacks execute under the plugin instance and fail after its closure. */
export type RepositoryIntegration = {
  version: 1;
  resolveConnectionIdentity: (context: {
    authentication: Readonly<{
      ok: boolean;
      method?: string;
      user?: string;
      mode?: string;
      userHeader?: string;
    }>;
    headers: Readonly<IncomingHttpHeaders>;
    host: string;
    assertCurrent: () => void;
  }) => RepositoryConnectionIdentity | undefined;
  withIdentity: <T>(
    context: {
      actor: RepositoryActor & { authorization: RepositoryAuthorization };
      operation: RepositoryOperation;
      env: NodeJS.ProcessEnv;
      host: string;
      apiBaseUrl: string;
      readCurrentProfile: () => Readonly<{
        emails: readonly string[];
        assignedRole?: string | null;
      }>;
      assertCurrent: () => void;
    },
    run: (scope: RepositoryCredentialScope) => Promise<T>,
  ) => Promise<T>;
  /** Choose image-only standing capacity; accounting and admission remain native. */
  preparedCapacity: "image" | "repository";
};
