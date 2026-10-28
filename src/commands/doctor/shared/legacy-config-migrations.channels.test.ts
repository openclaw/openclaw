import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfigForTest } from "./legacy-config-migrate.apply.test-support.js";

describe("legacy thread binding spawn migrate", () => {
  it.each([
    { legacy: { spawnSubagentSessions: true }, expected: { spawnSessions: true } },
    { legacy: { spawnAcpSessions: false }, expected: { spawnSessions: false } },
    {
      legacy: { spawnSubagentSessions: false, spawnAcpSessions: true },
      expected: { spawnSessions: false },
    },
    {
      legacy: { spawnSubagentSessions: "invalid", spawnAcpSessions: true },
      expected: { spawnSessions: true },
    },
    { legacy: { spawnSubagentSessions: "invalid", spawnAcpSessions: null }, expected: {} },
    {
      legacy: { spawnSubagentSessions: true, spawnAcpSessions: true, spawnSessions: false },
      expected: { spawnSessions: false },
    },
  ])(
    "preserves valid legacy flags and explicit canonical precedence: $legacy",
    ({ legacy, expected }) => {
      const raw = { session: { threadBindings: legacy } };
      expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain(
        "session.threadBindings",
      );
      const res = migrateLegacyConfigForTest(raw);
      expect(res.config?.session?.threadBindings).toEqual(expected);
      expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
    },
  );
});
