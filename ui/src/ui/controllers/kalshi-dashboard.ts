import type { GatewayBrowserClient } from "../gateway.ts";

export type KalshiDashboardSnapshot = {
  generated_at_utc?: string;
  live_order_allowed?: boolean;
  auto_apply_allowed?: boolean;
  dashboard_refresh_suspended?: boolean;
  cache_only?: boolean;
  audit_pages?: Record<
    string,
    {
      filtered_rows?: number;
      page?: number;
      page_count?: number;
      page_size?: number;
      query?: string;
      server_sliced?: boolean;
      shown_rows?: number;
      total_rows?: number;
    }
  >;
  dashboard_refresh?: {
    in_progress?: boolean;
    stale?: boolean;
    age_ms?: number | null;
    last_error?: string | null;
    suspended?: boolean;
    cache_only?: boolean;
  };
  learning_velocity?: {
    status?: string;
    plain_english?: string;
    latest_learning_at_utc?: string | null;
    latest_learning_age_minutes?: number | null;
    latest_shadow_learning_at_utc?: string | null;
    latest_shadow_learning_age_minutes?: number | null;
    latest_accepted_proof_at_utc?: string | null;
    latest_accepted_proof_age_minutes?: number | null;
    resolved_last_15m?: number;
    resolved_last_1h?: number;
    resolved_last_6h?: number;
    shadow_resolved_last_1h?: number;
    category_resolved_last_1h?: Record<string, number>;
    proof_metrics_exclude_shadow?: boolean;
    live_order_allowed?: boolean;
  };
  countdown_health?: Record<string, unknown>;
  sts_readiness_roadmap?: Record<string, unknown>;
  sts_readiness_eta?: Record<string, unknown>;
  sts_domain_optimizer?: Record<string, unknown>;
  sts_agent_audit?: Record<string, unknown>;
  sts_crypto_fresh_cycle?: Record<string, unknown>;
  sts_crypto_fresh_window_diagnostics?: Record<string, unknown>;
  sts_crypto_baseline_calibration?: Record<string, unknown>;
  sts_crypto_probability_recalibrator?: Record<string, unknown>;
  sts_crypto_segment_edge?: Record<string, unknown>;
  sts_crypto_execution_realism?: Record<string, unknown>;
  sts_crypto_execution_selector?: Record<string, unknown>;
  sts_crypto_execution_selector_outcomes?: Record<string, unknown>;
  sts_crypto_regime_selector?: Record<string, unknown>;
  sts_crypto_regime_selector_outcomes?: Record<string, unknown>;
  sts_crypto_regime_inverse_repair?: Record<string, unknown>;
  sts_domain_learning_optimizer?: Record<string, unknown>;
  sts_weather_selector_repair?: Record<string, unknown>;
  sts_crypto_evidence_repair?: Record<string, unknown>;
  sts_unlock_queue?: Record<string, unknown>;
  sts_trading_dashboard?: Record<string, unknown>;
  milestone_countdown?: {
    ok?: boolean;
    generated_at_utc?: string;
    plain_english?: string;
    rate_windows?: Record<string, unknown>;
    countdown_health?: Record<string, unknown>;
    milestones?: Array<{
      milestone_id?: string;
      label?: string;
      status?: string;
      eta_seconds?: number | null;
      eta_label?: string;
      completion_score?: number;
      plain_english?: string;
      criteria?: Array<{
        label?: string;
        score?: number;
        eta_seconds?: number | null;
        eta_label?: string;
        status?: string;
        detail?: string | null;
        reason_code?: string | null;
        blocking_reason?: string | null;
        rate_source?: string | null;
        rate_per_hour?: number | null;
        sample_size?: number | null;
        current_count?: number | null;
        target_count?: number | null;
        last_source_update_utc?: string | null;
        eligible_for_eta?: boolean;
        live_order_allowed?: boolean;
      }>;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    }>;
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  plain_english_status?: {
    headline?: string;
    status?: string;
    tone?: string;
    bullets?: string[];
    next_steps?: string[];
    live_order_allowed?: boolean;
  };
  paper?: {
    total_decisions?: number;
    accepted?: number;
    exploration?: number;
    forward_paper?: number;
    rejected?: number;
    no_trade?: number;
    errors?: number;
  };
  self_improvement?: {
    metrics?: {
      brier_score?: number | null;
      missing_outcome_rate?: number | null;
      scored_decisions?: number;
      scored_directional_decisions?: number;
      accuracy_wins?: number;
      accuracy_sample_size?: number;
      scored_decisions_last_1h?: number;
      scored_decisions_last_6h?: number;
      scored_decisions_last_24h?: number;
      latest_scored_decision_utc?: string | null;
      latest_scored_outcome_utc?: string | null;
      exploration_paper_decisions?: number;
      forward_paper_decisions?: number;
      realized_paper_pnl_all_time_usd?: number | null;
      realized_paper_pnl_last_24h_usd?: number | null;
      realized_paper_pnl_last_7d_usd?: number | null;
      paper_performance_by_timeframe?: Record<
        string,
        {
          label?: string;
          scored_decisions?: number;
          wins?: number;
          losses?: number;
          accuracy?: number | null;
          net_pnl_usd?: number | null;
          total_profit_usd?: number | null;
          total_loss_usd?: number | null;
          category_accuracy?: Array<{
            category?: string;
            label?: string;
            scored?: number;
            wins?: number;
            losses?: number;
            accuracy?: number | null;
            net_pnl_usd?: number | null;
            total_profit_usd?: number | null;
            total_loss_usd?: number | null;
          }>;
        }
      >;
      paper_activity_by_timeframe?: Record<
        string,
        {
          label?: string;
          decisions?: number;
          accepted?: number;
          rejected?: number;
          no_trade?: number;
          outcomes_recorded?: number;
          scored_accepted?: number;
          latest_scored_outcome_utc?: string | null;
        }
      >;
      average_pnl_per_scored_trade_usd?: number | null;
      accuracy?: number | null;
      accuracy_last_24h?: number | null;
      accuracy_last_7d?: number | null;
      unresolved_paper_exposure_usd?: number | null;
      fair_value_source_performance?: Record<
        string,
        {
          decisions?: number;
          scored?: number;
        }
      >;
    };
  };
  strategy_scorecard?: {
    scorecard_id?: string;
    summary?: {
      scored_accepted_decisions?: number;
      accuracy?: number | null;
      realized_pnl_usd?: number | null;
      paused_segments?: number;
      active_paused_segments?: number;
      standard_shadow_control_categories?: number;
      forward_paper_candidates?: number;
      live_review_candidates?: number;
    };
    trend?: {
      x_axis?: string;
      y_axis_left?: string;
      y_axis_right?: string;
      points?: Array<{
        index?: number;
        timestamp_utc?: string;
        scored_at_utc?: string;
        accuracy?: number | null;
        cumulative_pnl_usd?: number | null;
        average_pnl_per_scored_trade_usd?: number | null;
        latest_trade_pnl_usd?: number | null;
      }>;
    };
    segments?: Array<{
      segment?: string;
      status?: string;
      domain?: string;
      subdomain?: string;
      strategy_lane?: string;
      allowed_application_scope?: string;
      transferability?: string;
      decisions?: number;
      accepted?: number;
      scored?: number;
      audit_scored?: number;
      wins?: number;
      win_rate?: number | null;
      simulated_pnl_usd?: number | null;
      brier_score?: number | null;
      market_baseline_brier_score?: number | null;
    }>;
    learning_map?: {
      taxonomy_version?: string;
      domain_performance?: Array<{
        domain?: string;
        decisions?: number;
        accepted?: number;
        scored?: number;
        wins?: number;
        win_rate?: number | null;
        simulated_pnl_usd?: number | null;
        brier_score?: number | null;
        transfer_blocked?: number;
      }>;
      transfer_safe_lessons?: string[];
      domain_only_lessons?: string[];
      exploration_allocation?: Record<string, number>;
      negative_transfer_warnings?: string[];
    };
    lessons_learned?: Array<{
      lesson_id?: string;
      type?: string;
      status?: string;
      segment?: string | null;
      segment_label?: string;
      title?: string;
      evidence?: string;
      change?: string;
      expected_effect?: string;
      metric_to_watch?: string;
      confidence?: string;
      auto_apply_allowed?: boolean;
      live_order_allowed?: boolean;
    }>;
    improvement_summary?: {
      plain_english?: string;
      most_important_lesson?: {
        title?: string;
        evidence?: string;
        change?: string;
        expected_effect?: string;
      } | null;
      what_needs_to_happen_next?: string[];
      auto_apply_allowed?: boolean;
      live_order_allowed?: boolean;
    };
  };
  performance_summary?: {
    trend_direction?: string;
    best_segment?: {
      segment?: string;
      status?: string;
      scored?: number;
      win_rate?: number | null;
      simulated_pnl_usd?: number | null;
    } | null;
    worst_segment?: {
      segment?: string;
      status?: string;
      scored?: number;
      win_rate?: number | null;
      simulated_pnl_usd?: number | null;
    } | null;
  };
  data_quality?: {
    generated_age_minutes?: number | null;
    latest_scheduled_age_minutes?: number | null;
    latest_weather_age_minutes?: number | null;
    stale?: boolean;
    warnings?: string[];
  };
  accelerator?: {
    decision_quality?: {
      total?: number;
      accepted?: number;
      exploration?: number;
      forward_paper?: number;
      no_trade?: number;
      rejected?: number;
      top_no_trade_or_rejection_reasons?: Record<string, number>;
    };
    distance_to_live_readiness?: {
      accepted_rate?: number;
      resolved_outcomes?: number;
      resolved_outcomes_needed?: number;
    };
    ranked_actions?: Array<{
      rank?: number;
      priority?: string;
      type?: string;
      evidence?: string;
      implementation_hint?: string;
    }>;
    scheduler?: {
      scheduled_run_count?: number;
      weather_run_count?: number;
      latest_scheduled_ok?: boolean;
      latest_weather_ok?: boolean;
      latest_scheduled_completed_at_utc?: string | null;
      latest_weather_timestamp_utc?: string | null;
    };
    weather_lane?: {
      latest_discovery_parsed?: number;
      latest_discovery_trade_ready?: number;
      latest_run_parsed?: number;
      latest_run_trade_ready?: number;
      why_not_trading?: string;
      latest_candidate_created_count?: number;
      latest_candidate_skipped_reasons?: Record<string, number>;
      latest_candidate_governor_actions?: Record<string, number>;
      weather_expansion?: {
        registered_city_count?: number;
        covered_city_count?: number;
        covered_cities?: string[];
        active_trade_ready_city_count?: number;
        active_trade_ready_cities?: string[];
        cities_waiting_for_active_markets?: string[];
        cities_needing_parser_or_model_work?: string[];
        city_coverage_status?: Array<{
          city?: string;
          station?: string;
          status?: string;
          discovered_market_count?: number;
          active_market_count?: number;
          active_trade_ready_market_count?: number;
          parser_or_model_gap_count?: number;
          reason?: string;
        }>;
        watchlist_cities_without_trade_ready_markets?: string[];
        unsupported_weather_series_cities?: string[];
        current_trade_ready_note?: string;
        market_type_coverage?: Record<string, number>;
        discovery_approach?: string[];
        recommended_cities?: Array<{
          city?: string;
          station?: string;
          weather_regime?: string;
          score?: number;
          existing_trade_ready_markets?: number;
        }>;
      };
    };
    profit_firewall?: {
      paper_trading_paused?: boolean;
      blocked_accepted_paper_categories?: string[];
      blocked_current_side_categories?: string[];
      inverse_forward_test_categories?: string[];
      primary_paper_strategy?: string;
      plain_english_summary?: string;
    };
  };
  paper_volume_accelerator?: {
    metrics?: {
      total_decisions?: number;
      accepted_decisions?: number;
      exploration_decisions?: number;
      resolved_outcomes?: number;
      unresolved_accepted_decisions?: number;
      outcome_backlog?: number;
      pending_resolution_buckets?: Record<string, number>;
      pending_fast_resolution_count?: number;
      pending_slow_or_unknown_count?: number;
      unknown_timing_pending_count?: number;
      accepted_rate?: number;
      exploration_rate?: number;
      resolved_rate?: number;
      accepted_to_resolved_conversion_rate?: number;
      resolved_accepted_outcomes_per_day?: number;
      no_trade_rate?: number;
      rejection_rate?: number;
      unique_domains?: number;
      unique_segments?: number;
      learning_resolved_last_1h?: number;
      latest_scored_outcome_age_minutes?: number | null;
      current_learning_bottleneck?: string;
      what_must_happen_next_to_learn_faster?: string;
      estimated_cycles_to_100_accepted?: number | null;
    };
    recommended_cycle_settings?: {
      focused_watchlist?: boolean;
      observe_limit?: number;
      max_orderbooks?: number;
      max_watchlist_markets?: number;
      max_auto_candidates?: number;
      resolution_priority?: string;
    };
    recommended_allocation?: {
      weather_and_objective_fast_resolution?: number;
      high_liquidity_market_making_simulation?: number;
      historical_replay_research?: number;
      new_hypotheses?: number;
    };
    rapid_learning_plan?: {
      mode?: string;
      objective?: string;
      speed_mode_enabled?: boolean;
      primary_bottleneck?: string;
      bottlenecks?: Array<{
        type?: string;
        severity?: string;
        evidence?: string;
        fix?: string;
      }>;
      next_cycle_profile?: {
        observe_limit?: number;
        max_orderbooks?: number;
        max_watchlist_markets?: number;
        max_auto_candidates?: number;
        require_fast_resolution?: boolean;
        max_hours_to_resolution?: number;
        allow_unknown_resolution?: boolean;
        paper_exploration_enabled?: boolean;
        max_exploration_size_usd?: number;
        resolution_priority?: string;
      };
      evidence_targets?: {
        accepted_paper_trades_per_cycle?: number;
        minimum_resolved_outcomes?: number;
        minimum_domains_with_scoreable_candidates?: number;
        prefer_resolution_within_hours?: number;
        historical_replay_required?: boolean;
      };
      read_efficiency?: {
        use_batch_orderbooks?: boolean;
        batch_orderbook_limit_tickers?: number;
        use_batch_candlesticks_for_historical_replay?: boolean;
        avoid_blind_polling?: boolean;
      };
      domain_targets?: Array<{
        domain?: string;
        current_decision_count?: number;
        target?: string;
        rule?: string;
      }>;
      proof_rules?: {
        exploration_counts_as_learning_not_live_proof?: boolean;
        forward_paper_required_for_live_review?: boolean;
        category_lessons_transfer_across_domains?: boolean;
        live_order_allowed?: boolean;
        auto_apply_to_live_allowed?: boolean;
      };
    };
    ranked_actions?: Array<{
      rank?: number;
      priority?: string;
      type?: string;
      evidence?: string;
      implementation_hint?: string;
      live_order_allowed?: boolean;
      auto_apply_allowed?: boolean;
    }>;
  };
  paper_trade_accelerator?: {
    route_mix?: {
      overall?: Record<string, number>;
      weather_crypto?: Record<string, number>;
    };
    validated_weather_crypto_rows?: number;
    learning_target_rows?: number;
    rows_needed_to_learning_target?: number;
    rows_needed_to_profit_proof_target?: number;
    learning_rows_last_1h?: number;
    estimated_hours_to_learning_target_at_current_rate?: number | null;
    weather_source_freshness_ok?: boolean;
    route_mix_total?: {
      overall?: Record<string, number>;
      weather_crypto?: Record<string, number>;
    };
  };
  weather_model_audit?: {
    ok?: boolean;
    scope?: string;
    is_current?: boolean;
    updated_at_utc?: string;
    audit_status?: string;
    weather_decisions?: number;
    scored_weather_decisions?: number;
    unresolved_weather_decisions?: number;
    failure_modes?: Record<string, number>;
    failure_mode_explanations?: Record<
      string,
      {
        mode?: string;
        label?: string;
        count?: number;
        explanation?: string;
      }
    >;
    top_failure_mode?: {
      mode?: string;
      label?: string;
      count?: number;
      explanation?: string;
    } | null;
    plain_english?: string;
    primary_action?: {
      type?: string;
      priority?: string;
      recommendation?: string;
      application_scope?: string;
      live_order_allowed?: boolean;
      auto_apply_allowed?: boolean;
    };
    bucket_summaries?: Array<{
      city?: string;
      market_type?: string;
      side?: string;
      scored?: number;
      wins?: number;
      win_rate?: number | null;
      simulated_pnl_usd?: number | null;
      failure_modes?: Record<string, number>;
      failure_mode_summary?: Array<{
        mode?: string;
        label?: string;
        count?: number;
        explanation?: string;
      }>;
      top_failure_mode?: {
        mode?: string;
        label?: string;
        count?: number;
        explanation?: string;
      } | null;
      plain_english_summary?: string;
      action?: {
        type?: string;
        recommendation?: string;
        plain_english?: string;
      };
    }>;
    source_freshness?: {
      ok?: boolean;
      timestamp_utc?: string | null;
      fresh_city_count?: number;
      checked_city_count?: number;
      provider_health?: Record<string, unknown>;
      source_hash?: string;
    };
    previous_audit_preserved?: boolean;
    live_order_allowed?: boolean;
    auto_apply_allowed?: boolean;
  };
  shadow_discovery?: {
    metrics?: {
      shadow_trades?: number;
      scored_shadow_trades?: number;
      newly_scored_shadow_trades?: number;
      unresolved_shadow_trades?: number;
      invalid_shadow_trades?: number;
      directional_scored_shadow_trades?: number;
      shadow_wins?: number;
      shadow_win_rate?: number | null;
      shadow_hypothetical_pnl_usd?: number | null;
      no_trade_baselines?: number;
    };
    by_action?: Array<{
      action?: string;
      scored?: number;
      directional_scored?: number;
      wins?: number;
      win_rate?: number | null;
      hypothetical_pnl_usd?: number | null;
    }>;
    best_segments?: Array<{
      segment_key?: string;
      domain?: string;
      market_category?: string;
      shadow_action?: string;
      scored?: number;
      directional_scored?: number;
      wins?: number;
      win_rate?: number | null;
      hypothetical_pnl_usd?: number | null;
      eligible_for_exploration_review?: boolean;
    }>;
    exploration_review_candidates?: Array<{
      segment_key?: string;
      domain?: string;
      shadow_action?: string;
      directional_scored?: number;
      win_rate?: number | null;
      hypothetical_pnl_usd?: number | null;
      eligible_for_exploration_review?: boolean;
    }>;
    plain_english?: string;
    live_order_allowed?: boolean;
    auto_apply_allowed?: boolean;
  };
  inverse_strategy_audit?: {
    metrics?: {
      total_directional_scored?: number;
      original_accuracy?: number | null;
      inverse_accuracy?: number | null;
      accuracy_delta_inverse_minus_original?: number | null;
      original_pnl_usd?: number | null;
      inverse_pnl_usd?: number | null;
      pnl_delta_inverse_minus_original_usd?: number | null;
      executable_quality_trades?: number;
      executable_quality_fraction?: number | null;
      synthetic_or_unpriced_trades?: number;
      best_segments?: Array<{
        domain?: string;
        strategy_bucket?: string;
        fair_value_source_type?: string;
        segment_key?: string;
        scored?: number;
        original_win_rate?: number | null;
        inverse_win_rate?: number | null;
        original_pnl_usd?: number | null;
        inverse_pnl_usd?: number | null;
        inverse_minus_original_pnl_usd?: number | null;
        executable_quality_fraction?: number | null;
        contrarian_forward_paper_candidate?: boolean;
        live_order_allowed?: boolean;
        auto_apply_allowed?: boolean;
      }>;
      contrarian_forward_paper_candidates?: Array<{
        domain?: string;
        strategy_bucket?: string;
        fair_value_source_type?: string;
        segment_key?: string;
        scored?: number;
        inverse_win_rate?: number | null;
        inverse_pnl_usd?: number | null;
        executable_quality_fraction?: number | null;
        contrarian_forward_paper_candidate?: boolean;
      }>;
    };
    recommendations?: Array<{
      recommendation_id?: string;
      type?: string;
      status?: string;
      evidence?: string;
      proposed_change?: string;
      expected_benefit?: string;
      risk?: string;
      rollback_method?: string;
      human_approval_required?: boolean;
      auto_apply_allowed?: boolean;
      live_order_allowed?: boolean;
    }>;
    plain_english?: string;
    critical_failures?: string[];
    warnings?: string[];
    live_order_allowed?: boolean;
    auto_apply_allowed?: boolean;
  };
  strategy_comparison?: {
    ok?: boolean;
    scope?: string;
    primary_metric_source?: string;
    secondary_metric_source?: string;
    plain_english?: string;
    standardized_names?: Record<string, string>;
    actual_summary?: {
      standard_accuracy?: number | null;
      inverse_standard_accuracy?: number | null;
      accuracy_delta_inverse_minus_standard?: number | null;
      standard_pnl_usd?: number | null;
      inverse_standard_pnl_usd?: number | null;
      pnl_delta_inverse_minus_standard_usd?: number | null;
      standard_scored?: number;
      inverse_standard_scored?: number;
      live_order_allowed?: boolean;
    };
    audit_summary?: {
      standard_accuracy?: number | null;
      inverse_standard_accuracy?: number | null;
      accuracy_delta_inverse_minus_standard?: number | null;
      standard_pnl_usd?: number | null;
      inverse_standard_pnl_usd?: number | null;
      pnl_delta_inverse_minus_standard_usd?: number | null;
      scored?: number;
      source?: string;
      executable_quality_fraction?: number | null;
      synthetic_or_unpriced_trades?: number;
      live_order_allowed?: boolean;
    };
    rows?: Array<{
      strategy_id?: string;
      display_name?: string;
      role?: string;
      decisions?: number;
      accepted?: number;
      shadow_decisions?: number;
      scored?: number;
      audit_scored?: number;
      wins?: number;
      losses?: number;
      accuracy?: number | null;
      audit_accuracy?: number | null;
      paper_pnl_usd?: number | null;
      pnl_delta_vs_standard_usd?: number | null;
      pnl_delta_vs_standard_label?: string;
      pnl_delta_vs_standard_source?: string;
      pnl_delta_status?: string;
      audit_pnl_usd?: number | null;
      audit_delta_vs_standard_accuracy?: number | null;
      audit_delta_vs_standard_pnl_usd?: number | null;
      total_profit_usd?: number | null;
      total_loss_usd?: number | null;
      average_pnl_per_scored_trade_usd?: number | null;
      unresolved?: number;
      domains?: Record<string, number>;
      tracking_status?: string;
      next_step?: string;
      live_order_allowed?: boolean;
    }>;
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  supreme_trading_strategy?: {
    ok?: boolean;
    schema_version?: string;
    generated_at_utc?: string;
    mode?: string;
    status?: string;
    confidence_score?: number | null;
    current_regime?: {
      label?: string;
      confidence_score?: number | null;
      drivers?: string[];
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    objective_scores?: Record<string, number>;
    strategy_weights?: Array<{
      strategy_id?: string;
      domain?: string;
      regime_label?: string;
      weight?: number | null;
      train_rows?: number | null;
      test_rows?: number | null;
      brier_uplift?: number | null;
      log_loss_uplift?: number | null;
      pnl_uplift_usd?: number | null;
      reason?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    }>;
    top_rationales?: Array<{
      title?: string;
      evidence?: string;
      impact?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    }>;
    risk?: Record<string, unknown>;
    performance?: Record<string, unknown>;
    learning?: Record<string, unknown>;
    experiments?: Record<string, unknown>;
    model_health?: Record<string, unknown>;
    data_health?: Record<string, unknown>;
    next_action?: string;
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  crypto_evidence?: {
    ok?: boolean;
    timestamp_utc?: string | null;
    active_crypto_markets_seen?: number;
    crypto_readiness_status?: string | null;
    next_crypto_trade_ready_check_time_utc?: string | null;
    seconds_until_next_crypto_trade_ready_check?: number | null;
    next_crypto_trade_ready_unavailable_reason?: string | null;
    last_crypto_trade_ready_check_time_utc?: string | null;
    crypto_readiness_summary?: string | null;
    parseable_crypto_markets?: number;
    orderbooks_checked?: number;
    spot_assets_available?: string[];
    candidate_count?: number;
    created_count?: number;
    created_by_governor_action?: Record<string, number>;
    plain_english_summary?: string;
    warnings?: string[];
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  weather_crypto_ml?: {
    ok?: boolean;
    status?: string;
    plain_english?: string;
    abstention_rate?: number | null;
    accepted_paper_allowed_segment_count?: number;
    domains?: Record<
      string,
      {
        decisions?: number;
        scored?: number;
        shadow_scored?: number;
        accepted_scored?: number;
        quarantined?: number;
      }
    >;
    reality_contract?: {
      passed_pre_trade?: number;
      failed_pre_trade?: number;
      training_eligible?: number;
      quarantined_training?: number;
    };
    promotion_gap?: {
      status?: string;
      plain_english?: string;
      next_action?: string;
      top_blocker?: string | null;
      allowed_segment_count?: number;
      near_miss_segment_count?: number;
      trainable_rows?: number;
      quarantined_rows?: number;
      blocker_counts?: Record<string, number>;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
      calibration_repair?: {
        status?: string;
        top_blocker?: string | null;
        next_action?: string;
        repair_segment_count?: number;
        safe_candidate_rules?: string[];
        candidate_behavior?: {
          status?: string;
          crypto_reprice_active?: boolean;
          active_shrink_segment_count?: number;
          probability_rule?: string;
          weather_label_rule?: string;
          accepted_paper_allowed?: boolean;
          live_order_allowed?: boolean;
          auto_live_promotion_allowed?: boolean;
        };
        segments?: Array<{
          segment_key?: string;
          domain?: string;
          action?: string;
          reason?: string;
          shadow_scored?: number;
          shadow_accuracy?: number | null;
          shadow_pnl_usd?: number | null;
          shadow_brier_score?: number | null;
          shadow_market_brier_score?: number | null;
          candidate_minus_market_brier?: number | null;
          candidate_weight_cap?: number | null;
          accepted_paper_allowed?: boolean;
          live_order_allowed?: boolean;
        }>;
        live_order_allowed?: boolean;
        auto_live_promotion_allowed?: boolean;
      };
      segments?: Array<{
        segment_key?: string;
        domain?: string;
        promotion_stage?: string;
        paper_betting_allowed?: boolean;
        completion_score?: number | null;
        primary_blocker?: string | null;
        blockers?: string[];
        criteria?: Array<{
          label?: string;
          score?: number | null;
          detail?: string;
          passed?: boolean;
        }>;
        next_action?: string;
        shadow_scored?: number;
        shadow_accuracy?: number | null;
        shadow_pnl_usd?: number | null;
        accepted_scored?: number;
        live_order_allowed?: boolean;
      }>;
    };
    model_governance?: {
      model_id?: string;
      feature_schema_version?: string;
      reality_contract_version?: string;
      validation_window?: string;
      calibration_method?: string;
      label_source?: string;
    };
    markov_microstructure_ml_overlay?: {
      ok?: boolean;
      generated_at_utc?: string;
      purpose?: string;
      usage?: string;
      analyzed_weather_crypto_count?: number;
      tiny_paper_review_only_count?: number;
      taker_trap_count?: number;
      low_data_count?: number;
      ml_feature_keys?: string[];
      recommended_ml_action?: string;
      research_only?: boolean;
      not_trade_signal?: boolean;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    ml_model?: {
      champion_model_id?: string;
      champion_status?: string;
      markov_microstructure_uplift?: {
        status?: string;
        train_markov_rows?: number;
        test_markov_rows?: number;
        brier_uplift_vs_candidate?: number | null;
        log_loss_uplift_vs_candidate?: number | null;
        can_influence_ml_training?: boolean;
        next_action?: string;
        live_order_allowed?: boolean;
        auto_live_promotion_allowed?: boolean;
      };
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    markov_feature_coverage?: {
      ok?: boolean;
      coverage_version?: string;
      generated_at_utc?: string;
      coverage_status?: string;
      resolved_safe_markov_rows?: number;
      pending_safe_markov_rows?: number;
      due_safe_markov_rows?: number;
      next_safe_markov_result_known_time_utc?: string | null;
      resolved_safe_markov_rows_needed?: number;
      pending_safe_markov_rows_available_for_future_grading?: number;
      domains?: Record<string, Record<string, number>>;
      routing_label_counts?: Record<string, number>;
      next_action?: string;
      research_only?: boolean;
      not_trade_signal?: boolean;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    shadow_qualified_segments?: Array<{
      segment_key?: string;
      domain?: string;
      shadow_scored?: number;
      shadow_accuracy?: number | null;
      shadow_pnl_usd?: number | null;
      shadow_brier_score?: number | null;
      shadow_market_brier_score?: number | null;
      next_action?: string;
    }>;
    segments?: Array<{
      segment_key?: string;
      domain?: string;
      promotion_stage?: string;
      scored?: number;
      accuracy?: number | null;
      paper_pnl_usd?: number | null;
      shadow_scored?: number;
      shadow_accuracy?: number | null;
      accepted_scored?: number;
      accepted_accuracy?: number | null;
      quarantined_contracts?: number;
      next_action?: string;
    }>;
    next_required_proof?: string;
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  markov_microstructure?: {
    ok?: boolean;
    status?: string;
    generated_at_utc?: string;
    diagnostic_version?: string;
    research_only?: boolean;
    not_trade_signal?: boolean;
    plain_english?: string;
    summary?: {
      status?: string;
      analyzed_market_count?: number;
      universe_count?: number;
      low_data_market_count?: number;
      taker_trap_count?: number;
      tiny_paper_review_only_count?: number;
      observe_only_count?: number;
      pass_count?: number;
      best_confidence_score?: number;
      plain_english?: string;
      next_action?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    study_reference?: {
      title?: string;
      author?: string;
      url?: string;
      dataset_summary?: string;
      live_order_allowed?: boolean;
    };
    markets?: Array<{
      market_ticker?: string;
      title?: string;
      category?: string;
      current_yes_price?: number | null;
      current_bucket?: number | null;
      raw_markov_yes_proxy?: number | null;
      becker_longshot_prior?: number | null;
      calibrated_probability?: number | null;
      market_price?: number | null;
      edge_vs_market_pct?: number | null;
      confidence_score?: number | null;
      confidence_caps?: string[];
      routing_label?: string;
      sample?: {
        history_points?: number;
        total_transitions?: number;
        current_row_transitions?: number;
        data_source?: string;
      };
      transition_heatmap?: {
        bucket_count?: number;
        matrix?: number[][];
        counts?: number[][];
        row_counts?: number[];
        current_bucket?: number | null;
      };
      terminal_distribution?: number[];
      execution?: {
        yes_maker_edge_pct?: number | null;
        yes_taker_edge_pct?: number | null;
        no_maker_edge_pct?: number | null;
        no_taker_edge_pct?: number | null;
        best_yes_ask_probability?: number | null;
        best_no_ask_probability?: number | null;
        estimated_yes_spread_cents?: number | null;
        depth_contracts?: number;
        fill_quality?: string;
        maker_taker_category_gap_pct?: number | null;
        maker_taker_warning?: string;
      };
      warnings?: string[];
      research_only?: boolean;
      not_trade_signal?: boolean;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    }>;
    calibration_tracking?: {
      bucket_count?: number;
      plain_english?: string;
      rows?: Array<{
        category?: string;
        bucket_label?: string;
        count?: number;
        wins?: number;
        actual_win_rate?: number | null;
        average_implied_probability?: number | null;
        actual_minus_implied_pct?: number | null;
        sample_quality?: string;
        live_order_allowed?: boolean;
      }>;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    warnings?: string[];
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  opportunity_engine?: {
    metrics?: {
      opportunities_detected?: number;
      new_opportunity_events?: number;
      experiments_created?: number;
      new_experiments?: number;
      likely_edge?: number;
      possible_bug?: number;
      low_quality_data?: number;
      needs_more_evidence?: number;
      paper_auto_applicable?: number;
      status_counts?: Record<string, number>;
      diagnosis_counts?: Record<string, number>;
      clean_forward_paper_candidates?: number;
      shadow_forward_watch?: number;
      quality_repair_ready?: number;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    };
    opportunities?: Array<{
      opportunity_id?: string;
      detector?: string;
      metric?: string;
      domain?: string;
      segment_key?: string;
      diagnosis?: string;
      status?: string;
      promotion_status?: string;
      next_proof_needed?: string;
      promotion_blockers?: string[];
      evidence?: string;
      next_paper_action?: string;
      rollback_instructions?: string;
      repair_required?: boolean;
      repair_tasks?: Array<{
        type?: string;
        owner?: string;
        success_criteria?: string;
      }>;
      paper_auto_apply_allowed?: boolean;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    }>;
    experiments?: Array<{
      experiment_id?: string;
      opportunity_id?: string;
      detector?: string;
      domain?: string;
      segment_key?: string;
      experiment_type?: string;
      paper_notional_usd?: number | null;
      max_new_paper_trades?: number;
      evidence_tier?: string;
      status?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    }>;
    diagnostics?: {
      primary_status?: string;
      primary_diagnosis?: string;
      primary_promotion_status?: string;
      plain_english?: string;
      blocked_reasons?: Record<string, number>;
      promotion_blockers?: Record<string, number>;
    };
    warnings?: string[];
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
    paper_auto_apply_allowed?: boolean;
  };
  opportunity_repair?: {
    repairable_opportunities?: number;
    new_repair_records?: number;
    task_counts?: Record<string, number>;
    repair_records?: Array<{
      repair_id?: string;
      opportunity_id?: string;
      detector?: string;
      diagnosis?: string;
      domain?: string;
      segment_key?: string;
      promotion_status?: string;
      promotion_blockers?: string[];
      next_proof_needed?: string;
      repair_tasks?: Array<{
        type?: string;
        owner?: string;
        success_criteria?: string;
      }>;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
      auto_apply_allowed?: boolean;
      paper_auto_apply_allowed?: boolean;
      status?: string;
      why_this_matters?: string;
    }>;
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
    warnings?: string[];
  };
  strategy_governor?: {
    routed_count?: number;
    action_counts?: Record<string, number>;
    accepted_or_tested_count?: number;
    shadow_or_blocked_count?: number;
    inverse_forward_tests?: number;
    plain_english?: string;
    latest_change?: {
      governor_action?: string;
      domain?: string;
      plain_language_reason?: string;
      segment_scope?: string;
      rollback_rule?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    } | null;
    top_active_hypothesis?: {
      governor_action?: string;
      domain?: string;
      plain_language_reason?: string;
      segment_scope?: string;
      rollback_rule?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    } | null;
    top_blocked_losing_lane?: {
      governor_action?: string;
      domain?: string;
      plain_language_reason?: string;
      segment_scope?: string;
      rollback_rule?: string;
      live_order_allowed?: boolean;
      auto_live_promotion_allowed?: boolean;
    } | null;
    live_order_allowed?: boolean;
    auto_live_promotion_allowed?: boolean;
  };
  live_readiness?: {
    ok?: boolean;
    readiness?: string;
    live_trading_enabled?: boolean;
    live_order_allowed?: boolean;
    blockers?: string[];
    critical_failures?: string[];
    checks?: {
      paper_log_ok?: boolean;
      outcome_log_ok?: boolean;
      risk_controller_ok?: boolean;
      no_live_trading_ok?: boolean;
      forward_paper_queue_ok?: boolean;
      evidence_report_ok?: boolean;
      paper_decisions?: number;
      resolved_outcomes?: number;
      ready_scorecards?: number;
      brier_score?: number | null;
    };
  };
  no_live_validator?: {
    critical_failures?: string[];
  };
  top_action?: {
    priority?: string;
    type?: string;
    evidence?: string;
    implementation_hint?: string;
  } | null;
  pending_paper_trades?: {
    count?: number;
    shown?: number;
    upcoming_count?: number;
    overdue_count?: number;
    overdue_shown?: number;
    total_unresolved_exposure_usd?: number | null;
    average_estimated_success_probability?: number | null;
    newest_timestamp_utc?: string | null;
    next_result_known_time_utc?: string | null;
    oldest_overdue_result_known_time_utc?: string | null;
    trades?: Array<{
      decision_id?: string;
      timestamp_utc?: string;
      market_ticker?: string;
      market_title?: string;
      decision?: string;
      side?: string;
      bet_summary?: string;
      win_condition?: string;
      evidence_tier?: string;
      strategy_bucket?: string;
      estimated_success_probability?: number | null;
      market_probability_at_entry?: number | null;
      fair_probability?: number | null;
      edge_after_costs_pct?: number | null;
      simulated_size_usd?: number | null;
      paper_fill_price_cents?: number | null;
      paper_profit_if_win_usd?: number | null;
      paper_loss_if_wrong_usd?: number | null;
      reason?: string;
      expected_resolution_time_utc?: string | null;
      resolution_time_source?: string | null;
      resolution_time_source_label?: string | null;
      resolution_timing_note?: string | null;
      settlement_timer_seconds?: number | null;
      expected_result_known_time_utc?: string | null;
      result_known_time_source?: string | null;
      result_known_time_source_label?: string | null;
      result_known_timing_note?: string | null;
      close_time_utc?: string | null;
      expiration_time_utc?: string | null;
      expected_expiration_time_utc?: string | null;
      latest_expiration_time_utc?: string | null;
      is_overdue_for_result?: boolean;
      hours_overdue?: number | null;
      resolution_status_label?: string | null;
    }>;
    overdue_trades?: Array<{
      decision_id?: string;
      timestamp_utc?: string;
      market_ticker?: string;
      market_title?: string;
      decision?: string;
      side?: string;
      bet_summary?: string;
      win_condition?: string;
      evidence_tier?: string;
      strategy_bucket?: string;
      estimated_success_probability?: number | null;
      market_probability_at_entry?: number | null;
      fair_probability?: number | null;
      edge_after_costs_pct?: number | null;
      simulated_size_usd?: number | null;
      paper_fill_price_cents?: number | null;
      paper_profit_if_win_usd?: number | null;
      paper_loss_if_wrong_usd?: number | null;
      reason?: string;
      expected_resolution_time_utc?: string | null;
      resolution_time_source?: string | null;
      resolution_time_source_label?: string | null;
      resolution_timing_note?: string | null;
      settlement_timer_seconds?: number | null;
      expected_result_known_time_utc?: string | null;
      result_known_time_source?: string | null;
      result_known_time_source_label?: string | null;
      result_known_timing_note?: string | null;
      close_time_utc?: string | null;
      expiration_time_utc?: string | null;
      expected_expiration_time_utc?: string | null;
      latest_expiration_time_utc?: string | null;
      is_overdue_for_result?: boolean;
      hours_overdue?: number | null;
      resolution_status_label?: string | null;
    }>;
  };
  recent_paper_bets?: {
    count?: number;
    shown?: number;
    resolved_in_shown?: number;
    pending_in_shown?: number;
    resolved_count?: number;
    latest_resolved_shown?: number;
    trades?: Array<{
      decision_id?: string;
      timestamp_utc?: string;
      market_ticker?: string;
      market_title?: string;
      decision?: string;
      side?: string;
      bet_summary?: string;
      win_condition?: string;
      evidence_tier?: string;
      strategy_bucket?: string;
      estimated_success_probability?: number | null;
      market_probability_at_entry?: number | null;
      edge_after_costs_pct?: number | null;
      simulated_size_usd?: number | null;
      paper_fill_price_cents?: number | null;
      paper_profit_if_win_usd?: number | null;
      paper_loss_if_wrong_usd?: number | null;
      outcome_status?: string;
      outcome_yes?: number | null;
      paper_result?: string | null;
      paper_pnl_usd?: number | null;
      settlement_checked_at_utc?: string | null;
      settlement_source?: string | null;
      reason?: string;
      expected_resolution_time_utc?: string | null;
      resolution_time_source?: string | null;
      resolution_time_source_label?: string | null;
      resolution_timing_note?: string | null;
      settlement_timer_seconds?: number | null;
      expected_result_known_time_utc?: string | null;
      result_known_time_source?: string | null;
      result_known_time_source_label?: string | null;
      result_known_timing_note?: string | null;
      close_time_utc?: string | null;
      expiration_time_utc?: string | null;
      expected_expiration_time_utc?: string | null;
      latest_expiration_time_utc?: string | null;
    }>;
    latest_resolved_trades?: Array<{
      decision_id?: string;
      timestamp_utc?: string;
      market_ticker?: string;
      market_title?: string;
      side?: string;
      bet_summary?: string;
      win_condition?: string;
      outcome_status?: string;
      outcome_yes?: number | null;
      paper_result?: string | null;
      paper_pnl_usd?: number | null;
      settlement_checked_at_utc?: string | null;
      settlement_source?: string | null;
    }>;
  };
  log_counts?: {
    paper_decisions?: number;
    paper_outcomes?: number;
    market_observations?: number;
    scheduled_learning_runs?: number;
    weather_learning_runs?: number;
  };
  warnings?: string[];
};

export type KalshiDashboardState = {
  client: GatewayBrowserClient | null;
  kalshiDashboardLoading: boolean;
  kalshiDashboardError: string | null;
  kalshiDashboard: KalshiDashboardSnapshot | null;
  kalshiDashboardLastFetchAt: number | null;
  kalshiDashboardLastFetchView?: KalshiDashboardView | null;
  kalshiDashboardInFlight?: Promise<void> | null;
  kalshiDashboardInFlightView?: KalshiDashboardView | null;
};

const KALSHI_DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;
const KALSHI_WORKSPACE_MIN_REFRESH_INTERVAL_MS = 10_000;
export type KalshiDashboardView = "full" | "workspace";

export async function loadKalshiDashboard(
  state: KalshiDashboardState,
  opts?: {
    auditTablePages?: Record<string, number>;
    auditTableQueries?: Record<string, string>;
    force?: boolean;
    quiet?: boolean;
    view?: KalshiDashboardView;
  },
) {
  if (!state.client) {
    return;
  }
  const view = opts?.view ?? "full";
  if (
    !opts?.force &&
    view === "workspace" &&
    state.kalshiDashboard &&
    !state.kalshiDashboardError &&
    state.kalshiDashboardLastFetchAt &&
    Date.now() - state.kalshiDashboardLastFetchAt < KALSHI_WORKSPACE_MIN_REFRESH_INTERVAL_MS
  ) {
    return;
  }
  if (state.kalshiDashboardInFlight) {
    if (view === "workspace" || state.kalshiDashboardInFlightView === "full") {
      await state.kalshiDashboardInFlight.catch(() => undefined);
      return;
    }
    await state.kalshiDashboardInFlight.catch(() => undefined);
    if (!state.client) {
      return;
    }
  }
  const client = state.client;
  if (!client) {
    return;
  }

  const showLoading = opts?.quiet !== true;
  if (showLoading) {
    state.kalshiDashboardLoading = true;
  }
  state.kalshiDashboardError = null;
  const auditTables =
    view === "full"
      ? {
          overdue: {
            page: opts?.auditTablePages?.overdue ?? 1,
            query: opts?.auditTableQueries?.overdue ?? "",
          },
          pending: {
            page: opts?.auditTablePages?.pending ?? 1,
            query: opts?.auditTableQueries?.pending ?? "",
          },
          recent: {
            page: opts?.auditTablePages?.recent ?? 1,
            query: opts?.auditTableQueries?.recent ?? "",
          },
          resolved: {
            page: opts?.auditTablePages?.resolved ?? 1,
            query: opts?.auditTableQueries?.resolved ?? "",
          },
        }
      : undefined;
  const request = (async () => {
    const params =
      view === "workspace"
        ? { ...(opts?.force ? { force_refresh: true } : {}), view: "workspace" as const }
        : { audit_tables: auditTables, ...(opts?.force ? { force_refresh: true } : {}) };
    const snapshot = await client.request<KalshiDashboardSnapshot>(
      "kalshi.dashboard.snapshot",
      params,
      { timeoutMs: KALSHI_DASHBOARD_REQUEST_TIMEOUT_MS },
    );
    state.kalshiDashboard = snapshot;
    state.kalshiDashboardLastFetchAt = Date.now();
    state.kalshiDashboardLastFetchView = view;
  })();
  state.kalshiDashboardInFlight = request;
  state.kalshiDashboardInFlightView = view;
  try {
    await request;
  } catch (error) {
    state.kalshiDashboardError = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.kalshiDashboardInFlight === request) {
      state.kalshiDashboardInFlight = null;
      state.kalshiDashboardInFlightView = null;
      if (showLoading) {
        state.kalshiDashboardLoading = false;
      }
    }
  }
}
