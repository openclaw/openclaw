// Migration context tests cover report directory naming and timestamp fallback behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { buildMigrationContext, buildMigrationReportDir } from "./context.js";

function migrationTarget(config: OpenClawConfig, targetAgentId?: string) {
  return buildMigrationContext({
    configOverride: config,
    targetAgentId,
    runtime: createNonExitingRuntime(),
  }).targetAgentId;
}

describe("migration context helpers", () => {
  it("builds report directories with filename-safe timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    expect(buildMigrationReportDir("codex", "/state", now)).toBe(
      path.join("/state", "migration", "codex", "2026-02-23T12-34-56.000Z"),
    );
  });

  it("falls back instead of throwing for out-of-range report timestamps", () => {
    expect(buildMigrationReportDir("codex", "/state", 9_000_000_000_000_000)).toMatch(
      /[/\\]migration[/\\]codex[/\\]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
    );
  });

  it("normalizes and validates an explicit migration target agent", () => {
    const config = {
      agents: {
        entries: { main: {}, research: {} },
      },
    };

    expect(migrationTarget(config, "Research")).toBe("research");
    expect(() => migrationTarget(config, "research/../main")).toThrow(
      'Invalid agent id "research/../main"',
    );
    expect(() => migrationTarget(config, "missing")).toThrow('Unknown agent id "missing"');
  });

  it("keeps the configured default when no migration target is supplied", () => {
    expect(migrationTarget({})).toBeUndefined();
  });

  it("rejects an explicitly blank migration target", () => {
    expect(() => migrationTarget({}, "")).toThrow("--agent must not be blank");
  });
});
