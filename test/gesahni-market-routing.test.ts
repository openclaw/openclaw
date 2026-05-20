import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillCommandSpecs } from "../src/agents/skills.js";

describe("Gesahni market command routing", () => {
  it("maps market commands to the expected gesahni tools", () => {
    const specs = buildWorkspaceSkillCommandSpecs(process.cwd());
    const byName = new Map(specs.map((entry) => [entry.name, entry]));

    expect(byName.get("watchlist")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_watchlist_get",
      argMode: "raw",
    });
    expect(byName.get("positions")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_positions_get",
      argMode: "raw",
    });
    expect(byName.get("summary")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_market_summary_get",
      argMode: "raw",
    });
    expect(byName.get("alerts")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_alerts_get",
      argMode: "raw",
    });
    expect(byName.get("earnings")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_earnings_upcoming_get",
      argMode: "raw",
    });
    expect(byName.get("portfolio")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_portfolio_get",
      argMode: "raw",
    });
    expect(byName.get("options")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_positions_get",
      argMode: "raw",
    });
    expect(byName.get("option_alerts")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_watch_rules_get",
      argMode: "raw",
    });
    expect(byName.get("options_status")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_status_get",
      argMode: "raw",
    });
    expect(byName.get("chain")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_chain_snapshot_get",
      argMode: "raw",
    });
    expect(byName.get("earnings_coverage")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_earnings_coverage_get",
      argMode: "raw",
    });
    expect(byName.get("earnings_reminders")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_earnings_reminders_due_get",
      argMode: "raw",
    });
    expect(byName.get("alert_history")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_alert_deliveries_get",
      argMode: "raw",
    });
    expect(byName.get("quote")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_stock_quote_get",
      argMode: "raw",
    });
    expect(byName.get("watchlist_add")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_watchlist_add",
      argMode: "raw",
    });
    expect(byName.get("watchlist_remove")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_watchlist_remove",
      argMode: "raw",
    });
    expect(byName.get("alert_create")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_alert_create",
      argMode: "raw",
    });
    expect(byName.get("alert_update")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_alert_update",
      argMode: "raw",
    });
    expect(byName.get("alert_delete")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_alert_delete",
      argMode: "raw",
    });
    expect(byName.get("options_watch_rule_create")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_watch_rule_create",
      argMode: "raw",
    });
    expect(byName.get("options_watch_rule_update")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_watch_rule_update",
      argMode: "raw",
    });
    expect(byName.get("options_watch_rule_delete")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_watch_rule_delete",
      argMode: "raw",
    });
    expect(byName.get("options_alert_suggestion_apply")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_alert_suggestion_apply",
      argMode: "raw",
    });
    expect(byName.get("options_suggestions_apply_all")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_options_alert_suggestions_apply_all",
      argMode: "raw",
    });
    expect(byName.get("gesahni_confirm")?.dispatch).toEqual({
      kind: "tool",
      toolName: "gesahni_write_confirm",
      argMode: "raw",
    });
  });
});
