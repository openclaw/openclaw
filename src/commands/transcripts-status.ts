// Report transcript capture status through the canonical `transcripts.status`
// gateway RPC. A failed call must exit nonzero so automation cannot mistake a
// silent no-op for a healthy archive.
import type {
  TranscriptSessionSummary,
  TranscriptsStatusResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

function sectionCount(total: number, omitted: number): string {
  return omitted > 0 ? `${total} (${omitted} omitted)` : `${total}`;
}

function renderSessionRow(session: TranscriptSessionSummary): string {
  return `  ${sanitizeTerminalText(session.selector)}\t${sanitizeTerminalText(session.startedAt)}\t${sanitizeTerminalText(session.title?.trim() || "")}`;
}

function renderStatusLines(result: TranscriptsStatusResult): string[] {
  const lines: string[] = [];
  lines.push(`Transcript capture: ${result.enabled ? "enabled" : "disabled"}`);
  const providers = result.providers;
  if (providers.length > 0) {
    lines.push(`Providers (${sectionCount(providers.length, result.omitted.providers)}):`);
    for (const provider of providers) {
      lines.push(
        `  ${sanitizeTerminalText(provider.providerId ?? "")}\t${provider.availability ?? "unknown"}\t${sanitizeTerminalText(provider.name ?? "")}`,
      );
    }
  }
  const configuredSources = result.configuredSources;
  if (configuredSources.length > 0) {
    lines.push(
      `Configured sources (${sectionCount(configuredSources.length, result.omitted.configuredSources)}):`,
    );
    for (const source of configuredSources) {
      const title = source.title?.trim() || "";
      lines.push(
        `  ${sanitizeTerminalText(source.source.providerId ?? "")}\t${source.state ?? "unknown"}\t${sanitizeTerminalText(title)}`,
      );
    }
  }
  // `active` carries retained capture owners during stop or cleanup, so it is
  // only the subscription flag that proves capture is armed right now.
  const armed: TranscriptSessionSummary[] = [];
  const retained: TranscriptSessionSummary[] = [];
  for (const session of result.active) {
    (session.activeSubscription ? armed : retained).push(session);
  }
  let omittedActive = result.omitted.active;
  const activeHeader = (label: string, count: number): string => {
    const header = `${label} (${sectionCount(count, omittedActive)}):`;
    omittedActive = 0;
    return header;
  };
  if (armed.length > 0) {
    lines.push(activeHeader("Active captures", armed.length));
    for (const session of armed) {
      lines.push(renderSessionRow(session));
    }
  }
  if (retained.length > 0) {
    lines.push(activeHeader("Retained captures", retained.length));
    for (const session of retained) {
      lines.push(`${renderSessionRow(session)}\tnot subscribed`);
    }
  }
  const latest = result.latestTranscript;
  if (latest) {
    const title = latest.title?.trim() ? ` — ${sanitizeTerminalText(latest.title.trim())}` : "";
    lines.push(
      `Latest transcript: ${sanitizeTerminalText(latest.selector)} (${sanitizeTerminalText(latest.startedAt)})${title}`,
    );
  }
  if (lines.length === 1) {
    lines.push("No transcript providers, configured sources, or captures found.");
  }
  return lines;
}

export async function transcriptsStatusCommand(
  opts: {
    timeout?: string;
    url?: string;
    token?: string;
    password?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  // Omit the timeout entirely when the operator did not pass one: the shared
  // transport treats an explicit null as "disable the deadline", which would
  // leave a stalled gateway hanging this one-shot command forever.
  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    json: opts.json,
  };

  let result: TranscriptsStatusResult;
  try {
    result = await callGatewayFromCliWithTransport<TranscriptsStatusResult>(
      "transcripts.status",
      rpcOpts,
      {},
      { defaultTimeoutMs: 30_000 },
    );
  } catch (error) {
    rethrowExpectedCliError(error);
    const message = formatErrorMessage(error);
    if (opts.json) {
      writeRuntimeJson(runtime, formatCliJsonFailure(message));
    } else {
      runtime.error(`Failed to read transcript status: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }

  for (const line of renderStatusLines(result)) {
    runtime.log(line);
  }
}
