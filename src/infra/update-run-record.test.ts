import { describe, expect, it } from "vitest";
import { summarizeUpdateStepFailure } from "./update-run-record.js";

describe("failed update step summary", () => {
  const step = { name: "package-swap", exitCode: 1 };
  const advice =
    "Installation recovery is unverified; inspect the installation and backups in /fixture/lib/node_modules before restarting.";

  it.each(["stderrTail", "stdoutTail"] as const)(
    "keeps the head of the last meaningful %s line",
    (stream) => {
      const cause = `EACCES: permission denied ${"x".repeat(100)}🦞`;
      const summary = summarizeUpdateStepFailure({
        ...step,
        [stream]: `earlier output\n${cause}. ${advice}\n  `,
      });
      expect(summary).toBe(`Exit code: 1; ${cause.slice(0, 120)}`);
      expect(summary).not.toContain("Installation recovery");
    },
  );

  it("keeps the cause sentence ahead of generic recovery advice", () => {
    expect(
      summarizeUpdateStepFailure({ ...step, stderrTail: `EXDEV: cross-device move. ${advice}` }),
    ).toBe("Exit code: 1; EXDEV: cross-device move.");
  });

  it("ignores a separate recovery footer when older results have no failure facts", () => {
    expect(
      summarizeUpdateStepFailure({
        ...step,
        stderrTail: `earlier output\nEACCES: rename denied\n${advice}`,
      }),
    ).toBe("Exit code: 1; EACCES: rename denied");
    expect(summarizeUpdateStepFailure({ ...step, stderrTail: advice })).toContain(
      "Installation recovery is unverified",
    );
  });

  it("prefers recorded failure facts to the recovery footer", () => {
    expect(
      summarizeUpdateStepFailure({
        ...step,
        stderrTail: `retained package tree changed\n${advice}`,
        failureFacts: [{ check: "package-swap", code: "EACCES", message: "EACCES: rename denied" }],
      }),
    ).toBe("Exit code: 1; EACCES: rename denied");
    expect(
      summarizeUpdateStepFailure({
        ...step,
        failureFacts: [{ check: "package-swap", code: "EXDEV" }],
      }),
    ).toBe("Exit code: 1; EXDEV");
  });

  it("gives reason details the excerpt budget before the final outcome", () => {
    const reason = `Permission denied: ${"x".repeat(160)}`;
    const summary = summarizeUpdateStepFailure({
      ...step,
      failureFacts: [{ check: "doctor", code: "doctor-failed", message: "Doctor failed" }],
      stderrTail: `[openclaw] Reason: Doctor failed\n${reason}\n[openclaw] Help: openclaw --help\n${advice}`,
    });
    expect(summary).toBe(`Exit code: 1; ${reason.slice(0, 120)}`);
  });

  it("preserves schema preflight details and the Unicode-safe 300-character cap", () => {
    const cause = `Update refused: ${"x".repeat(268)}🦞 trailing detail`;
    const summary = summarizeUpdateStepFailure({
      ...step,
      name: "database-schema-preflight",
      stderrTail: `${cause}\n${advice}`,
    });
    expect(summary).toBe(`Exit code: 1; Update refused: ${"x".repeat(268)}🦞`);
    expect(summary).toHaveLength(300);
    const bounded = summarizeUpdateStepFailure({
      ...step,
      stderrTail: `${"x".repeat(119)}🦞 trailing detail`,
      stdoutTail: "y".repeat(200),
    });
    expect(bounded).toBe(`Exit code: 1; ${"y".repeat(120)}; ${"x".repeat(119)}`);
  });

  it("keeps the cause and a distinct terminal outcome within the stream budget", () => {
    const reason = `Connection refused: ${"🦞".repeat(100)}`;
    const outcome = `checks phase timed out: ${"🦞".repeat(100)}`;
    const summary = summarizeUpdateStepFailure({
      ...step,
      failureFacts: [{ check: "doctor", code: "doctor-failed", message: "Doctor failed" }],
      stderrTail: `[openclaw] Reason: Doctor failed\n${reason}\n[openclaw] Help: openclaw --help\n${outcome}`,
    });
    expect(summary).toMatch(/^Exit code: 1; Connection refused:/u);
    expect(summary).toContain("checks phase timed out:");
    expect(summary.length).toBeLessThanOrEqual("Exit code: 1; ".length + 120);
    expect(Buffer.from(summary).toString("utf8")).toBe(summary);
  });
});
