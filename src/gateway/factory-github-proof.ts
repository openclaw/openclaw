import { createHash, randomBytes } from "node:crypto";
import { resolveGitHubHost, resolveGitHubApiBaseUrl } from "../agents/github-host-runtime.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
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
  requestDigest: string;
};
export type FactoryGitHubProofClaim = {
  purpose: "session-item-read";
  binding: SessionBinding;
};

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
  const principal = `github:${resolveGitHubHost()}:${actorId}`;
  const assertCurrent = () => {
    input.assertCurrent();
    if (
      client?.invalidated ||
      client?.connect.role !== "operator" ||
      (!client.connect.scopes?.includes("operator.write") &&
        !client.connect.scopes?.includes("operator.admin") &&
        !client.connect.scopes?.includes("operator.read")) ||
      !client.connId ||
      client.connectionSignal?.aborted ||
      client.internal?.authenticatedOperator !== true ||
      client.internal.syntheticClient ||
      client.internal.agentRuntimeIdentity ||
      client.internal.agentToolCaller ||
      client.authenticatedUserId !== principal ||
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

/** The issuer-bound immutable account comes from current catalog facts, never a login label. */
function factoryGitHubActorIdForProfile(emails: readonly string[], host: string): number {
  const matches = emails
    .map(parseEnterpriseGitHubPrincipal)
    .filter((value) => value?.host === host);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error("GitHub actor binding is unavailable or ambiguous.");
  }
  return matches[0].accountId;
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
    actorPrincipal: `github:${resolveGitHubHost()}:${input.actorId}`,
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
    actorId: number;
    profileId: string;
    claim: FactoryGitHubProofClaim;
    assertCurrent: () => void;
  },
  run: (env: NodeJS.ProcessEnv, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  input.assertCurrent();
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const profile = captureResidentUserProfileAccess(input.profileId);
  let issued: ReturnType<typeof issueFactoryGitHubProof> | undefined;
  try {
    input.assertCurrent();
    const actorId = factoryGitHubActorIdForProfile(profile.readCurrentFacts().emails, host);
    if (actorId !== input.actorId) {
      throw new Error("Factory GitHub actor profile changed.");
    }
    const assertCurrent = () => {
      input.assertCurrent();
      if (
        factoryGitHubActorIdForProfile(profile.readCurrentFacts().emails, host) !== actorId ||
        resolveGitHubHost() !== host ||
        resolveGitHubApiBaseUrl() !== apiBaseUrl
      ) {
        throw new Error("Factory GitHub actor or issuer changed.");
      }
    };
    const sessionKey = input.claim.binding.sessionKey;
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
    const result = await run(env, assertCurrent);
    assertCurrent();
    if (!issued.wasRedeemed()) {
      throw new Error("Factory GitHub broker did not authorize this credential lookup.");
    }
    return result;
  } finally {
    issued?.release();
  }
}
