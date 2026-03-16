/**
 * ZK Handoff — zero-knowledge agent-to-agent handoff capsule
 *
 * Properties:
 *
 *   Completeness     — The receiving agent gets everything needed to continue.
 *   Zero-leakage     — The receiver learns nothing about the sender's secrets
 *                      (credentials, sibling session keys, raw tool outputs).
 *   Verifiability    — The receiver can verify the capsule is authentic and
 *                      the sender was legitimately authorised for the task.
 *   Replay-safety    — Each capsule carries a unique nonce; re-submission is
 *                      detected by the nonce registry.
 *
 * Cryptographic construction:
 *
 *   1. Capability proof
 *      HMAC-SHA256(gatewayKey,
 *        senderAgentId ‖ receiverAgentId ‖ taskHash ‖ handoffNonce ‖ issuedAt)
 *      Binds the handoff to an authentic gateway-issued capability.
 *
 *   2. Encrypted context capsule
 *      Key   = HKDF-SHA256(sharedSecret, salt=handoffNonce,
 *                           info="zk-handoff:context")
 *      Cipher = AES-256-GCM(key, iv=random-12-bytes, plaintext=contextJSON)
 *      sharedSecret = ECDH(senderPrivKey, receiverPubKey)
 *                   = SHA-256(senderAgentId ‖ receiverAgentId ‖ gatewayKey)
 *                     (simplified shared secret: no persistent key pairs
 *                     required, gateway key acts as trust root)
 *
 *   3. Commitment binding
 *      handoffHash = SHA-256(capabilityProof ‖ encryptedContext ‖ contextIv)
 *      Lets the receiver verify capsule integrity before decrypting.
 *
 *   4. Optional AccessProof attachment
 *      The HandoffCapsule may carry the sender's AccessProof so the receiver
 *      (or an auditor) can verify the sender operated within its policy.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { AccessProof } from "../infra/zk-agent-trust.js";
import { emitZkAuditEvent } from "../infra/zk-audit-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("zk-handoff");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal public context included in the unencrypted header of the capsule.
 * Intentionally sparse — enough to route/display, not enough to leak secrets.
 */
export interface HandoffPublicHeader {
  /** Generating agent. */
  senderAgentId: string;
  /** Intended recipient. */
  receiverAgentId: string;
  /** Hash of the task description (SHA-256 hex). Never the task text itself. */
  taskHash: string;
  /** Human-readable routing hint (safe to log — no PII). */
  taskLabel: string;
  /** Unix ms when this capsule was created. */
  issuedAt: number;
  /** Unix ms when this capsule expires (receiver must reject after this). */
  expiresAt: number;
  /** Unique per-handoff nonce (base64url, 32 bytes). */
  handoffNonce: string;
}

/**
 * The full handoff capsule that travels from sender to receiver.
 *
 * Public fields (header + capability proof) are safe to log/trace.
 * encryptedContext is ciphertext — opaque to anyone without the gateway key.
 */
export interface HandoffCapsule {
  header: HandoffPublicHeader;
  /**
   * HMAC capability proof binding this handoff to an authentic gateway policy.
   * Public: verifier uses it to confirm gateway endorsement.
   */
  capabilityProof: string;
  /**
   * AES-256-GCM ciphertext of the serialised HandoffContext.
   * base64url-encoded.
   */
  encryptedContext: string;
  /** AES-GCM IV (base64url, 12 bytes). */
  contextIv: string;
  /** AES-GCM auth tag (base64url, 16 bytes). */
  contextTag: string;
  /**
   * SHA-256(capabilityProof ‖ encryptedContext ‖ contextIv)
   * Lets receiver verify capsule integrity before decrypting.
   */
  handoffHash: string;
  /**
   * Optional: sender's AccessProof for auditors.
   * If present, verifiers can confirm the sender operated within its policy.
   */
  accessProof?: AccessProof;
}

/**
 * The plaintext carried inside the encrypted capsule.
 * This is what the receiving agent actually uses to continue the task.
 */
export interface HandoffContext {
  /** The task the receiver should continue. */
  task: string;
  /** Structured state the receiver needs (tool outputs, partial results, etc.). */
  state: unknown;
  /** Parent session key (for lineage, not for credential access). */
  parentSessionKey?: string;
  /** Which channels the sender had access to (channel IDs, not credentials). */
  authorizedChannelIds: string[];
  /** Which resource IDs were in the sender's policy (no values/creds). */
  authorizedResourceIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Capsule creation  (sender-side)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateHandoffParams {
  senderAgentId: string;
  receiverAgentId: string;
  task: string;
  taskLabel: string;
  state: unknown;
  parentSessionKey?: string;
  authorizedChannelIds: string[];
  authorizedResourceIds: string[];
  gatewayKey: Buffer;
  /** AccessProof from the sender session — attach for auditability. */
  accessProof?: AccessProof;
  ttlMs?: number; // default 5 minutes
}

/**
 * Create a zero-knowledge handoff capsule.
 * Only the sender and verifiers with the gateway key can read the context.
 */
export function createHandoffCapsule(params: CreateHandoffParams): HandoffCapsule {
  const {
    senderAgentId,
    receiverAgentId,
    task,
    taskLabel,
    state,
    parentSessionKey,
    authorizedChannelIds,
    authorizedResourceIds,
    gatewayKey,
    accessProof,
  } = params;

  const issuedAt = Date.now();
  const expiresAt = issuedAt + (params.ttlMs ?? 300_000);
  const handoffNonce = randomBytes(32).toString("base64url");
  const taskHash = createHash("sha256").update(task, "utf8").digest("hex");

  const header: HandoffPublicHeader = {
    senderAgentId,
    receiverAgentId,
    taskHash,
    taskLabel,
    issuedAt,
    expiresAt,
    handoffNonce,
  };

  // ── 1. Capability proof ──────────────────────────────────────────────────
  // expiresAt is bound into the MAC so an attacker cannot extend a capsule's
  // validity by modifying header.expiresAt without breaking the proof.
  const capabilityInput = Buffer.from(
    `${senderAgentId}:${receiverAgentId}:${taskHash}:${handoffNonce}:${issuedAt}:${expiresAt}`,
    "utf8",
  );
  const capabilityProof = createHmac("sha256", gatewayKey).update(capabilityInput).digest("hex");

  // ── 2. Derive encryption key ─────────────────────────────────────────────
  const encKey = deriveEncryptionKey(gatewayKey, senderAgentId, receiverAgentId, handoffNonce);

  // ── 3. Encrypt context ───────────────────────────────────────────────────
  const context: HandoffContext = {
    task,
    state,
    parentSessionKey,
    authorizedChannelIds,
    authorizedResourceIds,
  };
  const contextJson = JSON.stringify(context);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const encrypted = Buffer.concat([cipher.update(contextJson, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const encryptedContext = encrypted.toString("base64url");
  const contextIv = iv.toString("base64url");
  const contextTag = tag.toString("base64url");

  // ── 4. Capsule integrity hash ────────────────────────────────────────────
  // contextTag (AES-GCM auth tag) is included so all serialised capsule fields
  // are covered and the hash is a complete pre-decryption integrity check.
  const handoffHash = createHash("sha256")
    .update(capabilityProof, "hex")
    .update(encryptedContext, "utf8")
    .update(contextIv, "utf8")
    .update(contextTag, "utf8")
    .digest("hex");

  const capsule: HandoffCapsule = {
    header,
    capabilityProof,
    encryptedContext,
    contextIv,
    contextTag,
    handoffHash,
    accessProof,
  };

  emitZkAuditEvent({
    type: "zk.handoff.created",
    senderAgentId,
    receiverAgentId,
    taskHash,
    taskLabel,
    handoffNonce,
    hasAccessProof: accessProof !== undefined,
    expiresAt,
  });
  log.info(
    `handoff created sender=${senderAgentId} receiver=${receiverAgentId}` +
      ` task="${taskLabel}" nonce=${handoffNonce.slice(0, 12)}… hasProof=${accessProof !== undefined}`,
  );

  return capsule;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capsule verification + decryption  (receiver-side)
// ─────────────────────────────────────────────────────────────────────────────

export type VerifyHandoffResult =
  | { valid: true; context: HandoffContext }
  | { valid: false; reason: string };

/**
 * Verify and decrypt a HandoffCapsule.
 *
 * The receiver only needs the gateway key — no sender secrets required.
 * Returns the decrypted HandoffContext on success.
 */
export function receiveHandoffCapsule(
  capsule: HandoffCapsule,
  receiverAgentId: string,
  gatewayKey: Buffer,
): VerifyHandoffResult {
  const receiveStart = Date.now();
  const { header } = capsule;

  /** Emit a failure event and return the result. */
  const fail = (reason: string): VerifyHandoffResult => {
    const durationMs = Date.now() - receiveStart;
    emitZkAuditEvent({
      type: "zk.handoff.received",
      senderAgentId: header.senderAgentId,
      receiverAgentId,
      handoffNonce: header.handoffNonce,
      valid: false,
      reason,
      durationMs,
    });
    log.warn(
      `handoff rejected sender=${header.senderAgentId} receiver=${receiverAgentId}` +
        ` nonce=${header.handoffNonce.slice(0, 12)}… reason="${reason}" durationMs=${durationMs}`,
    );
    return { valid: false, reason };
  };

  // 1. Receiver ID check
  if (header.receiverAgentId !== receiverAgentId) {
    return fail("capsule not addressed to this agent");
  }

  // 2. Expiry check
  if (Date.now() > header.expiresAt) {
    return fail("handoff capsule has expired");
  }

  // 3. Capsule integrity hash (must match sealer: covers proof, ciphertext, iv, and tag)
  const expectedHash = createHash("sha256")
    .update(capsule.capabilityProof, "hex")
    .update(capsule.encryptedContext, "utf8")
    .update(capsule.contextIv, "utf8")
    .update(capsule.contextTag, "utf8")
    .digest("hex");
  if (!timingSafeCompare(capsule.handoffHash, expectedHash)) {
    return fail("handoff capsule integrity check failed");
  }

  // 4. Verify capability proof (expiresAt must be bound in to match the sealer)
  const capabilityInput = Buffer.from(
    `${header.senderAgentId}:${header.receiverAgentId}:${header.taskHash}:${header.handoffNonce}:${header.issuedAt}:${header.expiresAt}`,
    "utf8",
  );
  const expectedProof = createHmac("sha256", gatewayKey).update(capabilityInput).digest("hex");
  if (!timingSafeCompare(capsule.capabilityProof, expectedProof)) {
    return fail("capability proof MAC invalid — possible unauthorized sender");
  }

  // 5. Decrypt context
  const encKey = deriveEncryptionKey(
    gatewayKey,
    header.senderAgentId,
    header.receiverAgentId,
    header.handoffNonce,
  );
  try {
    const iv = Buffer.from(capsule.contextIv, "base64url");
    const tag = Buffer.from(capsule.contextTag, "base64url");
    const ciphertext = Buffer.from(capsule.encryptedContext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const context = JSON.parse(plaintext.toString("utf8")) as HandoffContext;

    const durationMs = Date.now() - receiveStart;
    emitZkAuditEvent({
      type: "zk.handoff.received",
      senderAgentId: header.senderAgentId,
      receiverAgentId,
      handoffNonce: header.handoffNonce,
      valid: true,
      durationMs,
    });
    log.info(
      `handoff accepted sender=${header.senderAgentId} receiver=${receiverAgentId}` +
        ` nonce=${header.handoffNonce.slice(0, 12)}… durationMs=${durationMs}`,
    );

    return { valid: true, context };
  } catch {
    return fail("context decryption failed — tampered ciphertext or wrong key");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Nonce registry  (replay protection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory nonce registry.
 * In production, back this with a short-lived persistent store
 * (Redis, SQLite, or the existing json-file.ts pattern).
 */
export class HandoffNonceRegistry {
  private readonly seen = new Map<string, number>(); // nonce → expiresAt
  private lastPruned = Date.now();

  /**
   * Check whether a nonce has been seen before.
   * Returns false (not replayed) and registers the nonce on first call.
   * Returns true (replayed) if the nonce was already seen.
   *
   * Pass `receiverAgentId` so a replay event can be emitted with full context.
   */
  checkAndRegister(nonce: string, expiresAt: number, receiverAgentId?: string): boolean {
    this.maybePrune();
    if (this.seen.has(nonce)) {
      emitZkAuditEvent({
        type: "zk.handoff.replay",
        handoffNonce: nonce,
        receiverAgentId: receiverAgentId ?? "unknown",
      });
      log.warn(
        `replay detected nonce=${nonce.slice(0, 12)}… receiver=${receiverAgentId ?? "unknown"}`,
      );
      return true; // replay detected
    }
    this.seen.set(nonce, expiresAt);
    return false;
  }

  /** Remove expired entries (called lazily). */
  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPruned < 60_000) {
      return;
    }
    for (const [nonce, exp] of this.seen) {
      if (now > exp) {
        this.seen.delete(nonce);
      }
    }
    this.lastPruned = now;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a 32-byte AES encryption key using HKDF-SHA256.
 * Inputs: gateway key (IKM), handoff nonce (salt), agent IDs (info).
 */
function deriveEncryptionKey(
  gatewayKey: Buffer,
  senderAgentId: string,
  receiverAgentId: string,
  handoffNonce: string,
): Buffer {
  const salt = Buffer.from(handoffNonce, "base64url");
  const info = Buffer.from(`zk-handoff:${senderAgentId}:${receiverAgentId}`, "utf8");
  return Buffer.from(hkdfSync("sha256", gatewayKey, salt, info, 32));
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
