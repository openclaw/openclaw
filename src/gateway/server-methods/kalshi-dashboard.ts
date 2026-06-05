import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KALSHI_PYTHON_CANDIDATES = [
  "/Users/openclaw/.venvs/kalshi-api/bin/python",
  "/Users/openclaw/.venvs/kalshi-api/bin/python3",
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/usr/bin/python3",
] as const;
const KALSHI_DASHBOARD_REFRESH_TIMEOUT_MS = 180_000;
const KALSHI_DASHBOARD_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 45_000;
const KALSHI_DASHBOARD_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const KALSHI_AUDIT_TABLE_PAGE_SIZE = 50;
const KALSHI_AUDIT_TABLE_MAX_QUERY_LENGTH = 120;
const KALSHI_AUDIT_TABLES = ["pending", "overdue", "recent", "resolved"] as const;

type DashboardEnvelope = {
  ok?: boolean;
  data?: unknown;
  error?: { message?: unknown };
};

type LoadSnapshot = (opts?: { forceRefresh?: boolean }) => Promise<unknown>;
type DashboardRecord = Record<string, unknown>;
type DashboardRefreshRunner = (python: string, script: string) => Promise<Record<string, unknown>>;
type DashboardRefreshStatus = {
  inProgress: boolean;
  stale: boolean;
  ageMs: number | null;
  lastError: string | null;
  suspended?: boolean;
  cacheOnly?: boolean;
};
type AuditTableId = (typeof KALSHI_AUDIT_TABLES)[number];
type AuditTableRequest = {
  page: number;
  query: string;
};
type AuditTableMeta = {
  filtered_rows: number;
  page: number;
  page_count: number;
  page_size: number;
  query: string;
  server_sliced: true;
  shown_rows: number;
  total_rows: number;
};

let dashboardRefreshInFlight: Promise<unknown> | null = null;
let lastDashboardRefreshStartedAt = 0;
let lastDashboardRefreshError: string | null = null;
let cachedKalshiDashboardScript: string | null = null;
let kalshiDashboardScriptOverrideForTest: string | null = null;
let cachedKalshiDashboardPython: { key: string; path: string } | null = null;
let cachedDashboardDataSnapshot: {
  dataPath: string;
  mtimeMs: number;
  size: number;
  snapshot: Record<string, unknown>;
} | null = null;
let dashboardRefreshRunner: DashboardRefreshRunner = runDashboardRefresh;

function resolveKalshiDashboardScript(): string {
  if (kalshiDashboardScriptOverrideForTest) {
    return kalshiDashboardScriptOverrideForTest;
  }
  if (cachedKalshiDashboardScript) {
    return cachedKalshiDashboardScript;
  }
  const candidates = [
    path.join(process.cwd(), "work/scripts/kalshi/kalshi_dashboard.py"),
    path.resolve(SCRIPT_DIR, "../../work/scripts/kalshi/kalshi_dashboard.py"),
    path.resolve(SCRIPT_DIR, "../work/scripts/kalshi/kalshi_dashboard.py"),
    path.resolve(SCRIPT_DIR, "../../../work/scripts/kalshi/kalshi_dashboard.py"),
    "/Users/openclaw/OpenClaw/work/scripts/kalshi/kalshi_dashboard.py",
    "/Users/openclaw/openclaw/work/scripts/kalshi/kalshi_dashboard.py",
    "/Users/openclaw/.openclaw/workspace/kalshi/kalshi_dashboard.py",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      cachedKalshiDashboardScript = candidate;
      return candidate;
    } catch {
      // Try the next known OpenClaw/Kalshi layout.
    }
  }
  throw new Error(`Kalshi dashboard script not found. Checked: ${candidates.join(", ")}`);
}

function resolveKalshiDashboardDataPath(scriptPath = resolveKalshiDashboardScript()): string {
  return path.join(path.dirname(scriptPath), "dashboard", "kalshi_dashboard_data.json");
}

function resolveKalshiDashboardRefreshGuardPath(
  scriptPath = resolveKalshiDashboardScript(),
): string {
  return path.join(path.dirname(scriptPath), "tmp", "dashboard_refresh_suspended.flag");
}

function isKalshiDashboardRefreshSuspended(scriptPath = resolveKalshiDashboardScript()): boolean {
  const guardPath = resolveKalshiDashboardRefreshGuardPath(scriptPath);
  try {
    fs.accessSync(guardPath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(
      `Kalshi dashboard refresh guard could not be checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveExecutable(candidates: readonly string[]): string {
  const cacheKey = candidates.join("\0");
  if (cachedKalshiDashboardPython?.key === cacheKey) {
    return cachedKalshiDashboardPython.path;
  }
  const checked: string[] = [];
  for (const candidate of candidates) {
    checked.push(candidate);
    try {
      const resolved = fs.realpathSync.native(candidate);
      fs.accessSync(resolved, fs.constants.X_OK);
      cachedKalshiDashboardPython = { key: cacheKey, path: resolved };
      return resolved;
    } catch {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cachedKalshiDashboardPython = { key: cacheKey, path: candidate };
        return candidate;
      } catch {
        // Try the next known-safe interpreter path.
      }
    }
  }
  throw new Error(
    `No executable Python found for Kalshi dashboard. Checked: ${checked.join(", ")}`,
  );
}

function parseDashboardEnvelope(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as DashboardEnvelope;
  if (!parsed.ok) {
    const message =
      typeof parsed.error?.message === "string"
        ? parsed.error.message
        : "Kalshi dashboard script returned ok=false";
    throw new Error(message);
  }
  if (!parsed.data || typeof parsed.data !== "object") {
    throw new Error("Kalshi dashboard script returned no data object");
  }
  const liveOrderAllowed = (parsed.data as { live_order_allowed?: unknown }).live_order_allowed;
  if (liveOrderAllowed !== false) {
    throw new Error("Kalshi dashboard data failed live_order_allowed safety check");
  }
  return parsed.data;
}

function parseDashboardDataObject(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Kalshi dashboard data file did not contain an object");
  }
  const data = parsed as Record<string, unknown>;
  if (data.live_order_allowed !== false) {
    throw new Error("Kalshi dashboard data failed live_order_allowed safety check");
  }
  return data;
}

function pickObjectFields(source: unknown, fields: readonly string[]): DashboardRecord | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const record = source as DashboardRecord;
  const picked: DashboardRecord = {};
  for (const field of fields) {
    if (Object.hasOwn(record, field)) {
      picked[field] = record[field];
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function objectField(source: unknown, field: string): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  return (source as DashboardRecord)[field];
}

function mutableObjectField(source: DashboardRecord, field: string): DashboardRecord {
  const current = source[field];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    const next: DashboardRecord = {};
    source[field] = next;
    return next;
  }
  const next = { ...(current as DashboardRecord) };
  source[field] = next;
  return next;
}

function auditRowText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(auditRowText).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as DashboardRecord)
      .map(auditRowText)
      .join(" ");
  }
  return "";
}

function auditTableConfig(source: unknown): Partial<Record<AuditTableId, AuditTableRequest>> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const tables = source as DashboardRecord;
  const parsed: Partial<Record<AuditTableId, AuditTableRequest>> = {};
  for (const table of KALSHI_AUDIT_TABLES) {
    const raw = tables[table];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const record = raw as DashboardRecord;
    const rawPage = record.page;
    const page =
      typeof rawPage === "number" && Number.isFinite(rawPage)
        ? Math.max(1, Math.trunc(rawPage))
        : 1;
    const rawQuery = record.query;
    const query =
      typeof rawQuery === "string"
        ? rawQuery.trim().slice(0, KALSHI_AUDIT_TABLE_MAX_QUERY_LENGTH)
        : "";
    parsed[table] = { page, query };
  }
  return parsed;
}

function auditTableRows(parent: unknown, field: string): DashboardRecord[] {
  const rows = objectField(parent, field);
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter(
    (row): row is DashboardRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

function auditTableMeta(
  request: AuditTableRequest,
  totalRows: number,
  filteredRows: number,
  visibleRows: number,
): AuditTableMeta {
  const pageCount = Math.max(1, Math.ceil(filteredRows / KALSHI_AUDIT_TABLE_PAGE_SIZE));
  return {
    filtered_rows: filteredRows,
    page: Math.min(request.page, pageCount),
    page_count: pageCount,
    page_size: KALSHI_AUDIT_TABLE_PAGE_SIZE,
    query: request.query,
    server_sliced: true,
    shown_rows: visibleRows,
    total_rows: totalRows,
  };
}

function sliceAuditRows(rows: DashboardRecord[], request: AuditTableRequest) {
  const normalizedQuery = request.query.toLowerCase();
  const filtered = normalizedQuery
    ? rows.filter((row) => auditRowText(row).includes(normalizedQuery))
    : rows;
  const pageCount = Math.max(1, Math.ceil(filtered.length / KALSHI_AUDIT_TABLE_PAGE_SIZE));
  const page = Math.min(request.page, pageCount);
  const start = (page - 1) * KALSHI_AUDIT_TABLE_PAGE_SIZE;
  const visible = filtered.slice(start, start + KALSHI_AUDIT_TABLE_PAGE_SIZE);
  return {
    meta: auditTableMeta({ ...request, page }, rows.length, filtered.length, visible.length),
    visible,
  };
}

function applyAuditTableSlices(
  snapshot: unknown,
  config: Partial<Record<AuditTableId, AuditTableRequest>>,
): DashboardRecord {
  const data = { ...parseDashboardDataObject(snapshot) };
  const pageMeta: Partial<Record<AuditTableId, AuditTableMeta>> = {};

  const pending = mutableObjectField(data, "pending_paper_trades");
  const recent = mutableObjectField(data, "recent_paper_bets");
  const paths: Record<AuditTableId, { parent: DashboardRecord; field: string }> = {
    pending: { parent: pending, field: "trades" },
    overdue: { parent: pending, field: "overdue_trades" },
    recent: { parent: recent, field: "trades" },
    resolved: { parent: recent, field: "latest_resolved_trades" },
  };

  for (const table of KALSHI_AUDIT_TABLES) {
    const request = config[table] ?? { page: 1, query: "" };
    const pathConfig = paths[table];
    const { meta, visible } = sliceAuditRows(
      auditTableRows(pathConfig.parent, pathConfig.field),
      request,
    );
    pathConfig.parent[pathConfig.field] = visible;
    pageMeta[table] = meta;
  }

  data.audit_pages = pageMeta;
  return data;
}

function pruneCompactValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const pruned: DashboardRecord = {};
  for (const [key, child] of Object.entries(value as DashboardRecord)) {
    const next = pruneCompactValue(child);
    if (next !== undefined) {
      pruned[key] = next;
    }
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function compactWeatherLane(source: unknown): DashboardRecord | undefined {
  const lane = pickObjectFields(source, [
    "latest_discovery_parsed",
    "latest_discovery_trade_ready",
    "latest_run_parsed",
    "latest_run_trade_ready",
    "latest_candidate_created_count",
    "latest_candidate_governor_actions",
    "latest_candidate_skipped_reasons",
    "stale_discovery_suppressed",
    "why_not_trading",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!lane) {
    return undefined;
  }
  const expansion = objectField(source, "weather_expansion");
  const compactExpansion = pickObjectFields(expansion, [
    "active_trade_ready_city_count",
    "active_trade_ready_cities",
    "cities_waiting_for_active_markets",
    "cities_needing_parser_or_model_work",
    "current_trade_ready_note",
    "registered_city_count",
    "watchlist_cities_without_trade_ready_markets",
    "live_order_allowed",
  ]);
  if (compactExpansion) {
    lane.weather_expansion = compactExpansion;
  }
  return lane;
}

function compactStrategyComparison(source: unknown): DashboardRecord | undefined {
  const comparison = pickObjectFields(source, [
    "ok",
    "scope",
    "primary_metric_source",
    "secondary_metric_source",
    "plain_english",
    "actual_summary",
    "audit_summary",
    "equal_weighting",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!comparison) {
    return undefined;
  }
  const rows = objectField(source, "rows");
  if (Array.isArray(rows)) {
    comparison.rows = rows
      .filter(
        (row): row is DashboardRecord =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
      .map(
        (row) =>
          pickObjectFields(row, [
            "strategy_id",
            "display_name",
            "role",
            "domains",
            "decisions",
            "accepted",
            "shadow_decisions",
            "scored",
            "audit_scored",
            "wins",
            "losses",
            "accuracy",
            "audit_accuracy",
            "paper_pnl_usd",
            "pnl_delta_vs_standard_usd",
            "pnl_delta_vs_standard_label",
            "pnl_delta_vs_standard_source",
            "pnl_delta_status",
            "audit_pnl_usd",
            "audit_delta_vs_standard_accuracy",
            "audit_delta_vs_standard_pnl_usd",
            "total_profit_usd",
            "total_loss_usd",
            "average_pnl_per_scored_trade_usd",
            "unresolved",
            "tracking_status",
            "next_step",
            "live_order_allowed",
          ]) ?? {},
      );
  }
  return comparison;
}

function compactMilestoneCountdown(source: unknown): DashboardRecord | undefined {
  const countdown = pickObjectFields(source, [
    "ok",
    "generated_at_utc",
    "plain_english",
    "rate_windows",
    "countdown_health",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!countdown) {
    return undefined;
  }
  const milestones = objectField(source, "milestones");
  if (Array.isArray(milestones)) {
    countdown.milestones = milestones
      .filter(
        (milestone): milestone is DashboardRecord =>
          Boolean(milestone) && typeof milestone === "object" && !Array.isArray(milestone),
      )
      .map((milestone) => {
        const compactMilestone =
          pickObjectFields(milestone, [
            "milestone_id",
            "label",
            "status",
            "eta_seconds",
            "eta_label",
            "completion_score",
            "plain_english",
            "live_order_allowed",
            "auto_live_promotion_allowed",
          ]) ?? {};
        const criteria = objectField(milestone, "criteria");
        if (Array.isArray(criteria)) {
          compactMilestone.criteria = criteria
            .filter(
              (criterion): criterion is DashboardRecord =>
                Boolean(criterion) && typeof criterion === "object" && !Array.isArray(criterion),
            )
            .map(
              (criterion) =>
                pickObjectFields(criterion, [
                  "label",
                  "score",
                  "eta_seconds",
                  "eta_label",
                  "status",
                  "detail",
                  "reason_code",
                  "blocking_reason",
                  "rate_source",
                  "rate_per_hour",
                  "sample_size",
                  "current_count",
                  "target_count",
                  "last_source_update_utc",
                  "eligible_for_eta",
                  "live_order_allowed",
                  "auto_live_promotion_allowed",
                ]) ?? {},
            );
        }
        return compactMilestone;
      });
  }
  return countdown;
}

function compactPromotionGap(source: unknown): DashboardRecord | undefined {
  const gap = pickObjectFields(source, [
    "status",
    "plain_english",
    "next_action",
    "top_blocker",
    "blocker_counts",
    "allowed_segment_count",
    "near_miss_segment_count",
    "trainable_rows",
    "quarantined_rows",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!gap) {
    return undefined;
  }
  const segments = objectField(source, "segments");
  if (Array.isArray(segments)) {
    gap.segments = segments
      .filter(
        (segment): segment is DashboardRecord =>
          Boolean(segment) && typeof segment === "object" && !Array.isArray(segment),
      )
      .slice(0, 8)
      .map((segment) => {
        const compactSegment =
          pickObjectFields(segment, [
            "segment_key",
            "domain",
            "promotion_stage",
            "paper_betting_allowed",
            "completion_score",
            "primary_blocker",
            "blockers",
            "next_action",
            "shadow_scored",
            "shadow_accuracy",
            "shadow_pnl_usd",
            "accepted_scored",
            "live_order_allowed",
            "auto_live_promotion_allowed",
          ]) ?? {};
        const criteria = objectField(segment, "criteria");
        if (Array.isArray(criteria)) {
          compactSegment.criteria = criteria
            .filter(
              (criterion): criterion is DashboardRecord =>
                Boolean(criterion) && typeof criterion === "object" && !Array.isArray(criterion),
            )
            .slice(0, 7)
            .map(
              (criterion) =>
                pickObjectFields(criterion, [
                  "label",
                  "score",
                  "detail",
                  "passed",
                  "live_order_allowed",
                  "auto_live_promotion_allowed",
                ]) ?? {},
            );
        }
        return compactSegment;
      });
  }
  const calibrationRepair = objectField(source, "calibration_repair");
  const compactCalibrationRepair = pickObjectFields(calibrationRepair, [
    "status",
    "top_blocker",
    "next_action",
    "repair_segment_count",
    "safe_candidate_rules",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (compactCalibrationRepair) {
    const candidateBehavior = objectField(calibrationRepair, "candidate_behavior");
    const compactCandidateBehavior = pickObjectFields(candidateBehavior, [
      "status",
      "crypto_reprice_active",
      "active_shrink_segment_count",
      "probability_rule",
      "weather_label_rule",
      "accepted_paper_allowed",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]);
    if (compactCandidateBehavior) {
      compactCalibrationRepair.candidate_behavior = compactCandidateBehavior;
    }
    const repairSegments = objectField(calibrationRepair, "segments");
    if (Array.isArray(repairSegments)) {
      compactCalibrationRepair.segments = repairSegments
        .filter(
          (segment): segment is DashboardRecord =>
            Boolean(segment) && typeof segment === "object" && !Array.isArray(segment),
        )
        .slice(0, 6)
        .map(
          (segment) =>
            pickObjectFields(segment, [
              "segment_key",
              "domain",
              "action",
              "reason",
              "shadow_scored",
              "shadow_accuracy",
              "shadow_pnl_usd",
              "shadow_brier_score",
              "shadow_market_brier_score",
              "candidate_minus_market_brier",
              "candidate_weight_cap",
              "accepted_paper_allowed",
              "live_order_allowed",
              "auto_live_promotion_allowed",
            ]) ?? {},
        );
    }
    gap.calibration_repair = compactCalibrationRepair;
  }
  return gap;
}

function compactWeatherCryptoMl(source: unknown): DashboardRecord | undefined {
  const compact = pickObjectFields(source, [
    "status",
    "plain_english",
    "accepted_paper_allowed_segment_count",
    "paper_betting_allowed_segment_count",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!compact) {
    return undefined;
  }
  const promotionGap = compactPromotionGap(objectField(source, "promotion_gap"));
  if (promotionGap) {
    compact.promotion_gap = promotionGap;
  }
  const markovOverlay = pickObjectFields(objectField(source, "markov_microstructure_ml_overlay"), [
    "ok",
    "generated_at_utc",
    "purpose",
    "usage",
    "analyzed_weather_crypto_count",
    "tiny_paper_review_only_count",
    "taker_trap_count",
    "low_data_count",
    "ml_feature_keys",
    "recommended_ml_action",
    "research_only",
    "not_trade_signal",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (markovOverlay) {
    compact.markov_microstructure_ml_overlay = markovOverlay;
  }
  const mlModel = pickObjectFields(objectField(source, "ml_model"), [
    "champion_model_id",
    "champion_status",
    "markov_microstructure_uplift",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (mlModel) {
    compact.ml_model = mlModel;
  }
  const markovFeatureCoverage = pickObjectFields(objectField(source, "markov_feature_coverage"), [
    "ok",
    "coverage_version",
    "generated_at_utc",
    "coverage_status",
    "resolved_safe_markov_rows",
    "pending_safe_markov_rows",
    "due_safe_markov_rows",
    "next_safe_markov_result_known_time_utc",
    "resolved_safe_markov_rows_needed",
    "pending_safe_markov_rows_available_for_future_grading",
    "domains",
    "routing_label_counts",
    "next_action",
    "research_only",
    "not_trade_signal",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (markovFeatureCoverage) {
    compact.markov_feature_coverage = markovFeatureCoverage;
  }
  return compact;
}

function compactMarkovMicrostructure(source: unknown): DashboardRecord | undefined {
  const compact = pickObjectFields(source, [
    "ok",
    "status",
    "generated_at_utc",
    "diagnostic_version",
    "research_only",
    "not_trade_signal",
    "plain_english",
    "summary",
    "study_reference",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!compact) {
    return undefined;
  }
  const markets = objectField(source, "markets");
  if (Array.isArray(markets)) {
    compact.markets = markets
      .filter(
        (market): market is DashboardRecord =>
          Boolean(market) && typeof market === "object" && !Array.isArray(market),
      )
      .slice(0, 6)
      .map(
        (market) =>
          pickObjectFields(market, [
            "market_ticker",
            "title",
            "category",
            "current_yes_price",
            "current_bucket",
            "raw_markov_yes_proxy",
            "becker_longshot_prior",
            "calibrated_probability",
            "market_price",
            "edge_vs_market_pct",
            "confidence_score",
            "confidence_caps",
            "routing_label",
            "sample",
            "transition_heatmap",
            "terminal_distribution",
            "execution",
            "warnings",
            "research_only",
            "not_trade_signal",
            "live_order_allowed",
            "auto_live_promotion_allowed",
          ]) ?? {},
      );
  }
  const calibrationTracking = pickObjectFields(objectField(source, "calibration_tracking"), [
    "bucket_count",
    "plain_english",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (calibrationTracking) {
    const rows = objectField(objectField(source, "calibration_tracking"), "rows");
    if (Array.isArray(rows)) {
      calibrationTracking.rows = rows
        .filter(
          (row): row is DashboardRecord =>
            Boolean(row) && typeof row === "object" && !Array.isArray(row),
        )
        .slice(0, 12)
        .map(
          (row) =>
            pickObjectFields(row, [
              "category",
              "bucket_label",
              "count",
              "wins",
              "actual_win_rate",
              "average_implied_probability",
              "actual_minus_implied_pct",
              "sample_quality",
              "live_order_allowed",
            ]) ?? {},
        );
    }
    compact.calibration_tracking = calibrationTracking;
  }
  return compact;
}

function compactSupremeTradingStrategy(source: unknown): DashboardRecord | undefined {
  const compact = pickObjectFields(source, [
    "ok",
    "schema_version",
    "generated_at_utc",
    "mode",
    "status",
    "confidence_score",
    "current_regime",
    "objective_scores",
    "risk",
    "performance",
    "learning",
    "experiments",
    "model_health",
    "data_health",
    "next_action",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  if (!compact) {
    return undefined;
  }
  const strategyWeights = objectField(source, "strategy_weights");
  if (Array.isArray(strategyWeights)) {
    compact.strategy_weights = strategyWeights
      .filter(
        (row): row is DashboardRecord =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
      .slice(0, 12)
      .map(
        (row) =>
          pickObjectFields(row, [
            "strategy_id",
            "domain",
            "regime_label",
            "weight",
            "train_rows",
            "test_rows",
            "brier_uplift",
            "log_loss_uplift",
            "pnl_uplift_usd",
            "reason",
            "live_order_allowed",
            "auto_live_promotion_allowed",
          ]) ?? {},
      );
  }
  const rationales = objectField(source, "top_rationales");
  if (Array.isArray(rationales)) {
    compact.top_rationales = rationales
      .filter(
        (row): row is DashboardRecord =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
      .slice(0, 6)
      .map(
        (row) =>
          pickObjectFields(row, [
            "title",
            "evidence",
            "impact",
            "live_order_allowed",
            "auto_live_promotion_allowed",
          ]) ?? {},
      );
  }
  return compact;
}

function compactStsReadinessRoadmap(source: unknown): DashboardRecord | undefined {
  const compact = pickObjectFields(source, [
    "ok",
    "mode",
    "generated_at_utc",
    "paper_trading",
    "live_trading",
    "progress_delta",
    "stages",
    "gates",
    "next_actions",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  return compact ?? undefined;
}

function compactStsTradingDashboard(source: unknown): DashboardRecord | undefined {
  const compact = pickObjectFields(source, [
    "ok",
    "generated_at_utc",
    "mode",
    "summary",
    "directed_paper",
    "shadow_learning",
    "proof_promotion",
    "domains",
    "readiness_gates",
    "recent_decisions",
    "live_order_allowed",
    "auto_live_promotion_allowed",
  ]);
  return compact ?? undefined;
}

function compactKalshiWorkspaceSnapshot(snapshot: unknown): DashboardRecord {
  const data = parseDashboardDataObject(snapshot);
  const accelerator = data.accelerator;
  const selfImprovement = data.self_improvement;
  const strategyScorecard = data.strategy_scorecard;
  const strategyComparison = data.strategy_comparison;
  const milestoneCountdown = data.milestone_countdown;
  const strategyGovernor = data.strategy_governor;
  const paperVolume = data.paper_volume_accelerator;
  const opportunityEngine = data.opportunity_engine;
  const performanceSummary = data.performance_summary;
  const learningVelocity = data.learning_velocity;
  const plainEnglishStatus = data.plain_english_status;
  const kalshiControlSurface = data.kalshi_control_surface;
  const cryptoEvidence = data.crypto_evidence;
  const weatherCryptoMl = data.weather_crypto_ml;
  const markovMicrostructure = data.markov_microstructure;
  const supremeTradingStrategy = data.supreme_trading_strategy;
  const stsTradingDashboard = data.sts_trading_dashboard;
  const stsReadinessRoadmap = data.sts_readiness_roadmap;
  const stsReadinessEta = data.sts_readiness_eta;
  const stsDomainOptimizer = data.sts_domain_optimizer;
  const stsAgentAudit = data.sts_agent_audit;
  const stsCryptoFreshCycle = data.sts_crypto_fresh_cycle;
  const stsCryptoFreshWindowDiagnostics = data.sts_crypto_fresh_window_diagnostics;
  const stsCryptoBaselineCalibration = data.sts_crypto_baseline_calibration;
  const stsCryptoProbabilityRecalibrator = data.sts_crypto_probability_recalibrator;
  const stsCryptoSegmentEdge = data.sts_crypto_segment_edge;
  const stsCryptoExecutionRealism = data.sts_crypto_execution_realism;
  const stsCryptoExecutionSelector = data.sts_crypto_execution_selector;
  const stsCryptoExecutionSelectorOutcomes = data.sts_crypto_execution_selector_outcomes;
  const stsCryptoRegimeSelector = data.sts_crypto_regime_selector;
  const stsCryptoRegimeSelectorOutcomes = data.sts_crypto_regime_selector_outcomes;
  const stsCryptoRegimeInverseRepair = data.sts_crypto_regime_inverse_repair;
  const stsDomainLearningOptimizer = data.sts_domain_learning_optimizer;
  const stsWeatherSelectorRepair = data.sts_weather_selector_repair;
  const stsCryptoEvidenceRepair = data.sts_crypto_evidence_repair;
  const stsUnlockQueue = data.sts_unlock_queue;
  const weatherLane = compactWeatherLane(objectField(accelerator, "weather_lane"));
  const compact: DashboardRecord = {
    generated_at_utc: data.generated_at_utc,
    mode: data.mode,
    live_order_allowed: data.live_order_allowed,
    data_quality: data.data_quality,
    dashboard_refresh: data.dashboard_refresh,
    learning_velocity: pickObjectFields(learningVelocity, [
      "status",
      "plain_english",
      "latest_learning_at_utc",
      "latest_learning_age_minutes",
      "latest_shadow_learning_at_utc",
      "latest_shadow_learning_age_minutes",
      "latest_accepted_proof_at_utc",
      "latest_accepted_proof_age_minutes",
      "resolved_last_15m",
      "resolved_last_1h",
      "resolved_last_6h",
      "shadow_resolved_last_1h",
      "category_resolved_last_1h",
      "proof_metrics_exclude_shadow",
      "live_order_allowed",
    ]),
    plain_english_status: pickObjectFields(plainEnglishStatus, [
      "headline",
      "status",
      "tone",
      "bullets",
      "next_steps",
      "live_order_allowed",
    ]),
    live_readiness: data.live_readiness,
    log_counts: data.log_counts,
    warnings: data.warnings,
    top_action: data.top_action,
    kalshi_control_surface: kalshiControlSurface,
    milestone_countdown: compactMilestoneCountdown(milestoneCountdown),
    countdown_health:
      compactMilestoneCountdown(milestoneCountdown)?.countdown_health ?? data.countdown_health,
    accelerator: {
      ...pickObjectFields(accelerator, ["scheduler", "ranked_actions"]),
      ...(weatherLane ? { weather_lane: weatherLane } : {}),
    },
    self_improvement: {
      metrics: pickObjectFields(objectField(selfImprovement, "metrics"), [
        "accuracy",
        "accuracy_sample_size",
        "accuracy_wins",
        "average_pnl_per_scored_trade_usd",
        "brier_score",
        "exploration_paper_decisions",
        "fair_value_source_performance",
        "forward_paper_decisions",
        "latest_scored_decision_utc",
        "latest_scored_outcome_utc",
        "missing_outcome_rate",
        "paper_activity_by_timeframe",
        "paper_performance_by_timeframe",
        "realized_paper_pnl_all_time_usd",
        "realized_paper_pnl_last_24h_usd",
        "realized_paper_pnl_last_7d_usd",
        "scored_decisions",
        "scored_decisions_last_1h",
        "scored_decisions_last_24h",
        "scored_decisions_last_6h",
        "scored_directional_decisions",
        "unresolved_paper_exposure_usd",
      ]),
    },
    strategy_scorecard: {
      summary: pickObjectFields(objectField(strategyScorecard, "summary"), [
        "accuracy",
        "forward_paper_candidates",
        "paused_segments",
        "realized_pnl_usd",
        "scored_accepted_decisions",
      ]),
      trend: pickObjectFields(objectField(strategyScorecard, "trend"), [
        "points",
        "x_axis",
        "y_axis_left",
        "y_axis_right",
      ]),
      improvement_summary: {
        most_important_lesson: pickObjectFields(
          objectField(
            objectField(strategyScorecard, "improvement_summary"),
            "most_important_lesson",
          ),
          ["title", "expected_effect"],
        ),
        what_needs_to_happen_next: objectField(
          objectField(strategyScorecard, "improvement_summary"),
          "what_needs_to_happen_next",
        ),
      },
    },
    strategy_comparison: compactStrategyComparison(strategyComparison),
    strategy_governor: {
      accepted_or_tested_count: objectField(strategyGovernor, "accepted_or_tested_count"),
      action_counts: pickObjectFields(objectField(strategyGovernor, "action_counts"), [
        "ACCEPT_FORWARD_PAPER",
        "ACCEPT_EXPLORATION",
        "ACCEPT_PAPER",
        "FORWARD_PAPER",
        "INVERSE_FORWARD_TEST",
        "SHADOW_ONLY",
        "PAUSE_SEGMENT",
      ]),
      shadow_or_blocked_count: objectField(strategyGovernor, "shadow_or_blocked_count"),
      inverse_forward_tests: objectField(strategyGovernor, "inverse_forward_tests"),
      routed_count: objectField(strategyGovernor, "routed_count"),
      latest_change: pickObjectFields(objectField(strategyGovernor, "latest_change"), [
        "governor_action",
        "plain_language_reason",
      ]),
      top_active_hypothesis: pickObjectFields(
        objectField(strategyGovernor, "top_active_hypothesis"),
        ["governor_action", "plain_language_reason"],
      ),
      top_blocked_losing_lane: pickObjectFields(
        objectField(strategyGovernor, "top_blocked_losing_lane"),
        ["governor_action", "plain_language_reason"],
      ),
    },
    paper_volume_accelerator: {
      metrics: pickObjectFields(objectField(paperVolume, "metrics"), [
        "resolved_outcomes",
        "latest_learning_outcome_age_minutes",
        "latest_scored_outcome_age_minutes",
        "learning_resolved_last_1h",
        "shadow_learning_resolved_last_1h",
        "pending_fast_resolution_count",
        "outcome_backlog",
        "current_learning_bottleneck",
        "what_must_happen_next_to_learn_faster",
      ]),
      rapid_learning_plan: pickObjectFields(objectField(paperVolume, "rapid_learning_plan"), [
        "primary_bottleneck",
      ]),
    },
    paper_trade_accelerator: pickObjectFields(objectField(data, "paper_trade_accelerator"), [
      "validated_weather_crypto_rows",
      "learning_target_rows",
      "rows_needed_to_learning_target",
      "rows_needed_to_profit_proof_target",
      "learning_rows_last_1h",
      "estimated_hours_to_learning_target_at_current_rate",
      "weather_source_freshness_ok",
      "route_mix",
      "route_mix_total",
      "mode",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    crypto_evidence: pickObjectFields(cryptoEvidence, [
      "timestamp_utc",
      "ok",
      "active_crypto_markets_seen",
      "parseable_crypto_markets",
      "created_count",
      "created_by_governor_action",
      "spot_assets_available",
      "plain_english_summary",
      "live_order_allowed",
    ]),
    supreme_trading_strategy: compactSupremeTradingStrategy(supremeTradingStrategy),
    sts_readiness_roadmap: compactStsReadinessRoadmap(stsReadinessRoadmap),
    sts_readiness_eta: pickObjectFields(stsReadinessEta, [
      "ok",
      "mode",
      "generated_at_utc",
      "paper_trading_eta",
      "domain_paper_trading_eta",
      "live_review_eta",
      "plain_english",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_domain_optimizer: pickObjectFields(stsDomainOptimizer, [
      "ok",
      "mode",
      "generated_at_utc",
      "domain_learning_policy",
      "domain_actions",
      "domain_lanes",
      "priority_actions",
      "best_domain_to_improve_next",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_agent_audit: pickObjectFields(stsAgentAudit, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "agent_count",
      "functional_agent_count",
      "average_specialization_score",
      "agents",
      "critical_findings",
      "top_recommendation",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_fresh_cycle: pickObjectFields(stsCryptoFreshCycle, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "crypto_capture",
      "fresh_sts_promotion",
      "global_promotion_allowed_count",
      "paper_eta_label",
      "best_domain_to_improve_next",
      "agent_audit_score",
      "dashboard_refreshed",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_fresh_window_diagnostics: pickObjectFields(stsCryptoFreshWindowDiagnostics, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "fresh_candidate_count",
      "fresh_blocked_count",
      "fresh_promotion_allowed_count",
      "positive_edge_count",
      "clean_but_baseline_blocked_count",
      "clean_but_markov_blocked_count",
      "top_blocker",
      "blocker_counts",
      "result_window_counts",
      "top_fresh_candidates",
      "next_action",
      "plain_english",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_baseline_calibration: pickObjectFields(stsCryptoBaselineCalibration, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "crypto_feature_rows",
      "labeled_crypto_rows",
      "evaluated_crypto_rows",
      "candidate_brier",
      "market_brier",
      "candidate_brier_uplift_vs_market",
      "beats_market_baseline",
      "fresh_clean_but_baseline_blocked_count",
      "calibration_buckets",
      "top_candidate_uplifts",
      "worst_candidate_uplifts",
      "promotion_policy",
      "next_action",
      "plain_english",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_probability_recalibrator: pickObjectFields(stsCryptoProbabilityRecalibrator, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "method",
      "train_rows",
      "test_rows",
      "raw_candidate_brier_test",
      "recalibrated_brier_test",
      "market_brier_test",
      "recalibrated_uplift_vs_raw",
      "recalibrated_uplift_vs_market",
      "improves_raw_candidate",
      "beats_market_baseline",
      "bucket_recalibration",
      "promotion_policy",
      "next_action",
      "plain_english",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_segment_edge: pickObjectFields(stsCryptoSegmentEdge, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "test_rows",
      "segment_count",
      "market_beating_segment_count",
      "top_segments",
      "qualified_shadow_segments",
      "promotion_policy",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_execution_realism: pickObjectFields(stsCryptoExecutionRealism, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "test_rows",
      "segment_count",
      "executable_shadow_edge_count",
      "top_segments",
      "qualified_execution_shadow_segments",
      "promotion_policy",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_execution_selector: pickObjectFields(stsCryptoExecutionSelector, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "candidate_experiment_count",
      "paused_experiment_count",
      "active_shadow_experiments",
      "paused_shadow_experiments",
      "experiment_policy",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_execution_selector_outcomes: pickObjectFields(stsCryptoExecutionSelectorOutcomes, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "experiment_count",
      "forward_recorded_attribution_count",
      "retrospective_shadow_replay_count",
      "resolved_attributed_count",
      "unresolved_attributed_count",
      "top_experiment",
      "experiments",
      "plain_english",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_regime_selector: pickObjectFields(stsCryptoRegimeSelector, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "train_rows",
      "test_rows",
      "minimum_test_rows_per_regime",
      "regime_count",
      "candidate_experiment_count",
      "paused_forward_regime_count",
      "forward_regime_penalties",
      "top_regimes",
      "active_shadow_experiments",
      "plain_english",
      "next_action",
      "experiment_policy",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_regime_selector_outcomes: pickObjectFields(stsCryptoRegimeSelectorOutcomes, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "status",
      "experiment_count",
      "matched_row_count",
      "forward_recorded_experiment_count",
      "forward_recorded_matched_count",
      "forward_recorded_resolved_count",
      "forward_recorded_pending_count",
      "forward_recorded_due_pending_count",
      "forward_recorded_coverage_probe_resolved_count",
      "forward_recorded_coverage_probe_pending_count",
      "forward_recorded_coverage_probe_due_count",
      "forward_recorded_inverse_repair_shadow_resolved_count",
      "forward_recorded_inverse_repair_shadow_pending_count",
      "forward_recorded_inverse_repair_shadow_due_count",
      "inverse_repair_shadow_proof_gate",
      "coverage_probe_failure_cohort_blocks",
      "next_forward_result_due_utc",
      "seconds_until_next_forward_result_due",
      "forward_recorded_pending_samples",
      "retrospective_experiment_count",
      "retrospective_matched_count",
      "retrospective_resolved_count",
      "resolved_attributed_count",
      "forward_recorded_experiments",
      "retrospective_experiments",
      "top_experiment",
      "experiments",
      "resolver_action",
      "resolver_command",
      "plain_english",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_regime_inverse_repair: pickObjectFields(stsCryptoRegimeInverseRepair, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "scanned_forward_regime_outcome_count",
      "repair_count",
      "action_counts",
      "repairs",
      "top_repair",
      "plain_english",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_domain_learning_optimizer: pickObjectFields(stsDomainLearningOptimizer, [
      "ok",
      "mode",
      "generated_at_utc",
      "domain_lanes",
      "best_domain_to_improve_next",
      "domain_separation_policy",
      "plain_english",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_weather_selector_repair: pickObjectFields(stsWeatherSelectorRepair, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "scanned_weather_count",
      "selector_pass_count",
      "selector_pass_rate",
      "top_blockers",
      "top_selector_passes",
      "top_near_misses",
      "selector_policy",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_crypto_evidence_repair: pickObjectFields(stsCryptoEvidenceRepair, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "domain",
      "scanned_crypto_count",
      "fresh_clean_count",
      "stale_but_lineage_repairable_count",
      "top_clean_evidence_blocker",
      "top_blockers",
      "sample_failures",
      "repair_policy",
      "next_action",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_unlock_queue: pickObjectFields(stsUnlockQueue, [
      "ok",
      "schema_version",
      "mode",
      "generated_at_utc",
      "paper_trading_eta_label",
      "promotion_allowed_count",
      "unlock_actions",
      "top_unlock_action",
      "next_action",
      "plain_english",
      "domain_policy",
      "live_order_allowed",
      "auto_live_promotion_allowed",
    ]),
    sts_trading_dashboard: compactStsTradingDashboard(stsTradingDashboard),
    weather_crypto_ml: compactWeatherCryptoMl(weatherCryptoMl),
    markov_microstructure: compactMarkovMicrostructure(markovMicrostructure),
    opportunity_engine: {
      metrics: pickObjectFields(objectField(opportunityEngine, "metrics"), [
        "clean_forward_paper_candidates",
      ]),
      diagnostics: pickObjectFields(objectField(opportunityEngine, "diagnostics"), [
        "plain_english",
      ]),
    },
    performance_summary: {
      best_segment: pickObjectFields(objectField(performanceSummary, "best_segment"), [
        "segment",
        "simulated_pnl_usd",
        "win_rate",
      ]),
      worst_segment: pickObjectFields(objectField(performanceSummary, "worst_segment"), [
        "segment",
        "simulated_pnl_usd",
        "win_rate",
      ]),
    },
  };
  for (const [key, value] of Object.entries(compact)) {
    const pruned = pruneCompactValue(value);
    if (pruned === undefined) {
      delete compact[key];
    } else {
      compact[key] = pruned;
    }
  }
  return compact;
}

function readDashboardDataSnapshot(
  dataPath = resolveKalshiDashboardDataPath(),
): Record<string, unknown> {
  const stat = fs.statSync(dataPath);
  if (
    cachedDashboardDataSnapshot &&
    cachedDashboardDataSnapshot.dataPath === dataPath &&
    cachedDashboardDataSnapshot.mtimeMs === stat.mtimeMs &&
    cachedDashboardDataSnapshot.size === stat.size
  ) {
    return cachedDashboardDataSnapshot.snapshot;
  }
  const raw = fs.readFileSync(dataPath, "utf8");
  const snapshot = parseDashboardDataObject(JSON.parse(raw) as unknown);
  cachedDashboardDataSnapshot = {
    dataPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    snapshot,
  };
  return snapshot;
}

function dashboardDataAgeMs(dataPath: string, now = Date.now()): number | null {
  try {
    return Math.max(0, now - fs.statSync(dataPath).mtimeMs);
  } catch {
    return null;
  }
}

function attachRefreshStatus(
  snapshot: Record<string, unknown>,
  status: DashboardRefreshStatus,
): Record<string, unknown> {
  const refreshStatus: DashboardRecord = {
    in_progress: status.inProgress,
    stale: status.stale,
    age_ms: status.ageMs,
    last_error: status.lastError,
  };
  if (status.suspended !== undefined) {
    refreshStatus.suspended = status.suspended;
  }
  if (status.cacheOnly !== undefined) {
    refreshStatus.cache_only = status.cacheOnly;
  }
  return {
    ...snapshot,
    ...(status.suspended ? { dashboard_refresh_suspended: true } : {}),
    ...(status.cacheOnly ? { cache_only: true } : {}),
    dashboard_refresh: {
      ...refreshStatus,
    },
  };
}

async function runDashboardRefresh(
  python: string,
  script: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(python, [script], {
    cwd: path.dirname(script),
    timeout: KALSHI_DASHBOARD_REFRESH_TIMEOUT_MS,
    maxBuffer: KALSHI_DASHBOARD_MAX_BUFFER_BYTES,
  });
  parseDashboardEnvelope(stdout);
  return readDashboardDataSnapshot(resolveKalshiDashboardDataPath(script));
}

function startDashboardRefreshIfDue(params: {
  python: string;
  script: string;
  dataPath: string;
  now?: number;
}): Promise<unknown> | null {
  const now = params.now ?? Date.now();
  const ageMs = dashboardDataAgeMs(params.dataPath, now);
  const staleEnough =
    ageMs === null || ageMs >= KALSHI_DASHBOARD_BACKGROUND_REFRESH_MIN_INTERVAL_MS;
  const cooldownElapsed =
    now - lastDashboardRefreshStartedAt >= KALSHI_DASHBOARD_BACKGROUND_REFRESH_MIN_INTERVAL_MS;
  if (!staleEnough || !cooldownElapsed) {
    return dashboardRefreshInFlight;
  }
  if (dashboardRefreshInFlight) {
    return dashboardRefreshInFlight;
  }
  lastDashboardRefreshStartedAt = now;
  dashboardRefreshInFlight = dashboardRefreshRunner(params.python, params.script)
    .then((snapshot) => {
      lastDashboardRefreshError = null;
      return snapshot;
    })
    .catch((error: unknown) => {
      lastDashboardRefreshError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      dashboardRefreshInFlight = null;
    });
  return dashboardRefreshInFlight;
}

export async function loadKalshiDashboardSnapshot(opts?: {
  forceRefresh?: boolean;
}): Promise<unknown> {
  const script = resolveKalshiDashboardScript();
  const dataPath = resolveKalshiDashboardDataPath(script);
  const ageMs = dashboardDataAgeMs(dataPath);
  if (isKalshiDashboardRefreshSuspended(script)) {
    try {
      const snapshot = readDashboardDataSnapshot(dataPath);
      return attachRefreshStatus(snapshot, {
        inProgress: false,
        stale: ageMs === null || ageMs >= KALSHI_DASHBOARD_BACKGROUND_REFRESH_MIN_INTERVAL_MS,
        ageMs,
        lastError: lastDashboardRefreshError,
        suspended: true,
        cacheOnly: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Kalshi dashboard refresh suspended and no valid cached dashboard data is available: ${message}`,
      );
    }
  }
  const python = resolveExecutable(KALSHI_PYTHON_CANDIDATES);
  if (opts?.forceRefresh) {
    lastDashboardRefreshStartedAt = Date.now();
    if (!dashboardRefreshInFlight) {
      dashboardRefreshInFlight = dashboardRefreshRunner(python, script)
        .then((snapshot) => {
          lastDashboardRefreshError = null;
          return snapshot;
        })
        .catch((error: unknown) => {
          lastDashboardRefreshError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => {
          dashboardRefreshInFlight = null;
        });
    }
    const snapshot = await dashboardRefreshInFlight;
    return attachRefreshStatus(parseDashboardDataObject(snapshot), {
      inProgress: false,
      stale: false,
      ageMs: dashboardDataAgeMs(dataPath),
      lastError: lastDashboardRefreshError,
    });
  }
  const refresh = startDashboardRefreshIfDue({ python, script, dataPath });
  if (refresh) {
    void refresh.catch(() => undefined);
  }
  try {
    const snapshot = readDashboardDataSnapshot(dataPath);
    return attachRefreshStatus(snapshot, {
      inProgress: Boolean(refresh),
      stale: ageMs === null || ageMs >= KALSHI_DASHBOARD_BACKGROUND_REFRESH_MIN_INTERVAL_MS,
      ageMs,
      lastError: lastDashboardRefreshError,
    });
  } catch (readError) {
    if (!refresh) {
      throw readError;
    }
    const refreshed = await refresh;
    return attachRefreshStatus(parseDashboardDataObject(refreshed), {
      inProgress: false,
      stale: false,
      ageMs: dashboardDataAgeMs(dataPath),
      lastError: lastDashboardRefreshError,
    });
  }
}

export function createKalshiDashboardHandlers(loadSnapshot: LoadSnapshot): GatewayRequestHandlers {
  return {
    "kalshi.dashboard.snapshot": async ({ params, respond }) => {
      try {
        const snapshot = await loadSnapshot({
          forceRefresh: objectField(params, "force_refresh") === true,
        });
        const auditTables = auditTableConfig(objectField(params, "audit_tables"));
        respond(
          true,
          params.view === "workspace"
            ? compactKalshiWorkspaceSnapshot(snapshot)
            : applyAuditTableSlices(snapshot, auditTables),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Kalshi dashboard unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
  };
}

export const kalshiDashboardHandlers = createKalshiDashboardHandlers(loadKalshiDashboardSnapshot);

export const __testing = {
  parseDashboardEnvelope,
  parseDashboardDataObject,
  compactKalshiWorkspaceSnapshot,
  applyAuditTableSlices,
  auditTableConfig,
  readDashboardDataSnapshot,
  resolveKalshiDashboardDataPath,
  resolveKalshiDashboardRefreshGuardPath,
  resolveKalshiDashboardScript,
  resolveExecutable,
  isKalshiDashboardRefreshSuspended,
  attachRefreshStatus,
  loadKalshiDashboardSnapshot,
  setDashboardRefreshRunnerForTest(runner: DashboardRefreshRunner): void {
    dashboardRefreshRunner = runner;
  },
  setKalshiDashboardScriptForTest(scriptPath: string): void {
    kalshiDashboardScriptOverrideForTest = scriptPath;
    cachedKalshiDashboardScript = null;
    cachedDashboardDataSnapshot = null;
  },
  resetKalshiDashboardTestingState(): void {
    dashboardRefreshInFlight = null;
    lastDashboardRefreshStartedAt = 0;
    lastDashboardRefreshError = null;
    cachedKalshiDashboardScript = null;
    kalshiDashboardScriptOverrideForTest = null;
    cachedKalshiDashboardPython = null;
    cachedDashboardDataSnapshot = null;
    dashboardRefreshRunner = runDashboardRefresh;
  },
};
