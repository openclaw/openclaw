import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";
import { validateConfigObjectRaw } from "./validation.js";

/**
 * Regression tests for issue #35957.
 *
 * Several acp.stream keys were removed/renamed between v2026.3.2 and v2026.3.3:
 *   - maxTurnChars        → maxOutputChars
 *   - maxToolSummaryChars → maxSessionUpdateChars
 *   - maxStatusChars      → removed (no replacement)
 *   - maxMetaEventsPerTurn → removed (no replacement)
 *   - metaMode            → removed (no replacement)
 *   - showUsage           → removed (no replacement, superceded by repeatSuppression)
 *
 * Because every acp.stream schema node uses .strict(), configs written by v2026.3.2
 * that contain any of those old keys cause a ZodError at gateway startup.
 *
 * The fix adds LEGACY_CONFIG_RULES entries (so migration is triggered) and
 * LEGACY_CONFIG_MIGRATIONS entries (so old keys are stripped/renamed before
 * strict validation runs).
 */

describe("acp.stream legacy key migration (issue #35957)", () => {
  it("rejects old acp.stream.maxTurnChars via strict schema", () => {
    const result = validateConfigObjectRaw({
      acp: {
        stream: {
          maxTurnChars: 5000,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects old acp.stream.maxToolSummaryChars via strict schema", () => {
    const result = validateConfigObjectRaw({
      acp: {
        stream: {
          maxToolSummaryChars: 1000,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects old acp.stream.maxStatusChars via strict schema", () => {
    const result = validateConfigObjectRaw({
      acp: {
        stream: {
          maxStatusChars: 200,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects old acp.stream.maxMetaEventsPerTurn via strict schema", () => {
    const result = validateConfigObjectRaw({
      acp: {
        stream: {
          maxMetaEventsPerTurn: 10,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects old acp.stream.metaMode via strict schema", () => {
    const result = validateConfigObjectRaw({
      acp: {
        stream: {
          metaMode: "minimal",
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects old acp.stream.showUsage via strict schema", () => {
    const result = validateConfigObjectRaw({
      acp: {
        stream: {
          showUsage: true,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("migrates acp.stream.maxTurnChars to maxOutputChars", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxTurnChars: 5000,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.maxOutputChars).toBe(5000);
    expect(stream?.maxTurnChars).toBeUndefined();
    expect(result.changes).toContain("Moved acp.stream.maxTurnChars → acp.stream.maxOutputChars.");
  });

  it("migrates acp.stream.maxToolSummaryChars to maxSessionUpdateChars", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxToolSummaryChars: 1000,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.maxSessionUpdateChars).toBe(1000);
    expect(stream?.maxToolSummaryChars).toBeUndefined();
    expect(result.changes).toContain(
      "Moved acp.stream.maxToolSummaryChars → acp.stream.maxSessionUpdateChars.",
    );
  });

  it("drops acp.stream.maxStatusChars with no replacement", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxStatusChars: 200,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.maxStatusChars).toBeUndefined();
    expect(result.changes).toContain(
      "Removed acp.stream.maxStatusChars (no replacement in v2026.3.3).",
    );
  });

  it("drops acp.stream.maxMetaEventsPerTurn with no replacement", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxMetaEventsPerTurn: 10,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.maxMetaEventsPerTurn).toBeUndefined();
    expect(result.changes).toContain(
      "Removed acp.stream.maxMetaEventsPerTurn (no replacement in v2026.3.3).",
    );
  });

  it("drops acp.stream.metaMode with no replacement", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          metaMode: "verbose",
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.metaMode).toBeUndefined();
    expect(result.changes).toContain("Removed acp.stream.metaMode (no replacement in v2026.3.3).");
  });

  it("drops acp.stream.showUsage with no replacement", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          showUsage: true,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.showUsage).toBeUndefined();
    expect(result.changes).toContain("Removed acp.stream.showUsage (no replacement in v2026.3.3).");
  });

  it("handles all old acp.stream keys simultaneously (v2026.3.2 full config)", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          coalesceIdleMs: 50,
          maxChunkChars: 200,
          metaMode: "minimal",
          showUsage: false,
          deliveryMode: "live",
          maxTurnChars: 4000,
          maxToolSummaryChars: 800,
          maxStatusChars: 150,
          maxMetaEventsPerTurn: 5,
          tagVisibility: { tool_call: false },
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;

    // Renamed keys should be present with new names
    expect(stream?.maxOutputChars).toBe(4000);
    expect(stream?.maxSessionUpdateChars).toBe(800);

    // Removed keys should be gone
    expect(stream?.maxTurnChars).toBeUndefined();
    expect(stream?.maxToolSummaryChars).toBeUndefined();
    expect(stream?.maxStatusChars).toBeUndefined();
    expect(stream?.maxMetaEventsPerTurn).toBeUndefined();
    expect(stream?.metaMode).toBeUndefined();
    expect(stream?.showUsage).toBeUndefined();

    // Untouched keys should still be present
    expect(stream?.coalesceIdleMs).toBe(50);
    expect(stream?.maxChunkChars).toBe(200);
    expect(stream?.deliveryMode).toBe("live");
    expect(stream?.tagVisibility).toEqual({ tool_call: false });

    // Config should now pass strict validation
    const validResult = validateConfigObjectRaw(result.config);
    expect(validResult.ok).toBe(true);
  });

  it("does not migrate when new keys already present (maxTurnChars with existing maxOutputChars)", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxTurnChars: 5000,
          maxOutputChars: 3000,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    // Existing new key takes precedence
    expect(stream?.maxOutputChars).toBe(3000);
    expect(stream?.maxTurnChars).toBeUndefined();
    expect(result.changes).toContain(
      "Removed acp.stream.maxTurnChars (acp.stream.maxOutputChars already set).",
    );
  });

  it("does not migrate when new keys already present (maxToolSummaryChars with existing maxSessionUpdateChars)", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxToolSummaryChars: 1000,
          maxSessionUpdateChars: 800,
        },
      },
    });

    expect(result.config).not.toBeNull();
    const stream = result.config?.acp?.stream as Record<string, unknown> | undefined;
    expect(stream?.maxSessionUpdateChars).toBe(800);
    expect(stream?.maxToolSummaryChars).toBeUndefined();
    expect(result.changes).toContain(
      "Removed acp.stream.maxToolSummaryChars (acp.stream.maxSessionUpdateChars already set).",
    );
  });
});
