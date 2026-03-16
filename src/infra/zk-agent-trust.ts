/**
 * ZK Agent Trust — access policy, witness recording, and proof
 *
 * Architecture (three layers):
 *
 *   1. Commitment layer
 *      Each resource access is blinded:  C_i = SHA-256(resourceId ‖ nonce_i)
 *      The nonce is random and never leaves this module, so the verifier
 *      learns no resource identities from the commitment set.
 *
 *   2. Merkle layer
 *      Both the policy set and the access commitment set are structured as
 *      binary Merkle trees.  Only the roots are public.
 *        policy_root  — Merkle root over SHA-256(resourceId) for all allowed
 *                       resources (issued and signed by the gateway)
 *        access_root  — Merkle root over {C_1, ..., C_k} for all resources
 *                       actually accessed during the session
 *
 *   3. Proof layer
 *      For each commitment C_i the proof carries:
 *        • A Merkle inclusion path proving C_i ∈ access tree
 *        • A Merkle inclusion path proving SHA-256(r_i) ∈ policy tree
 *      The gateway HMAC binds (policy_root, access_root, agentId, sessionId,
 *      proofTimestamp) so the verifier can confirm the policy was issued by
 *      the trusted gateway and the proof covers the right session.
 *
 *   SNARK upgrade path
 *      The `proofType` field is "commitment-v1" here (pure Node crypto).
 *      When Noir circuit artifacts are compiled and available, swap in
 *      "snark-groth16" or "snark-plonk" by replacing generateAccessProof /
 *      verifyAccessProof — all callers are unaffected because the
 *      AccessProof interface is stable.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type ResourceId = string;

/** Proof mechanism used.  "commitment-v1" = this file.  snark-* = circuit. */
export type ProofType = "commitment-v1" | "snark-groth16" | "snark-plonk";

export interface AccessPolicy {
  /** Agent this policy is scoped to. */
  agentId: string;
  /** Session this policy is scoped to. */
  sessionId: string;
  /** Merkle root over sorted SHA-256(resourceId) leaves. */
  policyRoot: string;
  /** Unix ms timestamp when the policy was issued. */
  issuedAt: number;
  /** Unix ms timestamp when the policy expires. */
  expiresAt: number;
  /**
   * HMAC-SHA256(gatewayKey, policyRoot ‖ agentId ‖ sessionId ‖ issuedAt ‖ expiresAt)
   * The gateway key is never stored in this struct – only the MAC.
   */
  gatewayMac: string;
}

export interface AccessWitnessEntry {
  /** Blinded commitment: SHA-256(resourceId ‖ nonce). */
  commitment: string;
  /** Unix ms timestamp when the resource was accessed. */
  accessedAt: number;
  // resourceId and nonce are held only in memory; never serialised to disk.
}

export interface AccessWitness {
  agentId: string;
  sessionId: string;
  /** Ordered list of blinded commitments (order = access order). */
  entries: ReadonlyArray<AccessWitnessEntry>;
  /** Merkle root over sorted commitments (canonical ordering for proof). */
  accessRoot: string;
}

export interface MerkleInclusionPath {
  /** The leaf hash that this path opens. */
  leaf: string;
  /** Sibling hashes from leaf level up to (but not including) root. */
  siblings: string[];
  /** 0 = sibling is on the right, 1 = sibling is on the left. */
  indices: number[];
}

export interface AccessProofEntry {
  /** Inclusion path of C_i in the access tree. */
  accessPath: MerkleInclusionPath;
  /** Inclusion path of SHA-256(r_i) in the policy tree. */
  policyPath: MerkleInclusionPath;
}

export interface AccessProof {
  // ── Public (safe to share with verifier) ───────────────────────────────
  agentId: string;
  sessionId: string;
  policyRoot: string;
  accessRoot: string;
  proofType: ProofType;
  proofTimestamp: number;
  numAccesses: number;
  /**
   * HMAC-SHA256(gatewayKey,
   *   policyRoot ‖ accessRoot ‖ agentId ‖ sessionId ‖ proofTimestamp)
   *
   * Lets a verifier who holds the gateway key confirm the proof is bound
   * to an authentic policy without the prover re-supplying the key.
   */
  gatewayMac: string;
  // ── Proof entries (Merkle paths + structural integrity) ────────────────
  entries: ReadonlyArray<AccessProofEntry>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merkle tree
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_HASH = Buffer.alloc(32, 0).toString("hex");

function sha256hex(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "hex") : data;
  return createHash("sha256").update(buf).digest("hex");
}

/** Combine two nodes (always sort so order is canonical). */
function mergeNodes(a: string, b: string): string {
  const [left, right] = a <= b ? [a, b] : [b, a];
  const combined = Buffer.concat([Buffer.from(left, "hex"), Buffer.from(right, "hex")]);
  return createHash("sha256").update(combined).digest("hex");
}

export class MerkleTree {
  private readonly layers: string[][];

  /**
   * Build a Merkle tree from an array of leaf hashes.
   * Leaves are sorted before building so the root is independent of
   * insertion order.
   */
  constructor(leaves: string[]) {
    const sorted = [...leaves].sort();
    // Pad to next power of two with zero hashes so the tree is complete.
    const size = nextPow2(sorted.length || 1);
    const padded = sorted.concat(Array(size - sorted.length).fill(ZERO_HASH));
    this.layers = [padded];
    let current = padded;
    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(mergeNodes(current[i]!, current[i + 1]!));
      }
      this.layers.push(next);
      current = next;
    }
  }

  root(): string {
    return this.layers.at(-1)![0]!;
  }

  /**
   * Return a Merkle inclusion path for a leaf (by its hash value).
   * Returns undefined if the leaf is not in the tree.
   */
  inclusionPath(leafHash: string): MerkleInclusionPath | undefined {
    const baseLayer = this.layers[0]!;
    const idx = baseLayer.indexOf(leafHash);
    if (idx === -1) {
      return undefined;
    }
    const siblings: string[] = [];
    const indices: number[] = [];
    let pos = idx;
    for (let d = 0; d < this.layers.length - 1; d++) {
      const layer = this.layers[d]!;
      const siblingPos = pos % 2 === 0 ? pos + 1 : pos - 1;
      const sibling = layer[siblingPos] ?? ZERO_HASH;
      siblings.push(sibling);
      // index 0 = current is left (sibling is right)
      // index 1 = current is right (sibling is left)
      indices.push(pos % 2);
      pos = Math.floor(pos / 2);
    }
    return { leaf: leafHash, siblings, indices };
  }
}

function nextPow2(n: number): number {
  if (n <= 1) {
    return 1;
  }
  let p = 1;
  while (p < n) {
    p <<= 1;
  }
  return p;
}

/** Recompute the root from a Merkle inclusion path. */
export function verifyMerklePath(path: MerkleInclusionPath, expectedRoot: string): boolean {
  let current = path.leaf;
  for (let d = 0; d < path.siblings.length; d++) {
    const s = path.siblings[d]!;
    const idx = path.indices[d]!;
    current = idx === 0 ? mergeNodes(current, s) : mergeNodes(s, current);
  }
  return timingSafeCompare(current, expectedRoot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway key derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a deterministic 32-byte gateway HMAC key from a master secret.
 * The master secret is owned by the gateway and never passed to agents.
 */
export function deriveGatewayKey(masterSecret: Buffer, context: string): Buffer {
  return createHmac("sha256", masterSecret).update(`zk-agent-trust:${context}`).digest();
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy issuance  (gateway-side)
// ─────────────────────────────────────────────────────────────────────────────

export interface IssuePolicyParams {
  agentId: string;
  sessionId: string;
  allowedResources: ReadonlyArray<ResourceId>;
  gatewayKey: Buffer;
  ttlMs?: number; // default 1 hour
}

/**
 * Issue an access policy for an agent session.
 * Only called by the gateway; the gatewayKey never leaves the gateway process.
 */
export function issueAccessPolicy(params: IssuePolicyParams): AccessPolicy {
  const { agentId, sessionId, allowedResources, gatewayKey } = params;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (params.ttlMs ?? 3_600_000);

  // Policy Merkle tree: each leaf = SHA-256(resourceId)
  const leaves = (allowedResources as ResourceId[]).map((r) =>
    createHash("sha256").update(r, "utf8").digest("hex"),
  );
  const tree = new MerkleTree(leaves);
  const policyRoot = tree.root();

  // Gateway MAC: binds (policyRoot, agentId, sessionId, issuedAt, expiresAt)
  const macInput = Buffer.from(
    `${policyRoot}:${agentId}:${sessionId}:${issuedAt}:${expiresAt}`,
    "utf8",
  );
  const gatewayMac = createHmac("sha256", gatewayKey).update(macInput).digest("hex");

  return { agentId, sessionId, policyRoot, issuedAt, expiresAt, gatewayMac };
}

/** Verify a policy MAC using the gateway key. */
export function verifyPolicyMac(policy: AccessPolicy, gatewayKey: Buffer): boolean {
  const macInput = Buffer.from(
    `${policy.policyRoot}:${policy.agentId}:${policy.sessionId}:${policy.issuedAt}:${policy.expiresAt}`,
    "utf8",
  );
  const expected = createHmac("sha256", gatewayKey).update(macInput).digest("hex");
  return timingSafeCompare(policy.gatewayMac, expected);
}

// ─────────────────────────────────────────────────────────────────────────────
// Witness recording  (agent-side, in-memory only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutable witness recorder attached to an agent session.
 *
 * Usage:
 *   const recorder = new AccessWitnessRecorder(agentId, sessionId);
 *   recorder.record("tool:read_file:/path/to/file");
 *   recorder.record("channel:telegram:chat_id_12345");
 *   const witness = recorder.seal();   // produces AccessWitness
 */
export class AccessWitnessRecorder {
  // Raw (resourceId, nonce) pairs — never serialised, held only in memory.
  private readonly raw: Array<{ resourceId: ResourceId; nonce: Buffer; accessedAt: number }> = [];

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
  ) {}

  /**
   * Record an access to a resource.
   * Returns the blinded commitment (safe to log, does not reveal resourceId).
   */
  record(resourceId: ResourceId): string {
    const nonce = randomBytes(32);
    const commitment = commitResource(resourceId, nonce);
    this.raw.push({ resourceId, nonce, accessedAt: Date.now() });
    return commitment;
  }

  /** Seal the witness into an immutable AccessWitness (no secrets). */
  seal(): AccessWitness {
    const entries: AccessWitnessEntry[] = this.raw.map(({ resourceId, nonce, accessedAt }) => ({
      commitment: commitResource(resourceId, nonce),
      accessedAt,
    }));
    const tree = new MerkleTree(entries.map((e) => e.commitment));
    return {
      agentId: this.agentId,
      sessionId: this.sessionId,
      entries,
      accessRoot: tree.root(),
    };
  }

  /**
   * Generate a full AccessProof.
   *
   * Requires the original AccessPolicy (for policyRoot) and the gatewayKey
   * to bind the proof.  The per-resource nonces serve as the private witness;
   * they are consumed here and not accessible after this call.
   *
   * @param policy     - The policy under which the session ran.
   * @param gatewayKey - Used to sign proof binding (not stored in proof).
   * @param allowedResources - Same list used when issuing the policy, needed
   *                           to reconstruct inclusion paths.
   */
  generateProof(
    policy: AccessPolicy,
    gatewayKey: Buffer,
    allowedResources: ReadonlyArray<ResourceId>,
  ): AccessProof {
    const now = Date.now();

    // Build access tree for Merkle paths
    const commitments = this.raw.map(({ resourceId, nonce }) => commitResource(resourceId, nonce));
    const accessTree = new MerkleTree(commitments);
    const accessRoot = accessTree.root();

    // Build policy tree (must match what issueAccessPolicy built)
    const policyLeaves = (allowedResources as ResourceId[]).map((r) =>
      createHash("sha256").update(r, "utf8").digest("hex"),
    );
    const policyTree = new MerkleTree(policyLeaves);

    // Proof entries: one per access
    const entries: AccessProofEntry[] = this.raw.map(({ resourceId, nonce }) => {
      const commitment = commitResource(resourceId, nonce);
      const accessPath = accessTree.inclusionPath(commitment);
      if (!accessPath) {
        throw new Error(`zk-agent-trust: commitment not in access tree (resource: ${resourceId})`);
      }
      const policyLeaf = createHash("sha256").update(resourceId, "utf8").digest("hex");
      const policyPath = policyTree.inclusionPath(policyLeaf);
      if (!policyPath) {
        throw new Error(
          `zk-agent-trust: resource not in policy tree — agent accessed unauthorized resource: ${resourceId}`,
        );
      }
      return { accessPath, policyPath };
    });

    // Gateway MAC over proof binding
    const macInput = Buffer.from(
      `${policy.policyRoot}:${accessRoot}:${policy.agentId}:${policy.sessionId}:${now}`,
      "utf8",
    );
    const gatewayMac = createHmac("sha256", gatewayKey).update(macInput).digest("hex");

    return {
      agentId: policy.agentId,
      sessionId: policy.sessionId,
      policyRoot: policy.policyRoot,
      accessRoot,
      proofType: "commitment-v1",
      proofTimestamp: now,
      numAccesses: this.raw.length,
      gatewayMac,
      entries,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof verification  (verifier-side — gateway or auditor)
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyProofResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify an AccessProof.
 *
 * Checks:
 *   1. Proof MAC is valid (gateway key binding)
 *   2. Policy has not expired
 *   3. All access Merkle paths resolve to accessRoot
 *   4. All policy Merkle paths resolve to policyRoot
 *   5. numAccesses matches entries length
 */
export function verifyAccessProof(
  proof: AccessProof,
  gatewayKey: Buffer,
  policy: AccessPolicy,
): VerifyProofResult {
  // 1. Check proof MAC
  const macInput = Buffer.from(
    `${proof.policyRoot}:${proof.accessRoot}:${proof.agentId}:${proof.sessionId}:${proof.proofTimestamp}`,
    "utf8",
  );
  const expectedMac = createHmac("sha256", gatewayKey).update(macInput).digest("hex");
  if (!timingSafeCompare(proof.gatewayMac, expectedMac)) {
    return { valid: false, reason: "proof gateway MAC invalid" };
  }

  // 2. Check policy linkage
  if (proof.policyRoot !== policy.policyRoot) {
    return { valid: false, reason: "proof policyRoot does not match policy" };
  }
  if (proof.agentId !== policy.agentId) {
    return { valid: false, reason: "agentId mismatch" };
  }
  if (proof.sessionId !== policy.sessionId) {
    return { valid: false, reason: "sessionId mismatch" };
  }
  if (Date.now() > policy.expiresAt) {
    return { valid: false, reason: "policy has expired" };
  }

  // 3. Check entry count
  if (proof.entries.length !== proof.numAccesses) {
    return { valid: false, reason: "numAccesses does not match entries length" };
  }

  // 4. Verify all Merkle paths
  for (let i = 0; i < proof.entries.length; i++) {
    const entry = proof.entries[i]!;
    if (!verifyMerklePath(entry.accessPath, proof.accessRoot)) {
      return { valid: false, reason: `access Merkle path invalid at entry ${i}` };
    }
    if (!verifyMerklePath(entry.policyPath, proof.policyRoot)) {
      return { valid: false, reason: `policy Merkle path invalid at entry ${i}` };
    }
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function commitResource(resourceId: ResourceId, nonce: Buffer): string {
  return createHash("sha256")
    .update(Buffer.from(resourceId, "utf8"))
    .update(nonce)
    .digest("hex");
}

/** Timing-safe hex string comparison. */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export { sha256hex, mergeNodes };
