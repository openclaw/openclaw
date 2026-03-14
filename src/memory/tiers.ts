/**
 * Three-Tier Memory System: Perplexity Computer-style persistent memory.
 *
 * Tiers:
 *   short  - Single conversation (in-memory, auto-cleared)
 *   medium - Project-scoped (persists for the life of a project, weeks)
 *   long   - Permanent (user preferences, company info, learned patterns)
 *
 * Promotion logic:
 *   - A fact that's referenced in 3+ conversations is promoted from short → medium
 *   - A fact that's explicitly marked as permanent, or referenced 10+ times, is promoted
 *     from medium → long
 *
 * Memory items carry a tier label and reference count. The user can view,
 * edit, and delete any tier via the memory management API.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/tiers");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryTier = "short" | "medium" | "long";

export type TieredMemoryItem = {
  id: string;
  content: string;
  tier: MemoryTier;
  /** Tags for categorization (e.g., "preference", "project:openclaw", "company") */
  tags: string[];
  /** Number of times this item has been referenced */
  referenceCount: number;
  /** Number of distinct conversations it appeared in */
  conversationCount: number;
  createdAt: number;
  updatedAt: number;
  /** For medium/long: explicitly keep forever */
  permanent?: boolean;
  /** Project or session scope this item belongs to */
  scope?: string;
};

export type TierStats = {
  short: number;
  medium: number;
  long: number;
  total: number;
};

// Thresholds for automatic promotion
const PROMOTE_TO_MEDIUM_CONVO_COUNT = 3;
const PROMOTE_TO_LONG_REF_COUNT = 10;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DEFAULT_STORE_PATH = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "memory-tiers.json",
);

type TieredMemoryStore = {
  items: TieredMemoryItem[];
  version: number;
};

function loadStore(storePath: string): TieredMemoryStore {
  if (!fs.existsSync(storePath)) {
    return { items: [], version: 1 };
  }
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8")) as TieredMemoryStore;
  } catch {
    log.warn("Failed to load tier memory store, starting fresh");
    return { items: [], version: 1 };
  }
}

function saveStore(storePath: string, store: TieredMemoryStore): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// Tier manager
// ---------------------------------------------------------------------------

export class TieredMemoryManager {
  private readonly storePath: string;

  constructor(storePath?: string) {
    this.storePath = storePath ?? DEFAULT_STORE_PATH;
  }

  private load(): TieredMemoryStore {
    return loadStore(this.storePath);
  }

  private save(store: TieredMemoryStore): void {
    saveStore(this.storePath, store);
  }

  /** Add a new memory item to a tier. */
  add(params: {
    content: string;
    tier?: MemoryTier;
    tags?: string[];
    permanent?: boolean;
    scope?: string;
  }): TieredMemoryItem {
    const store = this.load();
    const now = Date.now();
    const item: TieredMemoryItem = {
      id: crypto.randomUUID(),
      content: params.content,
      tier: params.tier ?? "short",
      tags: params.tags ?? [],
      referenceCount: 0,
      conversationCount: 0,
      createdAt: now,
      updatedAt: now,
      permanent: params.permanent,
      scope: params.scope,
    };
    store.items.push(item);
    this.save(store);
    log.debug(`Added memory item to tier=${item.tier}: ${item.content.slice(0, 60)}`);
    return item;
  }

  /** Record a reference to a memory item and auto-promote if thresholds are met. */
  recordReference(id: string, newConversation = false): TieredMemoryItem | null {
    const store = this.load();
    const item = store.items.find((i) => i.id === id);
    if (!item) return null;

    item.referenceCount += 1;
    if (newConversation) item.conversationCount += 1;
    item.updatedAt = Date.now();

    // Auto-promotion
    const promoted = this.tryPromote(item);
    if (promoted) {
      log.debug(`Promoted memory item ${id} from ${item.tier} to ${item.tier}`);
    }

    this.save(store);
    return item;
  }

  private tryPromote(item: TieredMemoryItem): boolean {
    if (item.tier === "short" && item.conversationCount >= PROMOTE_TO_MEDIUM_CONVO_COUNT) {
      item.tier = "medium";
      return true;
    }
    if (
      item.tier === "medium" &&
      (item.referenceCount >= PROMOTE_TO_LONG_REF_COUNT || item.permanent)
    ) {
      item.tier = "long";
      return true;
    }
    return false;
  }

  /** Explicitly promote an item to a higher tier. */
  promote(id: string, targetTier: MemoryTier): boolean {
    const store = this.load();
    const item = store.items.find((i) => i.id === id);
    if (!item) return false;

    const tierOrder: MemoryTier[] = ["short", "medium", "long"];
    if (tierOrder.indexOf(targetTier) <= tierOrder.indexOf(item.tier)) {
      return false; // Cannot demote
    }
    item.tier = targetTier;
    item.updatedAt = Date.now();
    this.save(store);
    return true;
  }

  /** Mark an item as permanent (will be promoted to long on next reference). */
  markPermanent(id: string): boolean {
    const store = this.load();
    const item = store.items.find((i) => i.id === id);
    if (!item) return false;
    item.permanent = true;
    item.tier = "long"; // Immediately promote to long
    item.updatedAt = Date.now();
    this.save(store);
    return true;
  }

  /** Query memory items. */
  query(params: {
    tier?: MemoryTier;
    tags?: string[];
    scope?: string;
    limit?: number;
  }): TieredMemoryItem[] {
    const store = this.load();
    let items = store.items;

    if (params.tier) items = items.filter((i) => i.tier === params.tier);
    if (params.scope) items = items.filter((i) => i.scope === params.scope || !i.scope);
    if (params.tags?.length) {
      items = items.filter((i) => params.tags!.some((tag) => i.tags.includes(tag)));
    }

    // Sort by relevance: long-term > medium > short, then by reference count
    items.sort((a, b) => {
      const tierScore = (t: MemoryTier) => ({ long: 3, medium: 2, short: 1 }[t]);
      const tDiff = tierScore(b.tier) - tierScore(a.tier);
      if (tDiff !== 0) return tDiff;
      return b.referenceCount - a.referenceCount;
    });

    return params.limit ? items.slice(0, params.limit) : items;
  }

  /** Search memory items by text (simple substring match). */
  search(query: string, opts?: { tier?: MemoryTier; limit?: number }): TieredMemoryItem[] {
    const lower = query.toLowerCase();
    const store = this.load();
    let items = store.items.filter((i) => i.content.toLowerCase().includes(lower));

    if (opts?.tier) items = items.filter((i) => i.tier === opts.tier);

    items.sort((a, b) => b.referenceCount - a.referenceCount);
    return opts?.limit ? items.slice(0, opts.limit) : items;
  }

  /** Delete a memory item. */
  delete(id: string): boolean {
    const store = this.load();
    const before = store.items.length;
    store.items = store.items.filter((i) => i.id !== id);
    if (store.items.length === before) return false;
    this.save(store);
    return true;
  }

  /** Clear all short-term memory items (e.g., on session end). */
  clearShortTerm(): number {
    const store = this.load();
    const before = store.items.length;
    store.items = store.items.filter((i) => i.tier !== "short");
    const cleared = before - store.items.length;
    this.save(store);
    log.debug(`Cleared ${cleared} short-term memory items`);
    return cleared;
  }

  /** Get stats for each tier. */
  getStats(): TierStats {
    const store = this.load();
    const counts = { short: 0, medium: 0, long: 0 };
    for (const item of store.items) {
      counts[item.tier] += 1;
    }
    return { ...counts, total: store.items.length };
  }

  /** Format a summary of long-term memory items for context injection. */
  formatLongTermContext(scope?: string): string {
    const items = this.query({ tier: "long", scope, limit: 50 });
    if (items.length === 0) return "";

    const lines = items.map((item) => {
      const tags = item.tags.length ? ` [${item.tags.join(", ")}]` : "";
      return `- ${item.content}${tags}`;
    });

    return `## Long-term memory\n${lines.join("\n")}`;
  }
}

// Singleton
let _manager: TieredMemoryManager | null = null;

export function getTieredMemoryManager(storePath?: string): TieredMemoryManager {
  if (!_manager) {
    _manager = new TieredMemoryManager(storePath);
  }
  return _manager;
}
