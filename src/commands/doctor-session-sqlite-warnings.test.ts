import { expect, it } from "vitest";
import {
  collectSessionSqliteMigrationFindings,
  formatSessionSqliteMigrationWarnings,
} from "./doctor-session-sqlite-warnings.js";

it("bounds historical examples without presenting them as current failures or losing retained warning evidence", () => {
  const targets = [
    {
      storePath: "/example/sessions.json",
      issues: [
        ...Array.from({ length: 7 }, (_, index) => ({
          code: "historical_transcript_deferred",
          message: `Historical claim ${index + 1} retained.`,
        })),
        { code: "transcript_missing", message: "Current transcript is missing." },
      ],
    },
  ];
  const findings = collectSessionSqliteMigrationFindings(targets, {});
  const historical = findings.filter((finding) => finding.category === "historical");
  const current = findings.filter((finding) => finding.category === "fix-now");
  expect(historical).toHaveLength(6);
  expect(historical.at(-1)?.message).toContain(
    "7 historical recovery notice(s); showing 5 example(s), 2 omitted",
  );
  expect(historical.at(-1)?.message).toContain("--session-sqlite-all-agents --json");
  expect(historical[0]?.fixHint).toContain(
    "No action needed if expected conversations are visible",
  );
  expect(current.map((finding) => finding.message)).toEqual(["Current transcript is missing."]);
  expect(formatSessionSqliteMigrationWarnings(targets, {}).join("\n")).toContain(
    "historical_transcript_deferred",
  );
  expect(targets[0]?.issues).toHaveLength(8);
});
