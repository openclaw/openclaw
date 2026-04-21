import fs from "node:fs/promises";
import path from "node:path";
import type { Runtime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { assembleDiagnosticContext } from "./diagnose/assemble-context.js";
import { KNOWN_ISSUES_PROMPT } from "./diagnose/known-issues.js";
import { renderCanvasHtml } from "./diagnose/render-canvas.js";
import { streamDiagnosticReport } from "./diagnose/stream-report.js";

export interface DiagnoseCommandOptions {
  output?: string;
  canvas: boolean;
  json: boolean;
  model?: string;
  maxLogEntries: number;
}

export async function diagnoseCommand(
  runtime: Runtime,
  opts: DiagnoseCommandOptions,
): Promise<void> {
  if (!opts.json) {
    runtime.log(theme.heading("OpenClaw Gateway Diagnostic Report"));
    runtime.log(theme.muted("Assembling diagnostic context..."));
    runtime.log("");
  }

  // Phase 2: assemble context from log, config, health, version, auth, memory.
  const context = await assembleDiagnosticContext({
    maxLogEntries: opts.maxLogEntries,
  });

  if (!opts.json) {
    runtime.log(
      theme.muted(
        `Context: ${context.logEntryCount} log entries, ` +
          `${context.authRejectCount} auth events, ` +
          `version ${context.version ?? "unknown"}`,
      ),
    );
    runtime.log("");
  }

  // Phase 3: stream report from LLM.
  // When --json is used and the gateway is unreachable, return the raw context
  // without AI analysis so the user can feed it to their own LLM offline.
  let report: { markdown: string; inputTokens: number; outputTokens: number; costUsd: number };
  try {
    report = await streamDiagnosticReport({
      context: context.text,
      knownIssues: KNOWN_ISSUES_PROMPT,
      modelOverride: opts.model,
      json: opts.json,
      onChunk: opts.json
        ? undefined
        : (chunk: string) => {
            process.stdout.write(chunk);
          },
    });
  } catch (err) {
    if (opts.json) {
      // Return raw context as fallback so --json is usable even when the
      // gateway is down — the documented offline analysis workflow.
      runtime.writeJson({
        status: "context-only",
        error: String(err),
        context: context.text,
        logEntryCount: context.logEntryCount,
        authRejectCount: context.authRejectCount,
        version: context.version,
      });
      return;
    }
    throw err;
  }

  if (!opts.json) {
    // Ensure final newline after streaming.
    process.stdout.write("\n\n");
    runtime.log(
      theme.muted(
        `Tokens: ${report.inputTokens.toLocaleString()} input, ` +
          `${report.outputTokens.toLocaleString()} output` +
          (report.costUsd > 0 ? ` (~$${report.costUsd.toFixed(4)})` : ""),
      ),
    );
  }

  // Save to file if --output specified.
  if (opts.output) {
    await fs.writeFile(opts.output, report.markdown, "utf-8");
    if (!opts.json) {
      runtime.log(theme.muted(`Report saved to ${opts.output}`));
    }
  }

  // Phase 4: save canvas HTML if --canvas specified.
  if (opts.canvas) {
    const canvasPath = await renderCanvasHtml(report.markdown);
    if (!opts.json) {
      runtime.log(theme.muted(`Canvas report saved to ${canvasPath}`));
      runtime.log(
        theme.muted("View at: http://127.0.0.1:18789/__openclaw__/canvas/diagnostics.html"),
      );
    }
  }

  // JSON output.
  if (opts.json) {
    runtime.writeJson({
      status: "ok",
      markdown: report.markdown,
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      costUsd: report.costUsd,
      logEntryCount: context.logEntryCount,
      authRejectCount: context.authRejectCount,
      version: context.version,
    });
  }
}
