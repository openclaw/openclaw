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
        ...Array.from({ length: 6 }, (_, index) => ({
          code: "transcript_missing",
          message: `Current transcript ${index + 2} is missing.`,
        })),
      ],
    },
    {
      storePath: "/example/other-sessions.json",
      issues: [{ code: "historical_transcript_deferred", message: "Other store claim retained." }],
    },
  ];
  const findings = collectSessionSqliteMigrationFindings(targets, {});
  const historical = findings.filter((finding) => finding.category === "historical");
  const current = findings.filter((finding) => finding.category === "fix-now");
  expect(historical).toHaveLength(1);
  expect(historical.at(-1)?.message).toContain(
    "8 historical recovery notice(s); showing 5 example(s), 3 omitted",
  );
  expect(historical[0]?.message).not.toContain("Historical claim 6 retained.");
  expect(historical[0]?.message).not.toContain("Other store claim retained.");
  expect(historical[0]?.fixHint).toContain("--session-sqlite-all-agents --json");
  expect(historical[0]?.fixHint).toContain(
    "No action needed if expected conversations are visible",
  );
  expect(current.map((finding) => [finding.errorCode, finding.message])).toEqual([
    ["transcript_missing", "Current transcript is missing."],
    ["transcript_missing", "Current transcript 2 is missing."],
    ["transcript_missing", "Current transcript 3 is missing."],
    ["transcript_missing", "Current transcript 4 is missing."],
    ["transcript_missing", "Current transcript 5 is missing."],
    ["transcript_missing", "Current transcript 6 is missing."],
    ["transcript_missing", "Current transcript 7 is missing."],
  ]);
  expect(formatSessionSqliteMigrationWarnings(targets, {}).join("\n")).toContain(
    "historical_transcript_deferred",
  );
  expect(targets[0]?.issues).toHaveLength(14);
});
