import { expect, it } from "vitest";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";

it.each(["ok", "skipped"] as const)(
  "keeps the operator restart command visible after later Doctor warnings (%s)",
  (status) => {
    const restart = "sudo systemctl restart openclaw-production.service";
    const warning = `System-scope Gateway service openclaw-production.service requires an operator restart. After the update, run: ${restart}`;
    const report = renderUpdateRunReport(
      updateRunReportInputFromResult({
        status,
        ...(status === "skipped" ? { reason: "already-current" } : {}),
        mode: "npm",
        durationMs: 0,
        steps: [
          { name: "managed-service-reconciliation", message: warning },
          ...[1, 2, 3].map((index) => ({
            name: `doctor-${index}`,
            message: `Doctor repair ${index} is deferred.`,
          })),
        ].map(({ name, message }) => ({
          name,
          command: "",
          cwd: "/fixture",
          durationMs: 0,
          exitCode: 0,
          advisory: { kind: "recoverable-maintenance", message },
        })),
      }),
    );
    expect(report.lines.filter((line) => line.startsWith("Warning: "))).toEqual([
      `Warning: ${warning}`,
      "Warning: Doctor repair 2 is deferred.",
      "Warning: Doctor repair 3 is deferred.",
    ]);
    expect(report.markdown).toContain(restart);
  },
);
