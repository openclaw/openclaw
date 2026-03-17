import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { STATE_DIR } from "../config/paths.js";
import { ensureDir } from "../memory/internal.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

const COST_DB_FILENAME = "cost.sqlite";

export type CostSourceType = "llm" | "fixed" | "one_off" | "usage";
export type LedgerCostType = "fixed" | "usage" | "one_off";
export type BillingCycle = "monthly" | "annual" | null;
export type LedgerStatus = "active" | "inactive";

export type CostEvent = {
  id: string;
  timestamp: number;
  sourceType: CostSourceType;
  service: string;
  resource: string;
  metric: string; // JSON: { input, output, cacheRead, cacheWrite }
  costUsd: number;
  category: string | null;
  sessionId: string | null;
  runId: string | null;
  agentId: string | null;
  channelId: string | null;
  metadata: string | null; // JSON
  createdAt: number;
};

export type LedgerItem = {
  id: string;
  name: string;
  vendor: string | null;
  category: string | null;
  costType: LedgerCostType;
  billingCycle: BillingCycle;
  amount: number;
  metricUnit: string | null;
  unitPrice: number | null;
  effectiveStart: number;
  effectiveEnd: number | null;
  notes: string | null;
  tags: string | null; // JSON array
  status: LedgerStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type PricingVersion = {
  id: string;
  provider: string;
  model: string;
  effectiveDate: number;
  inputPrice: number; // per 1M tokens
  outputPrice: number; // per 1M tokens
  cacheReadPrice: number | null; // per 1M tokens
  cacheWritePrice: number | null; // per 1M tokens
  createdAt: number;
};

export type CostMetric = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

let dbInstance: DatabaseSync | null = null;
let dbPath: string | null = null;

export function resolveCostDbPath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, COST_DB_FILENAME);
}

export function openCostDb(stateDir: string = STATE_DIR): DatabaseSync {
  const targetPath = resolveCostDbPath(stateDir);

  // Return cached instance if same path
  if (dbInstance && dbPath === targetPath) {
    return dbInstance;
  }

  // Close existing instance if different path
  if (dbInstance && dbPath !== targetPath) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors
    }
    dbInstance = null;
    dbPath = null;
  }

  const dir = path.dirname(targetPath);
  ensureDir(dir);

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(targetPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");

  dbInstance = db;
  dbPath = targetPath;

  return db;
}

export function closeCostDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors
    }
    dbInstance = null;
    dbPath = null;
  }
}

export function ensureCostSchema(db: DatabaseSync): void {
  // cost_events - normalized LLM cost records
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      service TEXT NOT NULL,
      resource TEXT NOT NULL,
      metric TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      category TEXT,
      session_id TEXT,
      run_id TEXT,
      agent_id TEXT,
      channel_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_events_timestamp ON cost_events(timestamp);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_events_source_type ON cost_events(source_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_events_service ON cost_events(service);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_events_session_id ON cost_events(session_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_events_agent_id ON cost_events(agent_id);`);

  // ledger_items - user-managed cost entries
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vendor TEXT,
      category TEXT,
      cost_type TEXT NOT NULL,
      billing_cycle TEXT,
      amount REAL NOT NULL,
      metric_unit TEXT,
      unit_price REAL,
      effective_start INTEGER NOT NULL,
      effective_end INTEGER,
      notes TEXT,
      tags TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_items_status ON ledger_items(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_items_cost_type ON ledger_items(cost_type);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ledger_items_effective ON ledger_items(effective_start, effective_end);`,
  );

  // pricing_versions - model rate cards
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_versions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      effective_date INTEGER NOT NULL,
      input_price REAL NOT NULL,
      output_price REAL NOT NULL,
      cache_read_price REAL,
      cache_write_price REAL,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pricing_versions_lookup ON pricing_versions(provider, model, effective_date);`,
  );

  // Create unique constraint for pricing versions
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_versions_unique
    ON pricing_versions(provider, model, effective_date);
  `);
}

export function initCostDb(stateDir: string = STATE_DIR): DatabaseSync {
  const db = openCostDb(stateDir);
  ensureCostSchema(db);
  return db;
}

// Helper to generate unique IDs
export function generateCostId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// Insert a cost event
export function insertCostEvent(
  db: DatabaseSync,
  event: Omit<CostEvent, "id" | "createdAt">,
): string {
  const id = generateCostId();
  const createdAt = Date.now();

  db.prepare(
    `INSERT INTO cost_events (
      id, timestamp, source_type, service, resource, metric, cost_usd,
      category, session_id, run_id, agent_id, channel_id, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.timestamp,
    event.sourceType,
    event.service,
    event.resource,
    event.metric,
    event.costUsd,
    event.category,
    event.sessionId,
    event.runId,
    event.agentId,
    event.channelId,
    event.metadata,
    createdAt,
  );

  return id;
}

// Get pricing for a model at a given time
export function getModelPricing(
  db: DatabaseSync,
  provider: string,
  model: string,
  timestamp: number = Date.now(),
): PricingVersion | null {
  const row = db
    .prepare(
      `SELECT id, provider, model, effective_date, input_price, output_price,
              cache_read_price, cache_write_price, created_at
       FROM pricing_versions
       WHERE provider = ? AND model = ? AND effective_date <= ?
       ORDER BY effective_date DESC
       LIMIT 1`,
    )
    .get(provider, model, timestamp) as
    | {
        id: string;
        provider: string;
        model: string;
        effective_date: number;
        input_price: number;
        output_price: number;
        cache_read_price: number | null;
        cache_write_price: number | null;
        created_at: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    effectiveDate: row.effective_date,
    inputPrice: row.input_price,
    outputPrice: row.output_price,
    cacheReadPrice: row.cache_read_price,
    cacheWritePrice: row.cache_write_price,
    createdAt: row.created_at,
  };
}

// Compute cost from token counts and pricing
export function computeCostFromMetric(metric: CostMetric, pricing: PricingVersion): number {
  const inputCost = ((metric.input ?? 0) / 1_000_000) * pricing.inputPrice;
  const outputCost = ((metric.output ?? 0) / 1_000_000) * pricing.outputPrice;
  const cacheReadCost =
    pricing.cacheReadPrice != null
      ? ((metric.cacheRead ?? 0) / 1_000_000) * pricing.cacheReadPrice
      : 0;
  const cacheWriteCost =
    pricing.cacheWritePrice != null
      ? ((metric.cacheWrite ?? 0) / 1_000_000) * pricing.cacheWritePrice
      : 0;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

// Upsert a pricing version
export function upsertPricingVersion(
  db: DatabaseSync,
  pricing: Omit<PricingVersion, "id" | "createdAt">,
): string {
  const id = generateCostId();
  const createdAt = Date.now();

  db.prepare(
    `INSERT INTO pricing_versions (
      id, provider, model, effective_date, input_price, output_price,
      cache_read_price, cache_write_price, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model, effective_date) DO UPDATE SET
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price`,
  ).run(
    id,
    pricing.provider,
    pricing.model,
    pricing.effectiveDate,
    pricing.inputPrice,
    pricing.outputPrice,
    pricing.cacheReadPrice,
    pricing.cacheWritePrice,
    createdAt,
  );

  return id;
}

// Upsert a ledger item
export function upsertLedgerItem(
  db: DatabaseSync,
  item: Omit<LedgerItem, "createdAt" | "updatedAt">,
): string {
  const now = Date.now();

  const existing = db.prepare(`SELECT id FROM ledger_items WHERE id = ?`).get(item.id) as
    | { id: string }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE ledger_items SET
        name = ?, vendor = ?, category = ?, cost_type = ?, billing_cycle = ?,
        amount = ?, metric_unit = ?, unit_price = ?, effective_start = ?,
        effective_end = ?, notes = ?, tags = ?, status = ?, updated_at = ?, deleted_at = ?
       WHERE id = ?`,
    ).run(
      item.name,
      item.vendor,
      item.category,
      item.costType,
      item.billingCycle,
      item.amount,
      item.metricUnit,
      item.unitPrice,
      item.effectiveStart,
      item.effectiveEnd,
      item.notes,
      item.tags,
      item.status,
      now,
      item.deletedAt,
      item.id,
    );
    return item.id;
  }

  db.prepare(
    `INSERT INTO ledger_items (
      id, name, vendor, category, cost_type, billing_cycle, amount,
      metric_unit, unit_price, effective_start, effective_end, notes,
      tags, status, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.name,
    item.vendor,
    item.category,
    item.costType,
    item.billingCycle,
    item.amount,
    item.metricUnit,
    item.unitPrice,
    item.effectiveStart,
    item.effectiveEnd,
    item.notes,
    item.tags,
    item.status,
    now,
    now,
    item.deletedAt,
  );

  return item.id;
}

// Soft delete a ledger item
export function deleteLedgerItem(db: DatabaseSync, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE ledger_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(Date.now(), Date.now(), id);

  return result.changes > 0;
}

// List ledger items (excludes soft-deleted)
export function listLedgerItems(
  db: DatabaseSync,
  options?: {
    costType?: LedgerCostType;
    status?: LedgerStatus;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  },
): LedgerItem[] {
  let sql = `SELECT * FROM ledger_items WHERE 1=1`;
  const params: (string | number | null)[] = [];

  if (!options?.includeDeleted) {
    sql += ` AND deleted_at IS NULL`;
  }

  if (options?.costType) {
    sql += ` AND cost_type = ?`;
    params.push(options.costType);
  }

  if (options?.status) {
    sql += ` AND status = ?`;
    params.push(options.status);
  }

  sql += ` ORDER BY created_at DESC`;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
    if (options.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    name: string;
    vendor: string | null;
    category: string | null;
    cost_type: LedgerCostType;
    billing_cycle: BillingCycle;
    amount: number;
    metric_unit: string | null;
    unit_price: number | null;
    effective_start: number;
    effective_end: number | null;
    notes: string | null;
    tags: string | null;
    status: LedgerStatus;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    category: row.category,
    costType: row.cost_type,
    billingCycle: row.billing_cycle,
    amount: row.amount,
    metricUnit: row.metric_unit,
    unitPrice: row.unit_price,
    effectiveStart: row.effective_start,
    effectiveEnd: row.effective_end,
    notes: row.notes,
    tags: row.tags,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }));
}
