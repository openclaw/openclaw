import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";
import { validateConfigObjectRaw, validateConfigObjectWithPlugins } from "./validation.js";

const LEGACY_ACP_STREAM_FIXTURE = {
  acp: {
    stream: {
      maxTurnChars: 5000,
      maxToolSummaryChars: 1000,
      maxStatusChars: 400,
      maxMetaEventsPerTurn: 6,
      metaMode: "full",
      showUsage: true,
    },
  },
};

describe("acp.stream legacy key migration (issue #35957)", () => {
  it("flags old acp.stream keys during raw validation", () => {
    const result = validateConfigObjectRaw(LEGACY_ACP_STREAM_FIXTURE);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "acp.stream.maxTurnChars",
        "acp.stream.maxToolSummaryChars",
        "acp.stream.maxStatusChars",
        "acp.stream.maxMetaEventsPerTurn",
        "acp.stream.metaMode",
        "acp.stream.showUsage",
      ]),
    );
  });

  it("migrates old acp.stream keys to supported config", () => {
    const result = migrateLegacyConfig(LEGACY_ACP_STREAM_FIXTURE);
    expect(result.config).not.toBeNull();
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved acp.stream.maxTurnChars → acp.stream.maxOutputChars.",
        "Moved acp.stream.maxToolSummaryChars → acp.stream.maxSessionUpdateChars.",
        "Removed acp.stream.maxStatusChars (no replacement).",
        "Removed acp.stream.maxMetaEventsPerTurn (no replacement).",
        "Removed acp.stream.metaMode (no replacement).",
        "Removed acp.stream.showUsage (no replacement).",
      ]),
    );
    expect(result.config?.acp?.stream).toEqual({
      maxOutputChars: 5000,
      maxSessionUpdateChars: 1000,
    });
  });

  it("accepts legacy acp.stream keys through normal config validation after migration", () => {
    const result = validateConfigObjectWithPlugins(LEGACY_ACP_STREAM_FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.acp?.stream).toEqual({
      maxOutputChars: 5000,
      maxSessionUpdateChars: 1000,
    });
  });

  it("does not overwrite new keys that are already set", () => {
    const result = migrateLegacyConfig({
      acp: {
        stream: {
          maxTurnChars: 5000,
          maxToolSummaryChars: 1000,
          maxOutputChars: 9000,
          maxSessionUpdateChars: 300,
        },
      },
    });

    expect(result.config).not.toBeNull();
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Removed acp.stream.maxTurnChars (acp.stream.maxOutputChars already set).",
        "Removed acp.stream.maxToolSummaryChars (acp.stream.maxSessionUpdateChars already set).",
      ]),
    );
    expect(result.config?.acp?.stream).toEqual({
      maxOutputChars: 9000,
      maxSessionUpdateChars: 300,
    });
  });
});
