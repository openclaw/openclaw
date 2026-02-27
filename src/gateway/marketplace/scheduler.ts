/**
 * Marketplace scheduler — manages the pool of idle seller nodes
 * and assigns buyer requests to the best available seller.
 */
import type { NodeSession } from "../node-registry.js";

export type SellerNodeState = {
  nodeId: string;
  status: "active" | "idle" | "sharing";
  lastIdleAtMs: number;
  activeRequests: number;
  maxConcurrent: number;
  /** Performance score 0-100 based on past response times and success rate. */
  performanceScore: number;
  /** Total requests completed successfully. */
  totalCompleted: number;
  /** Total requests that failed or timed out. */
  totalFailed: number;
};

export class MarketplaceScheduler {
  private sellers = new Map<string, SellerNodeState>();

  /** Update seller status from a node's marketplace.idle.status event. */
  updateSellerStatus(
    nodeId: string,
    status: "active" | "idle" | "sharing",
    meta?: { maxConcurrent?: number },
  ): void {
    let seller = this.sellers.get(nodeId);
    if (!seller) {
      seller = {
        nodeId,
        status,
        lastIdleAtMs: status === "idle" ? Date.now() : 0,
        activeRequests: 0,
        maxConcurrent: meta?.maxConcurrent ?? 1,
        performanceScore: 50,
        totalCompleted: 0,
        totalFailed: 0,
      };
      this.sellers.set(nodeId, seller);
    } else {
      seller.status = status;
      if (status === "idle" && !seller.lastIdleAtMs) {
        seller.lastIdleAtMs = Date.now();
      }
      if (meta?.maxConcurrent !== undefined) {
        seller.maxConcurrent = meta.maxConcurrent;
      }
    }
  }

  /** Remove a seller when their node disconnects. */
  removeSeller(nodeId: string): void {
    this.sellers.delete(nodeId);
  }

  /**
   * Pick the best idle seller for a marketplace request.
   * Returns null if no sellers are available.
   *
   * Selection algorithm:
   * 1. Filter: idle status, activeRequests < maxConcurrent
   * 2. Sort: performance score descending, then longest-idle first (fair distribution)
   */
  pickSeller(): SellerNodeState | null {
    const candidates: SellerNodeState[] = [];
    for (const seller of this.sellers.values()) {
      if (seller.status !== "idle") {
        continue;
      }
      if (seller.activeRequests >= seller.maxConcurrent) {
        continue;
      }
      candidates.push(seller);
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      // Higher performance score first.
      if (a.performanceScore !== b.performanceScore) {
        return b.performanceScore - a.performanceScore;
      }
      // Longest-idle first (lower timestamp = idled earlier).
      return a.lastIdleAtMs - b.lastIdleAtMs;
    });

    return candidates[0];
  }

  /** Reserve a seller — increment active request count. */
  reserveSeller(nodeId: string): boolean {
    const seller = this.sellers.get(nodeId);
    if (!seller) {
      return false;
    }
    if (seller.activeRequests >= seller.maxConcurrent) {
      return false;
    }
    seller.activeRequests++;
    if (seller.activeRequests >= seller.maxConcurrent) {
      seller.status = "sharing";
    }
    return true;
  }

  /** Release a seller after a request completes. */
  releaseSeller(nodeId: string, success: boolean, durationMs?: number): void {
    const seller = this.sellers.get(nodeId);
    if (!seller) {
      return;
    }
    seller.activeRequests = Math.max(0, seller.activeRequests - 1);

    // Update performance score (exponential moving average).
    if (success) {
      seller.totalCompleted++;
      // Successful fast responses boost score.
      const speedBonus = durationMs !== undefined && durationMs < 5000 ? 5 : 0;
      seller.performanceScore = Math.min(
        100,
        seller.performanceScore * 0.9 + (100 + speedBonus) * 0.1,
      );
    } else {
      seller.totalFailed++;
      seller.performanceScore = Math.max(0, seller.performanceScore * 0.9 + 0);
    }

    // Return to idle if no active requests and status was sharing.
    if (seller.activeRequests === 0 && seller.status === "sharing") {
      seller.status = "idle";
      seller.lastIdleAtMs = Date.now();
    }
  }

  /** Handle a seller becoming active (user started using Claude). */
  handleSellerBecameActive(nodeId: string): void {
    const seller = this.sellers.get(nodeId);
    if (!seller) {
      return;
    }
    seller.status = "active";
    // In-flight requests still complete — we just don't route new ones here.
  }

  /** List all known sellers with their states. */
  listSellers(): SellerNodeState[] {
    return [...this.sellers.values()];
  }

  /** Count of sellers currently available to take requests. */
  availableCount(): number {
    let count = 0;
    for (const seller of this.sellers.values()) {
      if (seller.status === "idle" && seller.activeRequests < seller.maxConcurrent) {
        count++;
      }
    }
    return count;
  }

  /** Sync marketplace state from a node session (called on node registration). */
  syncFromNodeSession(session: NodeSession): void {
    if (!session.marketplaceEnabled) {
      return;
    }
    this.updateSellerStatus(session.nodeId, session.marketplaceStatus ?? "active", {
      maxConcurrent: session.marketplaceMaxConcurrent,
    });
  }
}
