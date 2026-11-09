import { describe, expect, it } from "vitest";
import { summarizeUpdateStepFailure } from "./update-run-record.js";

describe("failed update step summary", () => {
  const step = { name: "package-swap", exitCode: 1 };
  const advice =
    "Installation recovery is unverified; inspect the installation and backups in /fixture/lib/node_modules before restarting.";
  const cause = `EACCES: permission denied ${"x".repeat(100)}🦞`;
  const reasonDetails = `Permission denied: ${"x".repeat(160)}`;
  const facts = [{ check: "doctor", code: "doctor-failed", message: "Doctor failed" }];

  it.each<{
    label: string;
    input: Partial<Parameters<typeof summarizeUpdateStepFailure>[0]>;
    expected: string;
  }>([
    ...(["stderrTail", "stdoutTail"] as const).map((stream) => ({
      label: `last meaningful ${stream} line`,
      input: { [stream]: `earlier output\n${cause}. ${advice}\n  ` },
      expected: cause.slice(0, 120),
    })),
    {
      label: "inline recovery advice",
      input: { stderrTail: `EXDEV: cross-device move. ${advice}` },
      expected: "EXDEV: cross-device move.",
    },
    {
      label: "legacy recovery footer",
      input: { stderrTail: `earlier output\nEACCES: rename denied\n${advice}` },
      expected: "EACCES: rename denied",
    },
    {
      label: "footer without a cause",
      input: { stderrTail: advice },
      expected: advice.slice(0, 120),
    },
    {
      label: "recorded failure message",
      input: {
        stderrTail: `retained package tree changed\n${advice}`,
        failureFacts: [{ check: "package-swap", code: "EACCES", message: "EACCES: rename denied" }],
      },
      expected: "EACCES: rename denied",
    },
    {
      label: "recorded failure code",
      input: { failureFacts: [{ check: "package-swap", code: "EXDEV" }] },
      expected: "EXDEV",
    },
    {
      label: "reason ahead of final outcome",
      input: {
        failureFacts: facts,
        stderrTail: `[openclaw] Reason: Doctor failed\n${reasonDetails}\n[openclaw] Help: openclaw --help\n${advice}`,
      },
      expected: reasonDetails.slice(0, 120),
    },
    {
      label: "schema cause at the 300-character boundary",
      input: {
        name: "database-schema-preflight",
        stderrTail: `Update refused: ${"x".repeat(268)}🦞 trailing detail\n${advice}`,
      },
      expected: `Update refused: ${"x".repeat(268)}🦞`,
    },
    {
      label: "independent Unicode-safe stream budgets",
      input: {
        stderrTail: `${"x".repeat(119)}🦞 trailing detail`,
        stdoutTail: "y".repeat(200),
      },
      expected: `${"y".repeat(120)}; ${"x".repeat(119)}`,
    },
  ])("preserves the cause for $label", ({ input, expected }) => {
    const summary = summarizeUpdateStepFailure({ ...step, ...input });
    expect(summary).toBe(`Exit code: 1; ${expected}`);
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(Buffer.from(summary).toString("utf8")).toBe(summary);
  });

  it("keeps the cause and a distinct terminal outcome within the stream budget", () => {
    const reason = `Connection refused: ${"🦞".repeat(100)}`;
    const outcome = `checks phase timed out: ${"🦞".repeat(100)}`;
    const summary = summarizeUpdateStepFailure({
      ...step,
      failureFacts: facts,
      stderrTail: `[openclaw] Reason: Doctor failed\n${reason}\n[openclaw] Help: openclaw --help\n${outcome}`,
    });
    expect(summary).toMatch(/^Exit code: 1; Connection refused:/u);
    expect(summary).toContain("checks phase timed out:");
    expect(summary.length).toBeLessThanOrEqual("Exit code: 1; ".length + 120);
    expect(Buffer.from(summary).toString("utf8")).toBe(summary);
  });
});
