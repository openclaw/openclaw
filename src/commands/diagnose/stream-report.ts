import { callGatewayFromCli } from "../../cli/gateway-rpc.js";
import type { GatewayRpcOpts } from "../../cli/gateway-rpc.types.js";

export interface StreamReportOptions {
  /** Assembled diagnostic context (Markdown). */
  context: string;
  /** Known-issues reference prompt. */
  knownIssues: string;
  /** Model override (e.g. "claude-haiku-4-5"). */
  modelOverride?: string;
  /** JSON mode — suppress streaming output. */
  json: boolean;
  /** Callback for each streamed chunk (undefined in JSON mode). */
  onChunk?: (chunk: string) => void;
}

export interface DiagnosticReport {
  markdown: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function buildDiagnosticPrompt(context: string, knownIssues: string): string {
  const now = new Date().toLocaleString();
  return (
    knownIssues +
    "\n\n---\n\n" +
    context +
    "\n\n---\n\n" +
    `Current date and time: ${now}\n\n` +
    "Based on the diagnostic data above, produce a structured report of all issues found. " +
    `Begin the report with the exact H1 heading: '# OpenClaw Gateway Diagnostic Report — ${now}'\n\n` +
    "Use the following exact two-section structure:\n\n" +
    "## 1) Executive Summary\n" +
    "One paragraph of overall health assessment, followed by an alphabetically enumerated list " +
    "of every distinct issue found — one line each — using this format:\n" +
    "- Issue A — [one-sentence summary]\n" +
    "- Issue B — [one-sentence summary]\n" +
    "(and so on)\n\n" +
    "## 2) Findings\n" +
    "One subsection per issue, labeled with the SAME letter used in the Executive Summary:\n" +
    "### Issue A — [same title]\n" +
    "- **What it means**: ...\n" +
    "- **Log entries**: list every log entry timestamp that relates to this issue, one per line, " +
    "in the format `HH:MM:SS — [log text]`. If there are many identical entries, list the first " +
    "and last timestamp and note the count in between.\n" +
    "- **Likely root cause**: ...\n" +
    "- **Fix**: ...\n\n" +
    "Group identical or closely related log patterns under a single issue letter. " +
    "If no issues were found, state that clearly in the Executive Summary and omit the Findings section. " +
    "Focus on actionable findings only — do not pad the report with caveats."
  );
}

export async function streamDiagnosticReport(
  opts: StreamReportOptions,
): Promise<DiagnosticReport> {
  const prompt = buildDiagnosticPrompt(opts.context, opts.knownIssues);

  const gatewayOpts: GatewayRpcOpts = {
    timeout: "120000",
  };

  const agentParams: Record<string, unknown> = {
    message: prompt,
  };
  if (opts.modelOverride) {
    agentParams.model = opts.modelOverride;
  }

  try {
    const response = await callGatewayFromCli("agent", gatewayOpts, agentParams, {
      expectFinal: true,
    });

    // Extract text from the agent response payloads.
    const payloads = (response as Record<string, unknown>)?.result as
      | { payloads?: Array<{ text?: string }>; meta?: Record<string, unknown> }
      | undefined;
    const textParts = (payloads?.payloads ?? [])
      .map((p) => p.text ?? "")
      .filter(Boolean);
    const markdown = textParts.join("\n");

    // Emit the full report via callback (non-streaming, but matches the interface).
    if (opts.onChunk && markdown) {
      opts.onChunk(markdown);
    }

    // Token usage is not directly available from the gateway RPC response;
    // return zeros. A future enhancement could parse usage from the agent meta.
    return {
      markdown,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  } catch (err) {
    const message = String(err);
    if (message.includes("ECONNREFUSED") || message.includes("connect")) {
      throw new Error(
        "Could not connect to the OpenClaw gateway. The gateway must be running " +
          "to perform AI-powered diagnostics.\n\n" +
          "Start the gateway with: openclaw gateway\n" +
          "Or use: openclaw diagnose --json  to get the raw diagnostic context " +
          "without AI analysis.",
      );
    }
    throw err;
  }
}
