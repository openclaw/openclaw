import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("Code Mode JavaScript config migration", () => {
  it.each(["entries", "list"])(
    "removes retired language settings from global config and the %s roster without changing activation or limits",
    (roster) => {
      const agent = {
        tools: { codeMode: { enabled: false, languages: ["typescript"], timeoutMs: 2500 } },
      };
      const raw = {
        tools: {
          codeMode: {
            enabled: "auto",
            languages: ["javascript", "typescript"],
            maxOutputBytes: 4096,
          },
        },
        agents:
          roster === "entries"
            ? { entries: { main: agent } }
            : { list: [{ id: "main", ...agent }] },
      };
      const original = structuredClone(raw);

      expect(findLegacyConfigIssues(raw)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "tools.codeMode.languages" }),
          expect.objectContaining({
            path: "agents",
            message: expect.stringContaining("JavaScript only"),
          }),
        ]),
      );

      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

      expect(migrated.partiallyValid).toBeUndefined();
      expect(migrated.config?.tools?.codeMode).toEqual({ enabled: "auto", maxOutputBytes: 4096 });
      expect(migrated.config?.agents?.entries?.main?.tools?.codeMode).toEqual({
        enabled: false,
        timeoutMs: 2500,
      });
      expect(raw).toEqual(original);
      expect(migrated.sourceConfig).toBeDefined();
      expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
      expect(
        migrateLegacyConfig(migrated.sourceConfig, {
          sourceConfigBeforeMigrations: migrated.sourceConfig,
        }).changes,
      ).toEqual([]);
    },
  );

  it.each([[], null, "typescript"])(
    "removes an empty or malformed language setting %j without enabling Code Mode",
    (languages) => {
      const raw = { tools: { codeMode: { languages } } };
      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

      expect(migrated.partiallyValid).toBeUndefined();
      expect(migrated.config?.tools?.codeMode).toEqual({});
      expect(migrated.sourceConfig).toBeDefined();
      expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
    },
  );
});
