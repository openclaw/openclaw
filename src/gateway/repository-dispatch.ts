import { AsyncLocalStorage } from "node:async_hooks";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import type {
  RepositoryActor,
  RepositoryOperation,
} from "../plugins/repository-integration.types.js";
import { readAcceptedGatewayDeviceSourceAuthority } from "./device-revocation.js";
import { withRepositoryIdentity } from "./repository-integration-identity.js";
import type { GatewayClient } from "./server-methods/client-types.js";
export type { RepositoryOperation } from "../plugins/repository-integration.types.js";

/** Capture host-authenticated operator authority; no wire metadata can create this handle. */
export function captureRepositoryClientActor(input: {
  client: GatewayClient | null | undefined;
  claim: RepositoryOperation;
  assertCurrent: () => void;
  hasCurrentClientAuthority?: () => boolean;
}): RepositoryActor {
  const client = input.client;
  const actorId =
    client?.authenticatedGitHubAccountId ?? client?.authenticatedFactoryGitHubAccountId;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const credentialSource = client?.authenticatedRepositoryCredentialSource;
  const userId = client?.authenticatedUserId;
  const connectionId = client?.connId;
  const role = client?.connect.role;
  const scopes = Object.freeze([...(client?.connect.scopes ?? [])]);
  const authenticatedOperator = client?.internal?.authenticatedOperator === true;
  const directPerson =
    !client?.internal?.syntheticClient &&
    !client?.internal?.agentRuntimeIdentity &&
    !client?.internal?.agentToolCaller;
  const assertCurrent = () => {
    input.assertCurrent();
    const retainedSource = readAcceptedGatewayDeviceSourceAuthority(
      input.hasCurrentClientAuthority,
    );
    if (
      !client ||
      (retainedSource
        ? !retainedSource()
        : client.invalidated ||
          client.connectionSignal?.aborted ||
          input.hasCurrentClientAuthority?.() === false) ||
      !client.connId ||
      client.connId !== connectionId ||
      client.connect.role !== role ||
      JSON.stringify(client.connect.scopes ?? []) !== JSON.stringify(scopes) ||
      (client.internal?.authenticatedOperator === true) !== authenticatedOperator ||
      (!client.internal?.syntheticClient &&
        !client.internal?.agentRuntimeIdentity &&
        !client.internal?.agentToolCaller) !== directPerson ||
      client.authenticatedUserId !== userId ||
      (client.authenticatedGitHubAccountId ?? client.authenticatedFactoryGitHubAccountId) !==
        actorId ||
      client.authenticatedUserProfile?.profileId !== profileId ||
      client.authenticatedRepositoryCredentialSource !== credentialSource
    ) {
      throw new Error("Repository caller authority changed");
    }
  };
  assertCurrent();
  if (!profileId) {
    throw new Error("Repository operation requires a verified profile");
  }
  return Object.freeze({
    actorId,
    profileId,
    credentialSource,
    authorization: Object.freeze({
      kind: "connection" as const,
      role: role ?? "",
      scopes,
      authenticatedOperator,
      directPerson,
      principal: userId,
    }),
    sessionKey:
      input.claim.binding.kind === "connection"
        ? input.claim.binding.connectionId
        : input.claim.binding.sessionKey,
    assertCurrent,
  });
}

type ChatDispatchAdmission = {
  client: GatewayClient | null | undefined;
  agentId: string;
  sessionKey: string;
  getSessionId: () => string;
  runId: string;
  assertCurrent: () => void;
};
type ActiveChatDispatchAdmission = ChatDispatchAdmission & { source: ChatDispatchAdmission };
const chatDispatchAdmission = new AsyncLocalStorage<ActiveChatDispatchAdmission>();

/** Core Goal queue retains the authenticated source, never a proof or closed dispatch. */
export function captureRepositoryGoalDispatch(assertCurrent: () => void) {
  const source = chatDispatchAdmission.getStore()?.source;
  if (!source) {
    return undefined;
  }
  source.assertCurrent();
  const actorId = source.client?.authenticatedGitHubAccountId;
  const profileId = source.client?.authenticatedUserProfile?.profileId;
  const credentialSource = source.client?.authenticatedRepositoryCredentialSource;
  const assertGoalSourceCurrent = () => {
    // The queue retains operator authority independently of the completed input's
    // work lease. The repository reader still verifies the live resident identity.
    assertCurrent();
    if (
      source.client?.invalidated ||
      source.client?.authenticatedGitHubAccountId !== actorId ||
      source.client?.authenticatedUserProfile?.profileId !== profileId ||
      source.client?.authenticatedRepositoryCredentialSource !== credentialSource
    ) {
      throw new Error("Goal source authority changed.");
    }
  };
  return <T>(
    identity: { agentId: string; sessionKey: string; sessionId: string; runId: string },
    run: () => Promise<T>,
  ) => {
    const assertContinuationCurrent = () => {
      assertGoalSourceCurrent();
      if (
        identity.agentId !== source.agentId ||
        identity.sessionKey !== source.sessionKey ||
        identity.sessionId !== source.getSessionId()
      ) {
        throw new Error("Goal continuation session changed.");
      }
    };
    return withRepositoryChatDispatch(
      {
        ...source,
        runId: identity.runId,
        getSessionId: () => identity.sessionId,
        assertCurrent: assertContinuationCurrent,
      },
      run,
    );
  };
}

/** Carry the current authenticated input, never a broker proof, into worker preparation. */
export async function withRepositoryChatDispatch<T>(
  admission: ChatDispatchAdmission,
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  try {
    return await chatDispatchAdmission.run(
      {
        ...admission,
        source: admission,
        assertCurrent: () => {
          if (!active) {
            throw new Error("Repository chat dispatch admission was released.");
          }
          admission.assertCurrent();
        },
      },
      run,
    );
  } finally {
    active = false;
  }
}

export function repositoryChatDispatchCredentialReader(
  identity: { agentId: string; sessionKey: string; sessionId: string },
  target: unknown,
  assertCurrent: () => void,
): GitHubCredentialReader | undefined {
  const admission = chatDispatchAdmission.getStore();
  if (
    !admission ||
    admission.agentId !== identity.agentId ||
    admission.sessionKey !== identity.sessionKey ||
    admission.getSessionId() !== identity.sessionId
  ) {
    return undefined;
  }
  return repositoryDispatchCredentialReader({
    ...identity,
    client: admission.client,
    requestDigest: sha256Hex(JSON.stringify({ runId: admission.runId, target })),
    assertCurrent: () => {
      admission.assertCurrent();
      assertCurrent();
      if (admission.getSessionId() !== identity.sessionId) {
        throw new Error("Repository chat dispatch session changed.");
      }
    },
  });
}

/** Worker source access cannot replace required caller admission with stored credentials. */
export function assertRepositoryDispatchAdmission(
  reader: GitHubCredentialReader | undefined,
  config?: OpenClawConfig,
): void {
  if (getRepositoryIntegration(config) && !reader?.admit) {
    throw new Error("Repository worker startup requires current GitHub dispatch admission");
  }
  reader?.assertCurrent?.();
}

/** A dispatch reader retains its original actor and exact request identity. */
export function repositoryDispatchCredentialReader(params: {
  client: GatewayClient | null | undefined;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  requestDigest: string;
  assertCurrent: () => void;
  hasCurrentClientAuthority?: () => boolean;
}): GitHubCredentialReader | undefined {
  return repositoryCredentialReader({
    ...params,
    claim: {
      purpose: "session-dispatch-project",
      binding: {
        kind: "session-dispatch",
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        requestDigest: params.requestDigest,
      },
    },
  });
}

export function repositoryProjectCredentialReader(params: {
  client: GatewayClient | null | undefined;
  requestDigest: string;
  assertCurrent: () => void;
}): GitHubCredentialReader | undefined {
  return repositoryCredentialReader({
    ...params,
    claim: {
      purpose: "project-add",
      binding: {
        kind: "connection",
        connectionId: params.client?.connId ?? "",
        requestDigest: params.requestDigest,
      },
    },
  });
}

function repositoryCredentialReader(params: {
  client: GatewayClient | null | undefined;
  claim: RepositoryOperation;
  assertCurrent: () => void;
  hasCurrentClientAuthority?: () => boolean;
}): GitHubCredentialReader | undefined {
  if (!getRepositoryIntegration()) {
    return undefined;
  }
  const actor = captureRepositoryClientActor(params);
  let assertPolicyCurrent: (() => void) | undefined;
  const assertReaderCurrent = () => {
    actor.assertCurrent();
    assertPolicyCurrent?.();
  };
  const withAdmission = async (
    read?: (reader: GitHubCredentialReader) => Promise<string | undefined>,
  ) => {
    assertReaderCurrent();
    return await withRepositoryIdentity(
      actor,
      { claim: params.claim, assertCurrent: params.assertCurrent },
      async (_env, readCredential, assertCurrent) => {
        assertPolicyCurrent = assertCurrent;
        assertCurrent();
        const token = await read?.(readCredential);
        assertCurrent();
        return token;
      },
    );
  };
  const reader: GitHubCredentialReader = (env, admission) =>
    withAdmission((readCredential) => readCredential(env, admission));
  reader.admit = async () => {
    await withAdmission();
  };
  reader.assertCurrent = assertReaderCurrent;
  return reader;
}
