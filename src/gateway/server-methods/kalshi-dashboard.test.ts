import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, createKalshiDashboardHandlers } from "./kalshi-dashboard.js";

type DashboardFixture = {
  dataPath: string;
  guardPath: string;
  root: string;
  scriptPath: string;
};

function createDashboardFixture(opts?: {
  cache?: Record<string, unknown>;
  guardActive?: boolean;
}): DashboardFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kalshi-dashboard-guard-"));
  const kalshiDir = path.join(root, "work", "scripts", "kalshi");
  fs.mkdirSync(kalshiDir, { recursive: true });
  const scriptPath = path.join(kalshiDir, "kalshi_dashboard.py");
  fs.writeFileSync(scriptPath, "raise SystemExit('test fixture must not be executed')\n");
  const dataPath = path.join(kalshiDir, "dashboard", "kalshi_dashboard_data.json");
  if (opts?.cache) {
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(opts.cache));
  }
  const guardPath = path.join(kalshiDir, "tmp", "dashboard_refresh_suspended.flag");
  if (opts?.guardActive) {
    fs.mkdirSync(path.dirname(guardPath), { recursive: true });
    fs.writeFileSync(guardPath, "suspended\n");
  }
  return { dataPath, guardPath, root, scriptPath };
}

async function withDashboardFixture(
  opts: Parameters<typeof createDashboardFixture>[0],
  fn: (fixture: DashboardFixture) => Promise<void> | void,
) {
  const fixture = createDashboardFixture(opts);
  __testing.resetKalshiDashboardTestingState();
  __testing.setKalshiDashboardScriptForTest(fixture.scriptPath);
  try {
    await fn(fixture);
  } finally {
    __testing.resetKalshiDashboardTestingState();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

describe("kalshi dashboard gateway method", () => {
  beforeEach(() => {
    vi.useRealTimers();
    __testing.resetKalshiDashboardTestingState();
  });

  it("parses read-only dashboard data", () => {
    const data = __testing.parseDashboardEnvelope(
      JSON.stringify({ ok: true, data: { live_order_allowed: false, paper: {} } }),
    );

    expect(data).toEqual({ live_order_allowed: false, paper: {} });
  });

  it("rejects data that could allow live orders", () => {
    expect(() =>
      __testing.parseDashboardEnvelope(
        JSON.stringify({ ok: true, data: { live_order_allowed: true } }),
      ),
    ).toThrow(/live_order_allowed/);
  });

  it("validates cached dashboard data before serving it", () => {
    expect(
      __testing.parseDashboardDataObject({
        generated_at_utc: "2026-05-08T00:00:00Z",
        live_order_allowed: false,
      }),
    ).toEqual({
      generated_at_utc: "2026-05-08T00:00:00Z",
      live_order_allowed: false,
    });

    expect(() =>
      __testing.parseDashboardDataObject({
        generated_at_utc: "2026-05-08T00:00:00Z",
        live_order_allowed: true,
      }),
    ).toThrow(/live_order_allowed/);
  });

  it("reuses parsed dashboard data until the data file changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kalshi-dashboard-"));
    const dataPath = path.join(dir, "kalshi_dashboard_data.json");
    try {
      fs.writeFileSync(dataPath, JSON.stringify({ live_order_allowed: false, version: 1 }));

      const first = __testing.readDashboardDataSnapshot(dataPath);
      const second = __testing.readDashboardDataSnapshot(dataPath);

      expect(second).toBe(first);

      fs.writeFileSync(dataPath, JSON.stringify({ live_order_allowed: false, version: "changed" }));
      const nextMtime = new Date(Date.now() + 10_000);
      fs.utimesSync(dataPath, nextMtime, nextMtime);

      const third = __testing.readDashboardDataSnapshot(dataPath);

      expect(third).not.toBe(first);
      expect(third).toMatchObject({ live_order_allowed: false, version: "changed" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the dashboard refresh suspension sentinel next to the dashboard script", async () => {
    await withDashboardFixture({}, ({ guardPath, scriptPath }) => {
      expect(__testing.resolveKalshiDashboardRefreshGuardPath(scriptPath)).toBe(guardPath);
    });
  });

  it("returns cache-only data and does not launch refresh when the guard is active", async () => {
    await withDashboardFixture(
      { cache: { live_order_allowed: false, version: "cached" }, guardActive: true },
      async ({ dataPath }) => {
        const runner = vi.fn(async () => ({ live_order_allowed: false, version: "refreshed" }));
        __testing.setDashboardRefreshRunnerForTest(runner);
        const before = fs.statSync(dataPath);

        const snapshot = (await __testing.loadKalshiDashboardSnapshot()) as Record<string, unknown>;

        expect(runner).not.toHaveBeenCalled();
        expect(fs.statSync(dataPath).mtimeMs).toBe(before.mtimeMs);
        expect(snapshot).toMatchObject({
          live_order_allowed: false,
          version: "cached",
          dashboard_refresh_suspended: true,
          cache_only: true,
          dashboard_refresh: {
            in_progress: false,
            suspended: true,
            cache_only: true,
          },
        });
      },
    );
  });

  it("ignores force refresh and returns cached data while the guard is active", async () => {
    await withDashboardFixture(
      { cache: { live_order_allowed: false, version: "cached" }, guardActive: true },
      async ({ dataPath }) => {
        const runner = vi.fn(async () => ({ live_order_allowed: false, version: "forced" }));
        __testing.setDashboardRefreshRunnerForTest(runner);
        const before = fs.statSync(dataPath);

        const snapshot = (await __testing.loadKalshiDashboardSnapshot({
          forceRefresh: true,
        })) as Record<string, unknown>;

        expect(runner).not.toHaveBeenCalled();
        expect(fs.statSync(dataPath).mtimeMs).toBe(before.mtimeMs);
        expect(snapshot).toMatchObject({
          live_order_allowed: false,
          version: "cached",
          dashboard_refresh_suspended: true,
          cache_only: true,
        });
      },
    );
  });

  it("fails closed without writing dashboard cache when the guard is active and cache is missing", async () => {
    await withDashboardFixture({ guardActive: true }, async ({ dataPath }) => {
      const runner = vi.fn(async () => ({ live_order_allowed: false, version: "refreshed" }));
      __testing.setDashboardRefreshRunnerForTest(runner);

      await expect(__testing.loadKalshiDashboardSnapshot()).rejects.toThrow(
        /refresh suspended and no valid cached dashboard data is available/,
      );

      expect(runner).not.toHaveBeenCalled();
      expect(fs.existsSync(dataPath)).toBe(false);
    });
  });

  it("keeps live_order_allowed safety validation while the guard is active", async () => {
    await withDashboardFixture(
      { cache: { live_order_allowed: true }, guardActive: true },
      async () => {
        const runner = vi.fn(async () => ({ live_order_allowed: false, version: "refreshed" }));
        __testing.setDashboardRefreshRunnerForTest(runner);

        await expect(__testing.loadKalshiDashboardSnapshot()).rejects.toThrow(/live_order_allowed/);

        expect(runner).not.toHaveBeenCalled();
      },
    );
  });

  it("preserves force refresh behavior when the guard is inactive", async () => {
    await withDashboardFixture({}, async () => {
      const runner = vi.fn(async () => ({ live_order_allowed: false, version: "refreshed" }));
      __testing.setDashboardRefreshRunnerForTest(runner);

      const snapshot = (await __testing.loadKalshiDashboardSnapshot({
        forceRefresh: true,
      })) as Record<string, unknown>;

      expect(runner).toHaveBeenCalledTimes(1);
      expect(snapshot).toMatchObject({
        live_order_allowed: false,
        version: "refreshed",
        dashboard_refresh: {
          in_progress: false,
          stale: false,
          last_error: null,
        },
      });
      expect(snapshot).not.toHaveProperty("dashboard_refresh_suspended");
      expect(snapshot).not.toHaveProperty("cache_only");
    });
  });

  it("preserves cached read behavior when the guard is inactive and cache is fresh", async () => {
    await withDashboardFixture(
      { cache: { live_order_allowed: false, version: "cached" } },
      async () => {
        const runner = vi.fn(async () => ({ live_order_allowed: false, version: "refreshed" }));
        __testing.setDashboardRefreshRunnerForTest(runner);

        const snapshot = (await __testing.loadKalshiDashboardSnapshot()) as Record<string, unknown>;
        const refresh = snapshot.dashboard_refresh as Record<string, unknown>;

        expect(runner).not.toHaveBeenCalled();
        expect(snapshot).toMatchObject({
          live_order_allowed: false,
          version: "cached",
        });
        expect(refresh).toMatchObject({ in_progress: false });
        expect(refresh).not.toHaveProperty("suspended");
        expect(refresh).not.toHaveProperty("cache_only");
        expect(snapshot).not.toHaveProperty("dashboard_refresh_suspended");
        expect(snapshot).not.toHaveProperty("cache_only");
      },
    );
  });

  it("adds refresh status without mutating dashboard metrics", () => {
    expect(
      __testing.attachRefreshStatus(
        { live_order_allowed: false, paper: { total_decisions: 10 } },
        { inProgress: true, stale: true, ageMs: 61_000, lastError: null },
      ),
    ).toEqual({
      live_order_allowed: false,
      paper: { total_decisions: 10 },
      dashboard_refresh: {
        in_progress: true,
        stale: true,
        age_ms: 61_000,
        last_error: null,
      },
    });
  });

  it("compacts workspace snapshots to the fields the live workspace needs", () => {
    const compact = __testing.compactKalshiWorkspaceSnapshot({
      generated_at_utc: "2026-05-13T21:08:38Z",
      live_order_allowed: false,
      accelerator: {
        scheduler: { scheduled_run_count: 10 },
        weather_lane: { city_coverage_status: Array.from({ length: 100 }, (_, index) => index) },
      },
      self_improvement: {
        metrics: {
          paper_performance_by_timeframe: {
            "24h": { net_pnl_usd: 1.25, scored_decisions: 2 },
          },
          scored_decisions: 12,
        },
        verbose_rows: Array.from({ length: 100 }, (_, index) => index),
      },
      strategy_scorecard: {
        summary: { accuracy: 0.6 },
        segments: Array.from({ length: 100 }, (_, index) => index),
        trend: {
          points: [{ accuracy: 0.5, cumulative_pnl_usd: 1, scored_at_utc: "2026-05-13T00:00:00Z" }],
        },
      },
      strategy_comparison: {
        ok: true,
        plain_english: "Every named strategy lane is visible.",
        actual_summary: { standard_pnl_usd: -10, standard_scored: 10, live_order_allowed: false },
        rows: [
          {
            strategy_id: "standard_strategy",
            display_name: "Standard Strategy",
            role: "baseline",
            domains: { weather: 3 },
            decisions: 4,
            accepted: 3,
            shadow_decisions: 1,
            scored: 2,
            accuracy: 0.5,
            paper_pnl_usd: -1.25,
            average_pnl_per_scored_trade_usd: -0.625,
            unresolved: 1,
            tracking_status: "baseline",
            next_step: "Keep as control.",
            massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
            live_order_allowed: false,
          },
        ],
        massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      learning_velocity: {
        status: "HIGH_SPEED_LEARNING",
        resolved_last_1h: 34,
        shadow_resolved_last_1h: 34,
        latest_learning_age_minutes: 2.5,
        massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
        live_order_allowed: false,
      },
      milestone_countdown: {
        ok: true,
        generated_at_utc: "2026-05-13T21:08:38Z",
        plain_english: "Waiting means no defensible ETA.",
        rate_windows: {
          rate_source: "accepted_forward_paper_only",
          selected_proof_qualified_window: null,
          proof_qualified_rate_per_hour: null,
        },
        milestones: [
          {
            milestone_id: "proof",
            label: "Proof",
            status: "waiting",
            eta_seconds: null,
            eta_label: "Waiting",
            completion_score: 3,
            plain_english: "Proof needs more accepted paper outcomes.",
            criteria: [
              {
                label: "Count",
                score: 3,
                eta_seconds: 7200,
                eta_label: "0d 2h 0m",
                detail: "30/100 accepted forward-paper outcomes.",
                massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
                live_order_allowed: false,
              },
            ],
            massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
        ],
        massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      plain_english_status: {
        headline: "Shadow learning is fresh while accepted proof is gated.",
        next_steps: ["Keep scoring weather and crypto shadow outcomes."],
        internal_rows: Array.from({ length: 100 }, (_, index) => index),
        live_order_allowed: false,
      },
      crypto_evidence: {
        active_crypto_markets_seen: 10,
        parseable_crypto_markets: 5,
        created_count: 5,
        raw_markets: Array.from({ length: 100 }, (_, index) => index),
        live_order_allowed: false,
      },
      supreme_trading_strategy: {
        ok: true,
        schema_version: "sts-v1",
        generated_at_utc: "2026-05-13T21:08:38Z",
        mode: "PAPER_ONLY",
        status: "learning",
        confidence_score: 0.62,
        current_regime: {
          label: "stale_source",
          confidence_score: 0.65,
          drivers: ["Outcome fetch gap."],
          live_order_allowed: false,
        },
        objective_scores: { accuracy: 0.8, profitability: 0, learning_speed: 0.6 },
        strategy_weights: [
          {
            strategy_id: "market_implied_baseline",
            domain: "all",
            regime_label: "stale_source",
            weight: 0.75,
            train_rows: 400,
            test_rows: 120,
            reason: "Market baseline retained.",
            massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
            live_order_allowed: false,
          },
        ],
        top_rationales: [
          {
            title: "Market baseline remains the champion",
            evidence: "Out-of-sample challenger has not won.",
            impact: "Keep STS paper-only.",
            massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
            live_order_allowed: false,
          },
        ],
        risk: {
          primary_blocker: "outcome_fetch_gap",
          live_order_allowed: false,
        },
        performance: { champion_status: "market_champion_retained" },
        learning: { sts_feature_rows: 6401 },
        model_health: { observability_status: "degraded" },
        data_health: { market_telemetry_ok: true },
        next_action: "Repair outcome fetch coverage.",
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      weather_crypto_ml: {
        status: "shadow_learning_only",
        plain_english: "Weather/crypto ML is enforcing shadow-first learning.",
        accepted_paper_allowed_segment_count: 0,
        paper_betting_allowed_segment_count: 0,
        promotion_gap: {
          status: "blocked",
          next_action: "Collect targeted shadow labels.",
          top_blocker: "count",
          blocker_counts: { count: 2 },
          allowed_segment_count: 0,
          near_miss_segment_count: 1,
          trainable_rows: 92,
          quarantined_rows: 7,
          segments: [
            {
              segment_key: "weather|HOUSTON|low_temperature|below|yes",
              completion_score: 7.1,
              criteria: [{ label: "Count", score: 0.4 }],
              live_order_allowed: false,
            },
          ],
          calibration_repair: {
            status: "repair_required",
            top_blocker: "brier",
            next_action: "Repair Brier first.",
            repair_segment_count: 1,
            safe_candidate_rules: ["Accepted paper stays closed when model Brier is worse."],
            candidate_behavior: {
              status: "active",
              crypto_reprice_active: true,
              active_shrink_segment_count: 1,
              probability_rule: "market + (raw - market) * cap",
              weather_label_rule: "Brier wins only",
              accepted_paper_allowed: false,
              raw_debug_rows: Array.from({ length: 100 }, (_, index) => index),
              live_order_allowed: false,
            },
            segments: [
              {
                segment_key: "crypto|ETH|crypto_price_threshold|no",
                action: "shrink_to_market",
                candidate_weight_cap: 0.66,
                accepted_paper_allowed: false,
                raw_debug_rows: Array.from({ length: 100 }, (_, index) => index),
                live_order_allowed: false,
              },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      markov_microstructure: {
        ok: true,
        status: "research_active",
        generated_at_utc: "2026-05-13T21:08:38Z",
        diagnostic_version: "markov-microstructure-research-v1",
        research_only: true,
        not_trade_signal: true,
        summary: {
          analyzed_market_count: 2,
          low_data_market_count: 1,
          taker_trap_count: 1,
          tiny_paper_review_only_count: 0,
          plain_english: "Research-only probability diagnostics are live.",
          live_order_allowed: false,
        },
        study_reference: {
          author: "Jonathan Becker",
          dataset_summary: "72.1M Kalshi trades / $18.26B notional.",
          live_order_allowed: false,
        },
        markets: [
          {
            market_ticker: "KXWEATHER",
            title: "Weather fixture",
            category: "weather",
            raw_markov_yes_proxy: 0.55,
            calibrated_probability: 0.53,
            edge_vs_market_pct: 2,
            confidence_score: 6,
            routing_label: "OBSERVE_ONLY",
            sample: { current_row_transitions: 29 },
            transition_heatmap: { matrix: [[1]], row_counts: [29], current_bucket: 4 },
            execution: { yes_maker_edge_pct: 1.2, yes_taker_edge_pct: -1.1 },
            massive_debug_rows: Array.from({ length: 100 }, (_, index) => index),
            live_order_allowed: false,
          },
        ],
        calibration_tracking: {
          bucket_count: 1,
          plain_english: "Resolved paper outcomes by bucket.",
          rows: [
            {
              category: "weather",
              bucket_label: "40-50¢",
              count: 8,
              actual_win_rate: 0.5,
              average_implied_probability: 0.45,
              actual_minus_implied_pct: 5,
              sample_quality: "low_sample",
              live_order_allowed: false,
            },
          ],
          live_order_allowed: false,
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
    });

    expect(compact).toEqual({
      generated_at_utc: "2026-05-13T21:08:38Z",
      live_order_allowed: false,
      accelerator: {
        scheduler: { scheduled_run_count: 10 },
      },
      self_improvement: {
        metrics: {
          paper_performance_by_timeframe: {
            "24h": { net_pnl_usd: 1.25, scored_decisions: 2 },
          },
          scored_decisions: 12,
        },
      },
      strategy_scorecard: {
        summary: { accuracy: 0.6 },
        trend: {
          points: [{ accuracy: 0.5, cumulative_pnl_usd: 1, scored_at_utc: "2026-05-13T00:00:00Z" }],
        },
      },
      strategy_comparison: {
        ok: true,
        plain_english: "Every named strategy lane is visible.",
        actual_summary: { standard_pnl_usd: -10, standard_scored: 10, live_order_allowed: false },
        rows: [
          {
            strategy_id: "standard_strategy",
            display_name: "Standard Strategy",
            role: "baseline",
            domains: { weather: 3 },
            decisions: 4,
            accepted: 3,
            shadow_decisions: 1,
            scored: 2,
            accuracy: 0.5,
            paper_pnl_usd: -1.25,
            average_pnl_per_scored_trade_usd: -0.625,
            unresolved: 1,
            tracking_status: "baseline",
            next_step: "Keep as control.",
            live_order_allowed: false,
          },
        ],
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      learning_velocity: {
        status: "HIGH_SPEED_LEARNING",
        resolved_last_1h: 34,
        shadow_resolved_last_1h: 34,
        latest_learning_age_minutes: 2.5,
        live_order_allowed: false,
      },
      milestone_countdown: {
        ok: true,
        generated_at_utc: "2026-05-13T21:08:38Z",
        plain_english: "Waiting means no defensible ETA.",
        rate_windows: {
          rate_source: "accepted_forward_paper_only",
          selected_proof_qualified_window: null,
          proof_qualified_rate_per_hour: null,
        },
        milestones: [
          {
            milestone_id: "proof",
            label: "Proof",
            status: "waiting",
            eta_seconds: null,
            eta_label: "Waiting",
            completion_score: 3,
            plain_english: "Proof needs more accepted paper outcomes.",
            criteria: [
              {
                label: "Count",
                score: 3,
                eta_seconds: 7200,
                eta_label: "0d 2h 0m",
                detail: "30/100 accepted forward-paper outcomes.",
                live_order_allowed: false,
              },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
        ],
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      plain_english_status: {
        headline: "Shadow learning is fresh while accepted proof is gated.",
        next_steps: ["Keep scoring weather and crypto shadow outcomes."],
        live_order_allowed: false,
      },
      crypto_evidence: {
        active_crypto_markets_seen: 10,
        parseable_crypto_markets: 5,
        created_count: 5,
        live_order_allowed: false,
      },
      supreme_trading_strategy: {
        ok: true,
        schema_version: "sts-v1",
        generated_at_utc: "2026-05-13T21:08:38Z",
        mode: "PAPER_ONLY",
        status: "learning",
        confidence_score: 0.62,
        current_regime: {
          label: "stale_source",
          confidence_score: 0.65,
          drivers: ["Outcome fetch gap."],
          live_order_allowed: false,
        },
        objective_scores: { accuracy: 0.8, profitability: 0, learning_speed: 0.6 },
        strategy_weights: [
          {
            strategy_id: "market_implied_baseline",
            domain: "all",
            regime_label: "stale_source",
            weight: 0.75,
            train_rows: 400,
            test_rows: 120,
            reason: "Market baseline retained.",
            live_order_allowed: false,
          },
        ],
        top_rationales: [
          {
            title: "Market baseline remains the champion",
            evidence: "Out-of-sample challenger has not won.",
            impact: "Keep STS paper-only.",
            live_order_allowed: false,
          },
        ],
        risk: {
          primary_blocker: "outcome_fetch_gap",
          live_order_allowed: false,
        },
        performance: { champion_status: "market_champion_retained" },
        learning: { sts_feature_rows: 6401 },
        model_health: { observability_status: "degraded" },
        data_health: { market_telemetry_ok: true },
        next_action: "Repair outcome fetch coverage.",
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      weather_crypto_ml: {
        status: "shadow_learning_only",
        plain_english: "Weather/crypto ML is enforcing shadow-first learning.",
        accepted_paper_allowed_segment_count: 0,
        paper_betting_allowed_segment_count: 0,
        promotion_gap: {
          status: "blocked",
          next_action: "Collect targeted shadow labels.",
          top_blocker: "count",
          blocker_counts: { count: 2 },
          allowed_segment_count: 0,
          near_miss_segment_count: 1,
          trainable_rows: 92,
          quarantined_rows: 7,
          segments: [
            {
              segment_key: "weather|HOUSTON|low_temperature|below|yes",
              completion_score: 7.1,
              criteria: [{ label: "Count", score: 0.4 }],
              live_order_allowed: false,
            },
          ],
          calibration_repair: {
            status: "repair_required",
            top_blocker: "brier",
            next_action: "Repair Brier first.",
            repair_segment_count: 1,
            safe_candidate_rules: ["Accepted paper stays closed when model Brier is worse."],
            candidate_behavior: {
              status: "active",
              crypto_reprice_active: true,
              active_shrink_segment_count: 1,
              probability_rule: "market + (raw - market) * cap",
              weather_label_rule: "Brier wins only",
              accepted_paper_allowed: false,
              live_order_allowed: false,
            },
            segments: [
              {
                segment_key: "crypto|ETH|crypto_price_threshold|no",
                action: "shrink_to_market",
                candidate_weight_cap: 0.66,
                accepted_paper_allowed: false,
                live_order_allowed: false,
              },
            ],
            live_order_allowed: false,
            auto_live_promotion_allowed: false,
          },
          live_order_allowed: false,
          auto_live_promotion_allowed: false,
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
      markov_microstructure: {
        ok: true,
        status: "research_active",
        generated_at_utc: "2026-05-13T21:08:38Z",
        diagnostic_version: "markov-microstructure-research-v1",
        research_only: true,
        not_trade_signal: true,
        summary: {
          analyzed_market_count: 2,
          low_data_market_count: 1,
          taker_trap_count: 1,
          tiny_paper_review_only_count: 0,
          plain_english: "Research-only probability diagnostics are live.",
          live_order_allowed: false,
        },
        study_reference: {
          author: "Jonathan Becker",
          dataset_summary: "72.1M Kalshi trades / $18.26B notional.",
          live_order_allowed: false,
        },
        markets: [
          {
            market_ticker: "KXWEATHER",
            title: "Weather fixture",
            category: "weather",
            raw_markov_yes_proxy: 0.55,
            calibrated_probability: 0.53,
            edge_vs_market_pct: 2,
            confidence_score: 6,
            routing_label: "OBSERVE_ONLY",
            sample: { current_row_transitions: 29 },
            transition_heatmap: { matrix: [[1]], row_counts: [29], current_bucket: 4 },
            execution: { yes_maker_edge_pct: 1.2, yes_taker_edge_pct: -1.1 },
            live_order_allowed: false,
          },
        ],
        calibration_tracking: {
          bucket_count: 1,
          plain_english: "Resolved paper outcomes by bucket.",
          rows: [
            {
              category: "weather",
              bucket_label: "40-50¢",
              count: 8,
              actual_win_rate: 0.5,
              average_implied_probability: 0.45,
              actual_minus_implied_pct: 5,
              sample_quality: "low_sample",
              live_order_allowed: false,
            },
          ],
          live_order_allowed: false,
        },
        live_order_allowed: false,
        auto_live_promotion_allowed: false,
      },
    });
  });

  it("keeps crypto regime coverage and inverse repair diagnostics in compact workspace snapshots", () => {
    const compact = __testing.compactKalshiWorkspaceSnapshot({
      generated_at_utc: "2026-05-30T23:45:00Z",
      live_order_allowed: false,
      sts_crypto_regime_selector_outcomes: {
        forward_recorded_coverage_probe_resolved_count: 15,
        forward_recorded_coverage_probe_pending_count: 8,
        forward_recorded_coverage_probe_due_count: 1,
        forward_recorded_inverse_repair_shadow_resolved_count: 3,
        forward_recorded_inverse_repair_shadow_pending_count: 2,
        forward_recorded_inverse_repair_shadow_due_count: 1,
        inverse_repair_shadow_proof_gate: {
          status: "waiting_for_inverse_repair_shadow_outcomes",
          resolved_count: 3,
          target_resolved_shadow_outcomes: 10,
          counts_for_live_readiness: false,
          live_order_allowed: false,
        },
        coverage_probe_failure_cohort_blocks: [
          {
            coverage_cohort_key: "coverage_cohort:side=no|hour=18",
            resolved_count: 5,
            loss_count: 4,
            paper_pnl_usd: -2.5,
            action: "STS_COVERAGE_PROBE_COHORT_BLOCK",
            counts_for_live_readiness: false,
          },
        ],
        internal_debug_rows: Array.from({ length: 100 }, (_, index) => index),
        live_order_allowed: false,
      },
    });

    expect(compact.sts_crypto_regime_selector_outcomes).toEqual({
      forward_recorded_coverage_probe_resolved_count: 15,
      forward_recorded_coverage_probe_pending_count: 8,
      forward_recorded_coverage_probe_due_count: 1,
      forward_recorded_inverse_repair_shadow_resolved_count: 3,
      forward_recorded_inverse_repair_shadow_pending_count: 2,
      forward_recorded_inverse_repair_shadow_due_count: 1,
      inverse_repair_shadow_proof_gate: {
        status: "waiting_for_inverse_repair_shadow_outcomes",
        resolved_count: 3,
        target_resolved_shadow_outcomes: 10,
        counts_for_live_readiness: false,
        live_order_allowed: false,
      },
      coverage_probe_failure_cohort_blocks: [
        {
          coverage_cohort_key: "coverage_cohort:side=no|hour=18",
          resolved_count: 5,
          loss_count: 4,
          paper_pnl_usd: -2.5,
          action: "STS_COVERAGE_PROBE_COHORT_BLOCK",
          counts_for_live_readiness: false,
        },
      ],
      live_order_allowed: false,
    });
  });

  it("keeps current weather trading blockers in compact workspace snapshots", () => {
    const compact = __testing.compactKalshiWorkspaceSnapshot({
      generated_at_utc: "2026-05-26T20:20:00Z",
      live_order_allowed: false,
      accelerator: {
        scheduler: { scheduled_run_count: 12 },
        weather_lane: {
          latest_discovery_trade_ready: 0,
          latest_run_trade_ready: 0,
          latest_candidate_created_count: 0,
          latest_candidate_skipped_reasons: { result_time_already_due: 43 },
          stale_discovery_suppressed: true,
          why_not_trading: "Latest weather paper-candidate pass created 0 paper trades.",
          live_order_allowed: false,
          weather_expansion: {
            active_trade_ready_city_count: 0,
            active_trade_ready_cities: [],
            current_trade_ready_note: "Prior weather discovery was stale.",
            live_order_allowed: false,
          },
        },
      },
    });

    expect(compact.accelerator).toEqual({
      scheduler: { scheduled_run_count: 12 },
      weather_lane: {
        latest_discovery_trade_ready: 0,
        latest_run_trade_ready: 0,
        latest_candidate_created_count: 0,
        latest_candidate_skipped_reasons: { result_time_already_due: 43 },
        stale_discovery_suppressed: true,
        why_not_trading: "Latest weather paper-candidate pass created 0 paper trades.",
        live_order_allowed: false,
        weather_expansion: {
          active_trade_ready_city_count: 0,
          active_trade_ready_cities: [],
          current_trade_ready_note: "Prior weather discovery was stale.",
          live_order_allowed: false,
        },
      },
    });
  });

  it("passes force refresh through to the dashboard loader", async () => {
    const respond = vi.fn();
    const loadSnapshot = vi.fn(async () => ({
      live_order_allowed: false,
      mode: "READ_ONLY",
    }));
    const handlers = createKalshiDashboardHandlers(loadSnapshot);

    await handlers["kalshi.dashboard.snapshot"]({
      req: { type: "req", id: "1", method: "kalshi.dashboard.snapshot" },
      params: { force_refresh: true, view: "workspace" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(loadSnapshot).toHaveBeenCalledWith({ forceRefresh: true });
    expect(respond).toHaveBeenCalledWith(true, {
      live_order_allowed: false,
      mode: "READ_ONLY",
    });
  });

  it("server-slices full audit tables before sending them to the browser", () => {
    const snapshot = __testing.applyAuditTableSlices(
      {
        live_order_allowed: false,
        pending_paper_trades: {
          count: 65,
          trades: Array.from({ length: 65 }, (_, index) => ({
            market_ticker: `KXPENDING-${index}`,
          })),
        },
        recent_paper_bets: {
          trades: Array.from({ length: 3 }, (_, index) => ({ market_ticker: `KXRECENT-${index}` })),
        },
      },
      {
        pending: { page: 2, query: "KXPENDING" },
        recent: { page: 1, query: "recent-2" },
      },
    );

    expect(
      (
        (snapshot.pending_paper_trades as { trades?: Array<{ market_ticker?: string }> }).trades ??
        []
      ).map((row) => row.market_ticker),
    ).toEqual(Array.from({ length: 15 }, (_, index) => `KXPENDING-${index + 50}`));
    expect(
      (
        (snapshot.recent_paper_bets as { trades?: Array<{ market_ticker?: string }> }).trades ?? []
      ).map((row) => row.market_ticker),
    ).toEqual(["KXRECENT-2"]);
    expect(snapshot.audit_pages).toMatchObject({
      pending: {
        filtered_rows: 65,
        page: 2,
        page_count: 2,
        server_sliced: true,
        shown_rows: 15,
        total_rows: 65,
      },
      recent: {
        filtered_rows: 1,
        query: "recent-2",
        shown_rows: 1,
        total_rows: 3,
      },
    });
  });

  it("responds through a read-only handler", async () => {
    const respond = vi.fn();
    const handlers = createKalshiDashboardHandlers(async () => ({
      live_order_allowed: false,
      mode: "READ_ONLY",
    }));

    await handlers["kalshi.dashboard.snapshot"]({
      req: { type: "req", id: "1", method: "kalshi.dashboard.snapshot" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        live_order_allowed: false,
        mode: "READ_ONLY",
      }),
    );
  });

  it("responds with a compact workspace snapshot when requested", async () => {
    const respond = vi.fn();
    const handlers = createKalshiDashboardHandlers(async () => ({
      generated_at_utc: "2026-05-13T21:08:38Z",
      live_order_allowed: false,
      mode: "READ_ONLY",
      kalshi_control_surface: {
        status: "do_not_proceed",
        active_track: "sports",
        current_blocker: "sports_source_gate_missing_exact_approved_repo_root_jsonl",
        sports_source_gate: {
          status: "blocked_missing_approved_source",
          do_not_proceed: true,
          expected_path:
            "work/scripts/kalshi/approved_sports_local_source_collection_rows_v1.jsonl",
        },
        exact_next_human_action_required:
          "Approve exactly one repo-root local sports JSONL source path.",
        live_order_allowed: false,
      },
      accelerator: {
        scheduler: { scheduled_run_count: 10 },
        weather_lane: { large: true },
      },
    }));

    await handlers["kalshi.dashboard.snapshot"]({
      req: { type: "req", id: "1", method: "kalshi.dashboard.snapshot" },
      params: { view: "workspace" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(true, {
      generated_at_utc: "2026-05-13T21:08:38Z",
      live_order_allowed: false,
      mode: "READ_ONLY",
      kalshi_control_surface: {
        status: "do_not_proceed",
        active_track: "sports",
        current_blocker: "sports_source_gate_missing_exact_approved_repo_root_jsonl",
        sports_source_gate: {
          status: "blocked_missing_approved_source",
          do_not_proceed: true,
          expected_path:
            "work/scripts/kalshi/approved_sports_local_source_collection_rows_v1.jsonl",
        },
        exact_next_human_action_required:
          "Approve exactly one repo-root local sports JSONL source path.",
        live_order_allowed: false,
      },
      accelerator: {
        scheduler: { scheduled_run_count: 10 },
      },
    });
  });

  it("resolves the first executable Python candidate through symlinks", () => {
    const resolved = __testing.resolveExecutable([
      "/Users/openclaw/.venvs/kalshi-api/bin/python",
      "/usr/bin/python3",
    ]);

    expect(resolved).toMatch(/python3(?:\.\d+)?$/);
  });

  it("resolves the Kalshi dashboard script from the repo", () => {
    expect(__testing.resolveKalshiDashboardScript()).toMatch(
      /work\/scripts\/kalshi\/kalshi_dashboard\.py$/,
    );
  });
});
