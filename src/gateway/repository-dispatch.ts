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

/** Capture host-authenticated operator authority; no wire metadata can create this handle. */
function captureRepositoryClientActor(input: {
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
    sessionKey: input.claim.binding.sessionKey,
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
const chatDispatchAdmission = new AsyncLocalStorage<ChatDispatchAdmission>();

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
