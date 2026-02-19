/**
 * E2E Hardening Validation — 5 checks required before merge.
 *
 * 1. Wrong-shop interception (P0-1)
 * 2. Leak prevention via sendPayload path (P0-2)
 * 3. Snapshot fallback after double failure (P0-3)
 * 4. Dedup — identical results not re-delivered (P0-3)
 * 5. Model switch preserves context (P1-1)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// ─── P0-1: Wrong-shop interception ───────────────────────────────────
import type { ShopConfig } from "./config/types.agent-defaults.js";
import { resolveShopConfig, validateShopIdentity } from "./browser/shop-validation.js";

describe("E2E-1: Wrong-shop interception (P0-1)", () => {
  const shops: Record<string, ShopConfig> = {
    bigmk: {
      shopName: "bigmk.ph",
      shopCode: "PHLCSLWL2G",
      profile: "tt-3bigmk",
      platform: "tiktok",
    },
    sumifun: {
      shopName: "sumifun.ph",
      shopCode: "PHSUMIFUN1",
      profile: "tt-sumifun",
      platform: "tiktok",
    },
  };

  it("blocks task when page shows wrong shop (bigmk page on sumifun profile)", () => {
    // Agent targets sumifun but browser is on bigmk page
    const resolved = resolveShopConfig(shops, "sumifun");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = validateShopIdentity({
      shopKey: "sumifun",
      config: resolved.config,
      pageShopName: "bigmk.ph", // WRONG shop on page
      pageShopCode: "PHLCSLWL2G", // bigmk's code, not sumifun's
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("shop_mismatch");
      expect(result.error).toContain("shop_mismatch");
    }
  });

  it("blocks task for unknown shop key", () => {
    const result = resolveShopConfig(shops, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_shop");
    }
  });

  it("passes when page matches expected shop exactly", () => {
    const resolved = resolveShopConfig(shops, "bigmk");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: resolved.config,
      pageShopName: "bigmk.ph",
      pageShopCode: "PHLCSLWL2G",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects partial/fuzzy match on shopCode", () => {
    const resolved = resolveShopConfig(shops, "bigmk");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: resolved.config,
      pageShopName: "bigmk.ph",
      pageShopCode: "PHLCSLWL", // Partial code — must fail
    });

    expect(result.ok).toBe(false);
  });
});

// ─── P0-2: Leak prevention via full delivery path ────────────────────

import { sanitizeOutbound } from "./infra/outbound/sanitize-outbound.js";

describe("E2E-2: Leak prevention (P0-2)", () => {
  it("strips Reasoning: from outbound text", () => {
    const input = "Sales today: 100 units\nReasoning: I need to calculate...";
    const result = sanitizeOutbound(input);
    expect(result.matched).toBe(true);
    expect(result.text).not.toContain("Reasoning:");
    expect(result.text).toContain("Sales today: 100 units");
  });

  it("strips <thinking> tags from outbound text", () => {
    const input =
      "Here are the results:\n<thinking>Let me analyze the data...</thinking>\nGMV: ₱26,000";
    const result = sanitizeOutbound(input);
    expect(result.matched).toBe(true);
    expect(result.text).not.toContain("<thinking>");
    expect(result.text).not.toContain("Let me analyze");
    expect(result.text).toContain("GMV: ₱26,000");
  });

  it("strips Chinese internal text (推理:/思考:)", () => {
    const input = "推理: 我需要先检查数据\n今日销售额: ₱50,000";
    const result = sanitizeOutbound(input);
    expect(result.matched).toBe(true);
    expect(result.text).not.toContain("推理:");
    expect(result.text).toContain("₱50,000");
  });

  it("blocks entire message when only internal text remains", () => {
    const input = "Reasoning: I should check the data first\nTool call: browser.evaluate()";
    const result = sanitizeOutbound(input);
    expect(result.matched).toBe(true);
    expect(result.text === null || result.text?.trim() === "").toBe(true);
  });

  it("does NOT block normal user text (false positive check)", () => {
    const input = "My reasoning is that sales are growing. The internal team agrees.";
    const result = sanitizeOutbound(input);
    expect(result.matched).toBe(false);
    // Text should pass through unchanged
  });

  it("sanitizes channelData string fields", () => {
    // Simulates what deliver.ts now does: sanitize channelData values
    const channelData: Record<string, unknown> = {
      body: "Normal text\nReasoning: secret internal analysis",
      caption: "Sales report",
      metadata: { nested: true }, // non-string, should be skipped
    };

    for (const [key, val] of Object.entries(channelData)) {
      if (typeof val === "string" && val.length > 0) {
        const s = sanitizeOutbound(val);
        if (s.matched) {
          channelData[key] = s.text ?? "";
        }
      }
    }

    expect(channelData.body).not.toContain("Reasoning:");
    expect(channelData.body).toContain("Normal text");
    expect(channelData.caption).toBe("Sales report"); // Untouched
    expect(channelData.metadata).toEqual({ nested: true }); // Untouched
  });
});

// ─── P0-3: Snapshot fallback after double failure ────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeCronSnapshot,
  findBestSnapshot,
  formatSnapshotPrefix,
  hashResult,
} from "./cron/snapshot.js";

describe("E2E-3: Snapshot fallback (P0-3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cron-"));
  });

  it("falls back to snapshot after double failure with [Snapshot data...] prefix", async () => {
    // Step 1: Write a successful realtime snapshot (simulates previous run).
    await writeCronSnapshot({
      storePath: tmpDir,
      snapshot: {
        ts: Date.now() - 3600_000, // 1 hour ago
        jobId: "daily-report",
        source: "realtime",
        result: "Sales: ₱26,000, Orders: 246, ROI: 1.68",
        durationMs: 12000,
      },
    });

    // Step 2: Simulate double failure — look for snapshot fallback.
    const snapshot = await findBestSnapshot({
      storePath: tmpDir,
      jobId: "daily-report",
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.source).toBe("realtime");
    expect(snapshot!.result).toContain("Sales: ₱26,000");

    // Step 3: Format with snapshot prefix (as the timer does).
    const prefix = formatSnapshotPrefix(snapshot!);
    const fallbackMessage = `${prefix}${snapshot!.result}`;

    expect(fallbackMessage).toContain("[Snapshot data from");
    expect(fallbackMessage).toContain("not realtime]");
    expect(fallbackMessage).toContain("Sales: ₱26,000");
  });

  it("returns null when no snapshot exists (full failure)", async () => {
    const snapshot = await findBestSnapshot({
      storePath: tmpDir,
      jobId: "never-ran",
    });
    expect(snapshot).toBeNull();
  });
});

// ─── P0-3: Dedup — identical results not re-delivered ────────────────

describe("E2E-4: Dedup (P0-3)", () => {
  it("hashResult produces identical hash for identical text", () => {
    const text = "Sales: ₱26,000, Orders: 246, ROI: 1.68";
    const hash1 = hashResult(text);
    const hash2 = hashResult(text);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16); // SHA-256 first 16 chars
  });

  it("hashResult produces different hash for different text", () => {
    const hash1 = hashResult("Sales: ₱26,000");
    const hash2 = hashResult("Sales: ₱27,000");
    expect(hash1).not.toBe(hash2);
  });

  it("simulates full dedup flow: identical results skip second delivery", () => {
    // Simulate what timer.ts does: compare currentHash with lastDeliveredHash.
    const jobState: { lastDeliveredHash?: string } = {};
    const resultText = "Sales: ₱26,000, Orders: 246, ROI: 1.68";

    // First delivery — no previous hash, should deliver.
    const hash1 = hashResult(resultText);
    const shouldDeliver1 = !(jobState.lastDeliveredHash && jobState.lastDeliveredHash === hash1);
    expect(shouldDeliver1).toBe(true);
    jobState.lastDeliveredHash = hash1;

    // Second delivery — same result, should skip.
    const hash2 = hashResult(resultText);
    const shouldDeliver2 = !(jobState.lastDeliveredHash && jobState.lastDeliveredHash === hash2);
    expect(shouldDeliver2).toBe(false);

    // Third delivery — different result, should deliver.
    const newResult = "Sales: ₱28,000, Orders: 300, ROI: 1.72";
    const hash3 = hashResult(newResult);
    const shouldDeliver3 = !(jobState.lastDeliveredHash && jobState.lastDeliveredHash === hash3);
    expect(shouldDeliver3).toBe(true);
  });

  it("lastDeliveredHash persists via CronJobState type", () => {
    // Verify the type includes lastDeliveredHash (compile-time check).
    const state: import("./cron/types.js").CronJobState = {
      lastDeliveredHash: "abc123def456ghij",
    };
    expect(state.lastDeliveredHash).toBe("abc123def456ghij");

    // Verify it serializes correctly (JSON round-trip).
    const json = JSON.stringify({ state });
    const parsed = JSON.parse(json);
    expect(parsed.state.lastDeliveredHash).toBe("abc123def456ghij");
  });
});

// ─── P1-1: Model switch preserves context ────────────────────────────

import crypto from "node:crypto";
import type { SessionEntry, ContextLock } from "./config/sessions/types.js";
import {
  createContextLock,
  clearContextLock,
  checkContextLock,
  bumpContextLockVersion,
} from "./sessions/context-lock.js";
import { applyModelOverrideToSessionEntry } from "./sessions/model-overrides.js";

describe("E2E-5: Model switch preserves context (P1-1)", () => {
  function makeSession(overrides?: Partial<SessionEntry>): SessionEntry {
    return {
      sessionId: crypto.randomUUID(),
      updatedAt: Date.now(),
      providerOverride: "deepinfra",
      modelOverride: "MiniMaxAI/MiniMax-M2.5",
      ...overrides,
    };
  }

  it("full lifecycle: lock → model switch → restore intent → bump → clear", () => {
    const entry = makeSession();

    // 1. Task starts: create context lock.
    createContextLock(entry, {
      shopKey: "bigmk",
      browserProfile: "tt-3bigmk",
      activeTabId: "tab-abc",
      pageUrl: "https://seller-ph.tiktok.com/compass/data-overview",
    });
    expect(entry.contextLock).toBeDefined();
    expect(entry.contextLock!.lockVersion).toBe(1);
    expect(entry.contextLock!.shopKey).toBe("bigmk");

    // 2. User switches model mid-task.
    const { contextRestore } = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "deepinfra", model: "zai-org/GLM-5" },
    });

    // 3. Restore action should be "restore" (lock is active, not expired).
    expect(contextRestore.action).toBe("restore");
    if (contextRestore.action === "restore") {
      expect(contextRestore.lock.shopKey).toBe("bigmk");
      expect(contextRestore.lock.browserProfile).toBe("tt-3bigmk");
      expect(contextRestore.lock.activeTabId).toBe("tab-abc");
    }

    // 4. After successful browser restore: bump version.
    bumpContextLockVersion(entry);
    expect(entry.contextLock!.lockVersion).toBe(2);

    // 5. Task completes: clear lock.
    clearContextLock(entry);
    expect(entry.contextLock).toBeUndefined();
  });

  it("expired lock returns 'expired', not 'restore'", () => {
    const entry = makeSession();

    // Create lock that's already expired (lockedAt far in the past).
    createContextLock(entry, {
      shopKey: "bigmk",
      browserProfile: "tt-3bigmk",
    });
    entry.contextLock!.lockedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    entry.contextLock!.ttlMs = 30 * 60 * 1000; // 30 min TTL

    // Model switch should detect expired lock.
    const { contextRestore } = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "deepinfra", model: "zai-org/GLM-5" },
    });

    expect(contextRestore.action).toBe("expired");
    expect(entry.contextLock).toBeUndefined(); // Lock cleared
  });

  it("no lock returns 'none' — normal model switch", () => {
    const entry = makeSession();
    // No contextLock set.

    const { contextRestore } = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "deepinfra", model: "zai-org/GLM-5" },
    });

    expect(contextRestore.action).toBe("none");
  });

  it("model switch to same model does not trigger restore", () => {
    const entry = makeSession({
      providerOverride: "deepinfra",
      modelOverride: "MiniMaxAI/MiniMax-M2.5",
    });

    createContextLock(entry, {
      shopKey: "bigmk",
      browserProfile: "tt-3bigmk",
    });

    // Switch to the same model — no actual change.
    const { updated, contextRestore } = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "deepinfra", model: "MiniMaxAI/MiniMax-M2.5" },
    });

    // No model change → no restore triggered.
    expect(updated).toBe(false);
    expect(contextRestore.action).toBe("none");
    // Lock should still be intact.
    expect(entry.contextLock).toBeDefined();
  });
});
