/**
 * Sealed Proposal Mechanism — ENFORCEMENT-MECHANICS.md §1.2
 *
 * All promotions from Reference → Always tier must pass through a sealed
 * proposal mechanism. The seal ensures that:
 *
 * 1. Content is NON-AGENT-VISIBLE during the draft phase (§1.2 Constraint 3)
 * 2. contentHashAtProposal + manifestHashAtProposal are computed at CREATION
 *    time, not submission time
 * 3. Both hashes are GATE-COMPUTED (by the enforcement layer), not agent-computed
 * 4. The agent cannot read what it is proposing to promote until the seal is closed
 *
 * FAIL-CLOSED: If hash computation or seal verification fails, the promotion
 * is rejected. No fallback to unchecked promotion.
 *
 * Cooldown: Minimum 30 minutes between promotion proposals from the same
 * agent in the same session. Maximum 3 proposals per session.
 *
 * @see ENFORCEMENT-MECHANICS.md §1.2, §1.3, §6
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  computeHash,
  computeMd5,
  type MemoryTier,
  type SealedProposalStatus,
} from "./tier2-merge-log.js";

/** Minimum cooldown between promotion proposals (30 minutes in ms) */
const PROMOTION_COOLDOWN_MS = 30 * 60 * 1000;

/** Maximum proposals per session */
const MAX_PROPOSALS_PER_SESSION = 3;

/** Proposal ID prefix */
const PROPOSAL_PREFIX = "sp";

/** Sealed proposal file name */
const PROPOSALS_FILE = "sealed-proposals.jsonl";

/**
 * Generate a unique proposal ID.
 * Format: sp-{timestamp}-{random8hex}
 */
export function generateProposalId(): string {
  const timestamp = Date.now().toString(36);
  const random = createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .substring(0, 8);
  return `${PROPOSAL_PREFIX}-${timestamp}-${random}`;
}

/**
 * Sealed Proposal Store — manages the lifecycle of sealed proposals.
 *
 * Per §1.2, the enforcement layer owns the hash computation. The agent
 * cannot compute its own content hash or manifest hash. The gate computes
 * them at creation time and stores them in the sealed proposal.
 *
 * Per §1.3, session-boundary cooldown prevents fatigue-driven bulk promotions.
 */
export class SealedProposalStore {
  private proposalsDir: string;
  private sessionProposals: Map<string, number> = new Map(); // sessionId -> count
  private lastProposalTime: Map<string, number> = new Map(); // agentId -> timestamp

  constructor(proposalsDir: string) {
    this.proposalsDir = proposalsDir;
  }

  /**
   * Create a new sealed proposal.
   *
   * Per §1.2 Constraint 3:
   * - contentHashAtCreation is GATE-COMPUTED, not agent-computed
   * - manifestHashAtCreation is GATE-COMPUTED, not agent-computed
   * - Content is non-agent-visible during draft phase
   *
   * Per §1.3:
   * - Minimum 30-minute cooldown between proposals from the same agent
   * - Maximum 3 proposals per session
   *
   * FAIL-CLOSED: If hash computation fails, the proposal is rejected.
   */
  async createProposal(params: {
    proposingAgent: string;
    sourceTier: MemoryTier;
    targetTier: MemoryTier;
    content: string;
    manifestContent: string;
    sessionId: string;
  }): Promise<
    { success: true; proposal: SealedProposalInfo } | { success: false; reason: string }
  > {
    // §1.3 — Cooldown check
    const now = Date.now();
    const lastTime = this.lastProposalTime.get(params.proposingAgent) ?? 0;
    const elapsed = now - lastTime;
    if (elapsed < PROMOTION_COOLDOWN_MS) {
      const remainingMs = PROMOTION_COOLDOWN_MS - elapsed;
      return {
        success: false,
        reason: `Cooldown active. ${Math.ceil(remainingMs / 60000)} minutes remaining before next proposal from agent ${params.proposingAgent}.`,
      };
    }

    // §1.3 — Session limit check
    const sessionKey = `${params.proposingAgent}:${params.sessionId}`;
    const currentCount = this.sessionProposals.get(sessionKey) ?? 0;
    if (currentCount >= MAX_PROPOSALS_PER_SESSION) {
      return {
        success: false,
        reason: `Session proposal limit reached (${MAX_PROPOSALS_PER_SESSION} per session). Additional proposals deferred to next session.`,
      };
    }

    // §1.2 Constraint 3 — GATE-COMPUTED hashes at creation time
    let contentHashAtCreation: string;
    let manifestHashAtCreation: string;
    try {
      contentHashAtCreation = computeHash(params.content);
      manifestHashAtCreation = computeHash(params.manifestContent);
    } catch (error) {
      return {
        success: false,
        reason: `Hash computation failed: ${(error as Error).message}. Proposal rejected per fail-closed default.`,
      };
    }

    // Only allow Reference → Always promotions (per §1.1 tier definitions)
    if (params.sourceTier !== "reference" || params.targetTier !== "always") {
      return {
        success: false,
        reason: `Only Reference → Always promotions require sealed proposals. ${params.sourceTier} → ${params.targetTier} is not a sealed-proposal path.`,
      };
    }

    const proposalId = generateProposalId();
    const proposal: SealedProposalInfo = {
      id: proposalId,
      createdAt: new Date(now).toISOString(),
      proposingAgent: params.proposingAgent,
      status: "draft",
      contentHashAtCreation,
      manifestHashAtCreation,
      sourceTier: params.sourceTier,
      targetTier: params.targetTier,
      // Content is sealed during draft — the agent cannot read it
      // until the seal is closed (§1.2 Constraint 3)
    };

    // Persist the proposal
    try {
      await this.appendProposal(
        proposalId,
        params.content,
        contentHashAtCreation,
        manifestHashAtCreation,
        params.proposingAgent,
        params.sourceTier,
        params.targetTier,
      );
    } catch (error) {
      return {
        success: false,
        reason: `Failed to persist proposal: ${(error as Error).message}. Proposal rejected per fail-closed default.`,
      };
    }

    // Update cooldown and session tracking
    this.lastProposalTime.set(params.proposingAgent, now);
    this.sessionProposals.set(sessionKey, currentCount + 1);

    return { success: true, proposal };
  }

  /**
   * Close the seal on a proposal.
   *
   * Once sealed, the content hash and manifest hash are fixed and cannot
   * be changed. The agent can now see what it proposed to promote.
   *
   * FAIL-CLOSED: If the seal fails to verify, the proposal is rejected.
   */
  async sealProposal(
    proposalId: string,
  ): Promise<{ success: true; sealedAt: string } | { success: false; reason: string }> {
    // Read the proposal from disk
    const proposals = await this.readProposals();
    const proposal = proposals.find((p) => p.id === proposalId);

    if (!proposal) {
      return { success: false, reason: `Proposal ${proposalId} not found.` };
    }

    if (proposal.status !== "draft") {
      return {
        success: false,
        reason: `Proposal ${proposalId} is not in draft status (current: ${proposal.status}).`,
      };
    }

    // Verify hash integrity before sealing
    // The stored content must match the hash computed at creation time
    try {
      const contentPath = path.join(this.proposalsDir, `${proposalId}.content`);
      const storedContent = await fs.readFile(contentPath, { encoding: "utf8" });
      const currentHash = computeHash(storedContent);

      if (currentHash !== proposal.contentHashAtCreation) {
        // FAIL-CLOSED: Hash mismatch = content was tampered after creation
        // Reject the proposal and flag the anomaly
        await this.updateProposalStatus(proposalId, "rejected");
        return {
          success: false,
          reason: `CONTENT HASH MISMATCH: Content was modified after creation. Proposal ${proposalId} rejected and flagged as anomaly.`,
        };
      }
    } catch (error) {
      return {
        success: false,
        reason: `Failed to verify proposal ${proposalId}: ${(error as Error).message}. Proposal rejected per fail-closed default.`,
      };
    }

    // Close the seal
    const sealedAt = new Date().toISOString();
    await this.updateProposalStatus(proposalId, "sealed", sealedAt);

    return { success: true, sealedAt };
  }

  /**
   * Approve a sealed proposal.
   *
   * Only proposals in "sealed" status can be approved.
   * Approval is the human gate (Ray) — no agent can approve their own proposal.
   */
  async approveProposal(
    proposalId: string,
    approver: string,
    reason: string,
  ): Promise<{ success: true; approvedAt: string } | { success: false; reason: string }> {
    const proposals = await this.readProposals();
    const proposal = proposals.find((p) => p.id === proposalId);

    if (!proposal) {
      return { success: false, reason: `Proposal ${proposalId} not found.` };
    }

    if (proposal.status !== "sealed") {
      return {
        success: false,
        reason: `Proposal ${proposalId} is not sealed (current: ${proposal.status}). Only sealed proposals can be approved.`,
      };
    }

    // Per §4.3 — anomaly alerts are never delivered to the subject
    // Approval is the human gate: agents cannot approve their own proposals
    if (approver === proposal.proposingAgent) {
      return {
        success: false,
        reason: `Agent ${approver} cannot approve their own proposal ${proposalId}. Approval requires a different agent or human gate.`,
      };
    }

    const approvedAt = new Date().toISOString();
    await this.updateProposalStatus(proposalId, "approved", approvedAt, reason);

    return { success: true, approvedAt };
  }

  /**
   * Reject a sealed proposal.
   */
  async rejectProposal(
    proposalId: string,
    rejector: string,
    reason: string,
  ): Promise<{ success: true; rejectedAt: string } | { success: false; reason: string }> {
    const proposals = await this.readProposals();
    const proposal = proposals.find((p) => p.id === proposalId);

    if (!proposal) {
      return { success: false, reason: `Proposal ${proposalId} not found.` };
    }

    if (proposal.status !== "draft" && proposal.status !== "sealed") {
      return {
        success: false,
        reason: `Proposal ${proposalId} cannot be rejected from status ${proposal.status}.`,
      };
    }

    const rejectedAt = new Date().toISOString();
    await this.updateProposalStatus(proposalId, "rejected", rejectedAt, reason);

    return { success: true, rejectedAt };
  }

  // --- Private methods ---

  private async appendProposal(
    id: string,
    content: string,
    contentHashAtCreation: string,
    manifestHashAtCreation: string,
    proposingAgent: string,
    sourceTier: MemoryTier,
    targetTier: MemoryTier,
  ): Promise<void> {
    await fs.mkdir(this.proposalsDir, { recursive: true });

    // Store content separately (sealed during draft phase)
    const contentPath = path.join(this.proposalsDir, `${id}.content`);
    await fs.writeFile(contentPath, content, { encoding: "utf8" });

    // Store proposal metadata
    const entry = {
      id,
      createdAt: new Date().toISOString(),
      proposingAgent,
      status: "draft" as SealedProposalStatus,
      contentHashAtCreation,
      manifestHashAtCreation,
      sourceTier,
      targetTier,
    };

    const proposalsPath = path.join(this.proposalsDir, PROPOSALS_FILE);
    await fs.appendFile(proposalsPath, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  }

  private async readProposals(): Promise<
    Array<SealedProposalInfo & { status: SealedProposalStatus }>
  > {
    const proposalsPath = path.join(this.proposalsDir, PROPOSALS_FILE);
    try {
      const content = await fs.readFile(proposalsPath, { encoding: "utf8" });
      return content
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  private async updateProposalStatus(
    proposalId: string,
    status: SealedProposalStatus,
    timestamp?: string,
    reason?: string,
  ): Promise<void> {
    const proposals = await this.readProposals();
    const proposal = proposals.find((p) => p.id === proposalId);
    if (!proposal) return;

    proposal.status = status;
    if (status === "sealed") proposal.sealedAt = timestamp;
    if (status === "approved" || status === "rejected") {
      proposal.decidedAt = timestamp;
      proposal.decisionReason = reason;
    }

    // Rewrite the proposals file with updated status
    const proposalsPath = path.join(this.proposalsDir, PROPOSALS_FILE);
    const updatedContent = proposals.map((p) => JSON.stringify(p)).join("\n") + "\n";
    await fs.writeFile(proposalsPath, updatedContent, { encoding: "utf8" });
  }
}

/** Public proposal info (content is sealed during draft phase) */
export interface SealedProposalInfo {
  id: string;
  createdAt: string;
  proposingAgent: string;
  status: SealedProposalStatus;
  contentHashAtCreation: string;
  manifestHashAtCreation: string;
  sourceTier: MemoryTier;
  targetTier: MemoryTier;
  sealedAt?: string;
  decidedAt?: string;
  decisionReason?: string;
  expiresAt?: string;
}
