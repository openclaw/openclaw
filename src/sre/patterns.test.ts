import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_GRANT_RE,
  HUMAN_CORRECTION_RE,
  matchesAccessGrant,
  matchesHumanCorrection,
} from "./patterns.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUG_REPORT_TRIAGE_PATH = path.join(REPO_ROOT, "skills", "morpho-sre", "bug-report-triage.sh");

function loadShellStringAssignments(script: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of script.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(['"])(.*)\2$/);
    if (match?.[1] && match[3] !== undefined) {
      assignments.set(match[1], match[3]);
    }
  }
  return assignments;
}

function expandShellVariableReference(
  name: string,
  assignments: Map<string, string>,
  seen = new Set<string>(),
): string {
  if (seen.has(name)) {
    throw new Error(`cyclic shell variable expansion for ${name}`);
  }
  const value = assignments.get(name);
  if (value === undefined) {
    throw new Error(`expected ${name} in bug-report-triage.sh`);
  }
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, nestedName: string) =>
    expandShellVariableReference(nestedName, assignments, nextSeen),
  );
}

function loadHumanCorrectionGrepPattern(): string {
  const script = fs.readFileSync(BUG_REPORT_TRIAGE_PATH, "utf8");
  return expandShellVariableReference(
    "HUMAN_CORRECTION_GREP_RE",
    loadShellStringAssignments(script),
  );
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
    expect(HUMAN_CORRECTION_RE.test("You now have access to Vercel.")).toBe(true);
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

  it("detects access-grant corrections", () => {
    expect(ACCESS_GRANT_RE.test("You now have access to Vercel.")).toBe(true);
    expect(ACCESS_GRANT_RE.test("You now have access to vercel!")).toBe(true);
    expect(ACCESS_GRANT_RE.test("You have access to Vercel.")).toBe(true);
    expect(ACCESS_GRANT_RE.test("You now have access to VERCEL and GitHub.")).toBe(true);
    expect(ACCESS_GRANT_RE.test("<@U0AK3R55V09> you now have access to Vercel.")).toBe(true);
    expect(matchesAccessGrant("FYI, you now have access to Vercel.")).toBe(true);
    expect(matchesAccessGrant("Status update: you now have permissions for Vercel.")).toBe(true);
    expect(matchesAccessGrant("Slack recap.\nAccess granted to the dashboard.")).toBe(true);
    expect(matchesAccessGrant("You have permissions for Vercel now.")).toBe(true);
    expect(matchesAccessGrant("Access granted to the dashboard.")).toBe(true);
    expect(matchesAccessGrant("You now have access to\nVercel.")).toBe(false);
    expect(matchesAccessGrant("You now have permissions for\nVercel.")).toBe(false);
    expect(matchesAccessGrant("We need to request access next week.")).toBe(false);
    expect(matchesAccessGrant("Do you have access to Vercel?")).toBe(false);
    expect(matchesAccessGrant("You have access to Vercel?")).toBe(false);
    expect(matchesAccessGrant("<@U0AK3R55V09> you have access to Vercel?")).toBe(false);
    expect(matchesAccessGrant("<@U0AK3R55V09> do you have access to Vercel?")).toBe(false);
    expect(matchesAccessGrant("We need to get you access to Vercel.")).toBe(false);
    expect(matchesAccessGrant("Let me check if you have access to Vercel.")).toBe(false);
    expect(matchesHumanCorrection("Do you have access to Vercel?")).toBe(false);
    expect(matchesHumanCorrection("You have access to Vercel?")).toBe(false);
    expect(matchesHumanCorrection("We need to get you access to Vercel.")).toBe(false);
    expect(matchesHumanCorrection("Let me check if you have access to Vercel.")).toBe(false);
  });

  it("bounds correction scans to a reasonable prefix length", () => {
    expect(matchesHumanCorrection(`This is wrong.${"x".repeat(10_000)}`)).toBe(true);
    expect(matchesHumanCorrection(`${"x".repeat(10_000)} This is wrong.`)).toBe(false);
  });

  it("handles unicode, null-byte, and boundary-shaped inputs", () => {
    expect(matchesAccessGrant("FYI, you now have access to Vercel – prod.")).toBe(true);
    expect(matchesHumanCorrection(`This is wrong.\0The bug is elsewhere.`)).toBe(true);
    expect(matchesHumanCorrection(`${"x".repeat(4_000)} This is wrong.`)).toBe(false);
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
        text: "You now have access to Vercel.",
        expected: true,
      },
      {
        text: "You now have access to vercel!",
        expected: true,
      },
      {
        text: "You have access to Vercel.",
        expected: true,
      },
      {
        text: "You now have access to VERCEL and GitHub.",
        expected: true,
      },
      {
        text: "You have access to Vercel?",
        expected: false,
      },
      {
        text: "You now have access to\nVercel.",
        expected: false,
      },
      {
        text: "Do you have access to Vercel?",
        expected: false,
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
