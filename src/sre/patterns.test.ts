import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HUMAN_CORRECTION_RE, matchesHumanCorrection } from "./patterns.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUG_REPORT_TRIAGE_PATH = path.join(REPO_ROOT, "skills", "morpho-sre", "bug-report-triage.sh");

function loadHumanCorrectionGrepPattern(): string {
  const script = fs.readFileSync(BUG_REPORT_TRIAGE_PATH, "utf8");
  const match = script.match(/^HUMAN_CORRECTION_GREP_RE=(['"])(.+)\1$/m);
  if (!match?.[2]) {
    throw new Error("expected HUMAN_CORRECTION_GREP_RE in bug-report-triage.sh");
  }
  return match[2];
}

function shellPatternMatches(pattern: string, text: string): boolean {
  return spawnSync("grep", ["-Eiq", pattern], { input: text }).status === 0;
}

describe("HUMAN_CORRECTION_RE", () => {
  it("matches explicit scope corrections from humans", () => {
    expect(HUMAN_CORRECTION_RE.test("This is not the issue. The bug is elsewhere.")).toBe(true);
    expect(HUMAN_CORRECTION_RE.test("NOT A UI PROBLEM. We confirmed the stale lead.")).toBe(true);
    expect(HUMAN_CORRECTION_RE.test("The issue is actually the pending action chronology.")).toBe(
      true,
    );
    expect(
      HUMAN_CORRECTION_RE.test(
        "This is wrong. The issue is the pending action chronology instead of the old label theory.",
      ),
    ).toBe(true);
  });

  it("does not trip on routine non-correction phrasing", () => {
    expect(HUMAN_CORRECTION_RE.test("This is not ready for production yet.")).toBe(false);
    expect(HUMAN_CORRECTION_RE.test("This is not the right approach for rollout timing.")).toBe(
      false,
    );
    expect(HUMAN_CORRECTION_RE.test("This is not the main issue but we should still fix it.")).toBe(
      false,
    );
    expect(HUMAN_CORRECTION_RE.test("The issue is not performance.")).toBe(false);
  });

  it("stays true when multiple corrections appear in one message", () => {
    expect(
      HUMAN_CORRECTION_RE.test(
        "This is wrong. Current lead is stale. The bug is pending action chronology instead of label rendering.",
      ),
    ).toBe(true);
  });

  it("bounds correction scans to a reasonable prefix length", () => {
    expect(matchesHumanCorrection(`This is wrong.${"x".repeat(10_000)}`)).toBe(true);
    expect(matchesHumanCorrection(`${"x".repeat(10_000)} This is wrong.`)).toBe(false);
  });

  it("stays aligned with the shell mirror on curated cases", () => {
    const shellPattern = loadHumanCorrectionGrepPattern();
    const cases = [
      {
        text: "This is not the issue. The bug is elsewhere.",
        expected: true,
      },
      {
        text: "NOT A UI PROBLEM. We confirmed the stale lead.",
        expected: true,
      },
      {
        text: "The issue is actually the pending action chronology.",
        expected: true,
      },
      {
        text: "This is wrong. The issue is the pending action chronology instead of the old label theory.",
        expected: true,
      },
      {
        text: "This is not ready for production yet.",
        expected: false,
      },
      {
        text: "This is not the right approach for rollout timing.",
        expected: false,
      },
      {
        text: "This is not the main issue but we should still fix it.",
        expected: false,
      },
      {
        text: "The issue is not performance.",
        expected: false,
      },
    ];

    for (const sample of cases) {
      expect(HUMAN_CORRECTION_RE.test(sample.text)).toBe(sample.expected);
      expect(shellPatternMatches(shellPattern, sample.text)).toBe(sample.expected);
    }
  });
});
