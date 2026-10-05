import { createHash, randomBytes } from "node:crypto";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { GitHubRepositoryAdmissionRequest } from "../agents/github-credential-reader.js";
import { resolveGitHubHost, resolveGitHubApiBaseUrl } from "../agents/github-host-runtime.js";
import {
  GitHubCredentialLookupError,
  readNativeGitHubToken,
} from "../agents/github-read-identity.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";
import type { GatewayClient } from "./server-methods/client-types.js";

const AUDIENCE = "lobster.github.system-token" as const;
const PROOF_LIFETIME_MS = 60_000;
const MAX_PENDING_PROOFS = 128;
export const FACTORY_GITHUB_PROOF_ENV = "OPENCLAW_FACTORY_GITHUB_PROOF";

type SessionBinding = {
  kind: "session";
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  requestDigest?: string;
};
type PublicationBinding = {
  kind: "publication";
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  executionKind: "worktree" | "repository";
  requestId: string;
  ownerId: string;
  requestDigest: string;
};
type ConnectionBinding = { kind: "connection"; connectionId: string; requestDigest: string };
type SessionCreateBinding = {
  kind: "session-create";
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  requestDigest: string;
};
type SessionDispatchBinding = {
  kind: "session-dispatch";
  agentId: string;
  sessionKey: string;
  sessionId: string;
  requestDigest: string;
};

export type FactoryGitHubProofClaim =
  | { purpose: "publication-preflight"; binding: SessionBinding }
  | { purpose: "session-issue-read"; binding: SessionBinding & { requestDigest: string } }
  | { purpose: "session-item-read"; binding: SessionBinding & { requestDigest: string } }
  | { purpose: "publication-execution"; binding: PublicationBinding }
  | { purpose: "project-add" | "project-search"; binding: ConnectionBinding }
  | { purpose: "session-create-project"; binding: SessionCreateBinding }
  | { purpose: "session-dispatch-project"; binding: SessionDispatchBinding };

export type FactoryGitHubProofVerdict = FactoryGitHubProofClaim & {
  version: 1;
  audience: typeof AUDIENCE;
  actorId: number;
  actorPrincipal: string;
  profileId: string;
};

export function factoryGitHubRequestDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Capture only handshake-authenticated Factory identity, never a request field. */
export function factoryGitHubClientProof(input: {
  client: GatewayClient | null | undefined;
  claim: FactoryGitHubProofClaim;
  assertCurrent: () => void;
}): Parameters<typeof issueFactoryGitHubProof>[0] {
  const client = input.client;
  const actorId = client?.authenticatedFactoryGitHubAccountId;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const readOnly = input.claim.purpose === "session-item-read";
  const assertCurrent = () => {
    input.assertCurrent();
    if (
      client?.invalidated ||
      client?.connect.role !== "operator" ||
      (!client.connect.scopes?.includes("operator.write") &&
        !client.connect.scopes?.includes("operator.admin") &&
        !(readOnly && client.connect.scopes?.includes("operator.read"))) ||
      (readOnly &&
        (!client.connId ||
          client.connectionSignal?.aborted ||
          client.internal?.authenticatedOperator !== true ||
          client.internal.syntheticClient ||
          client.internal.agentRuntimeIdentity ||
          client.internal.agentToolCaller)) ||
      client.authenticatedFactoryGitHubAccountId !== actorId ||
      client.authenticatedUserProfile?.profileId !== profileId
    ) {
      throw new Error("Factory GitHub caller authority changed.");
    }
  };
  assertCurrent();
  if (!actorId || !profileId) {
    throw new Error("Factory GitHub requires a verified actor profile.");
  }
  return { actorId, profileId, claim: input.claim, assertCurrent };
}

type PendingProof = {
  verdict: FactoryGitHubProofVerdict;
  expiresAtMs: number;
  assertCurrent: () => void;
  redeemed: boolean;
};

const pending = new Map<string, PendingProof>();

/** The verified profile's unique GHE link is the immutable actor, never a login label. */
function factoryGitHubActorIdForProfile(
  profile: PreparedUserProfileIdentity,
  bindingIds: readonly string[] = profile.emailBindingIds,
): number {
  const matches = profile
    .readCurrentFacts(bindingIds)
    .profile.emails.map((alias) => /^github:microsoft\.ghe\.com:([1-9]\d*)$/.exec(alias)?.[1])
    .filter((id): id is string => Boolean(id));
  const actorId = Number(matches[0]);
  if (matches.length !== 1 || !Number.isSafeInteger(actorId) || actorId <= 0) {
    throw new Error("GitHub actor binding is unavailable or ambiguous.");
  }
  return actorId;
}

function pruneExpired(now: number): void {
  for (const [proof, record] of pending) {
    if (record.expiresAtMs <= now) {
      pending.delete(proof);
    }
  }
}

export function issueFactoryGitHubProof(input: {
  actorId: number;
  profileId: string;
  claim: FactoryGitHubProofClaim;
  assertCurrent: () => void;
}): { proof: string; release: () => void; wasRedeemed: () => boolean } {
  input.assertCurrent();
  if (!Number.isSafeInteger(input.actorId) || input.actorId <= 0 || !input.profileId) {
    throw new Error("GitHub proof actor is invalid.");
  }
  const now = Date.now();
  pruneExpired(now);
  if (pending.size >= MAX_PENDING_PROOFS) {
    throw new Error("GitHub proof admission is busy; retry publication shortly.");
  }
  const proof = randomBytes(32).toString("base64url");
  const claim = Object.freeze(input.claim);
  Object.freeze(claim.binding);
  const verdict: FactoryGitHubProofVerdict = Object.freeze({
    ...claim,
    version: 1,
    audience: AUDIENCE,
    actorId: input.actorId,
    actorPrincipal: `github:microsoft.ghe.com:${input.actorId}`,
    profileId: input.profileId,
  });
  input.assertCurrent();
  const record: PendingProof = {
    verdict,
    expiresAtMs: now + PROOF_LIFETIME_MS,
    assertCurrent: input.assertCurrent,
    redeemed: false,
  };
  pending.set(proof, record);
  return {
    proof,
    release: () => pending.delete(proof),
    wasRedeemed: () => record.redeemed,
  };
}

/** Consume before checking authority so even a failed or racing redemption cannot replay. */
export function redeemFactoryGitHubProof(proof: string): FactoryGitHubProofVerdict {
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) {
    throw new Error("GitHub proof is invalid.");
  }
  const record = pending.get(proof);
  pending.delete(proof);
  if (!record || record.expiresAtMs <= Date.now()) {
    throw new Error("GitHub proof is unavailable or expired.");
  }
  record.assertCurrent();
  record.redeemed = true;
  return record.verdict;
}

/** Retain original caller, profile bindings and issuer through one broker-owned operation. */
export async function withFactoryGitHubProof<T>(
  input: {
    env?: NodeJS.ProcessEnv;
    actorId?: number;
    profileId: string;
    claim: FactoryGitHubProofClaim;
    assertCurrent: () => void;
  },
  run: (env: NodeJS.ProcessEnv, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  input.assertCurrent();
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const profile = await prepareUserProfileIdentity(input.profileId);
  let issued: ReturnType<typeof issueFactoryGitHubProof> | undefined;
  try {
    input.assertCurrent();
    const bindingIds = profile.emailBindingIds;
    const actorId = factoryGitHubActorIdForProfile(profile, bindingIds);
    if (input.actorId !== undefined && actorId !== input.actorId) {
      throw new Error("Factory GitHub actor profile changed.");
    }
    const assertCurrent = () => {
      input.assertCurrent();
      if (
        factoryGitHubActorIdForProfile(profile, bindingIds) !== actorId ||
        resolveGitHubHost() !== host ||
        resolveGitHubApiBaseUrl() !== apiBaseUrl
      ) {
        throw new Error("Factory GitHub actor or issuer changed.");
      }
    };
    const sessionKey =
      input.claim.binding.kind === "connection"
        ? input.claim.binding.connectionId
        : input.claim.binding.sessionKey;
    if (!sessionKey) {
      throw new Error("Factory GitHub session binding is unavailable.");
    }
    issued = issueFactoryGitHubProof({
      actorId,
      profileId: input.profileId,
      claim: input.claim,
      assertCurrent,
    });
    const env = {
      ...(input.env ?? process.env),
      GH_TOKEN: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
      OPENCLAW_FACTORY_ACTOR_ID: String(actorId),
      OPENCLAW_FACTORY_SESSION_KEY: sessionKey,
      [FACTORY_GITHUB_PROOF_ENV]: issued.proof,
    };
    assertCurrent();
    const result = await run(env, assertCurrent).catch((error: unknown) => {
      assertCurrent();
      // A wrapper frame is diagnostic data; only this exact redeemed proof
      // establishes that the broker handled the original authorized lookup.
      if (error instanceof GitHubCredentialLookupError && !issued?.wasRedeemed()) {
        throw new Error("Factory GitHub broker did not authorize this credential lookup.", {
          cause: error,
        });
      }
      throw error;
    });
    assertCurrent();
    if (!issued.wasRedeemed()) {
      throw new Error("Factory GitHub broker did not authorize this credential lookup.");
    }
    return result;
  } finally {
    issued?.release();
    profile.release();
  }
}

/** Only the exact native gh credential lookup receives the one-use proof. */
export async function readFactoryGitHubToken(
  env: NodeJS.ProcessEnv,
  input: Parameters<typeof issueFactoryGitHubProof>[0],
  admission?: GitHubRepositoryAdmissionRequest,
): Promise<string | undefined> {
  return await withFactoryGitHubProof({ ...input, env }, async (proofEnv, assertCurrent) => {
    assertCurrent();
    if (admission) {
      await readFactoryRepositoryAdmission({
        env: proofEnv,
        request: admission,
        claim: input.claim,
        profileId: input.profileId,
        assertCurrent,
      });
      return undefined;
    }
    const token = await readNativeGitHubToken(proofEnv, false, resolveGitHubHost());
    assertCurrent();
    if (!token) {
      throw new Error("Factory GitHub broker did not authorize this credential lookup.");
    }
    return token;
  });
}

/** Give repository admission an actor-bound credential reader for this dispatch only. */
export function factoryGitHubDispatchCredentialReader(
  params: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    repositoryUrl?: string;
    assertCurrent: () => void;
  } & (
    | { client: GatewayClient | null | undefined; issuerAuthority?: never }
    | { client?: never; issuerAuthority: AdmittedRunOperatorAuthority }
  ),
): import("../agents/github-credential-reader.js").GitHubCredentialReader | undefined {
  const repositoryUrl = params.repositoryUrl;
  if (process.env.FACTORY_AUTH_MODE !== "github" || !repositoryUrl) {
    return undefined;
  }
  const claim: FactoryGitHubProofClaim = {
    purpose: "session-dispatch-project",
    binding: {
      kind: "session-dispatch",
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      requestDigest: factoryGitHubRequestDigest(repositoryUrl),
    },
  };
  const authority = params.issuerAuthority;
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    const assertCurrent = () => {
      params.assertCurrent();
      authority.assertCurrent();
      if (
        !authority.scopes.includes("operator.write") &&
        !authority.scopes.includes("operator.admin")
      ) {
        throw new Error("Factory GitHub dispatch requires operator write authority");
      }
    };
    assertCurrent();
    const basis = authority.captureRestartRecoveryIssuer?.();
    const actor = basis?.factoryActor;
    if (
      !actor ||
      actor.host !== "microsoft.ghe.com" ||
      !Number.isSafeInteger(actor.accountId) ||
      actor.accountId <= 0 ||
      basis?.profileId !== authority.profileId
    ) {
      throw new Error("Verified original Factory actor is unavailable");
    }
    const actorId = actor.accountId;
    const profileId = authority.profileId;
    return (env, admission) =>
      readFactoryGitHubToken(env, { actorId, profileId, claim, assertCurrent }, admission);
  }
  return (env, admission) =>
    readFactoryGitHubToken(
      env,
      factoryGitHubClientProof({
        client: params.client,
        claim,
        assertCurrent: params.assertCurrent,
      }),
      admission,
    );
}
