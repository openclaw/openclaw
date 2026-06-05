/**
 * Session compact command.
 *
 * Delegates to the live gateway's `sessions.compact` RPC to trigger manual
 * compaction for a session transcript.
 */
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
import type { RuntimeEnv, RuntimeOutput } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

export type SessionsCompactOptions = {
  sessionKey: string;
  agent?: string;
  maxLines?: number;
  json?: boolean;
  /** Gateway call timeout in milliseconds. */
  timeoutMs?: number;
};

export type SessionsCompactResult = {
  ok: boolean;
  key?: string;
  compacted?: boolean;
  reason?: string;
  result?: {
    tokensBefore?: number;
    tokensAfter?: number;
    sessionId?: string;
  };
};

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

async function runSessionsCompact(
  opts: SessionsCompactOptions,
  output: RuntimeOutput,
): Promise<void> {
  try {
    const result = await callGateway<SessionsCompactResult>({
      method: "sessions.compact",
      params: {
        key: opts.sessionKey,
        agentId: opts.agent,
        maxLines: opts.maxLines,
      },
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["sessions.compact"],
      timeoutMs: opts.timeoutMs,
    });

    if (opts.json) {
      output.json(result);
      return;
    }

    if (!result.ok) {
      output.error(`Compaction failed: ${result.reason ?? "unknown error"}`);
      return;
    }

    const rich = isRich(output);
    if (result.compacted) {
      const tokensBefore = result.result?.tokensBefore;
      const tokensAfter = result.result?.tokensAfter;
      if (tokensBefore != null && tokensAfter != null) {
        output.write(
          rich
            ? `${theme.success("Compacted")}: ${theme.accent(formatTokenCount(tokensBefore))} → ${theme.accent(formatTokenCount(tokensAfter))} tokens`
            : `Compacted: ${formatTokenCount(tokensBefore)} → ${formatTokenCount(tokensAfter)} tokens`,
        );
      } else if (tokensBefore != null) {
        output.write(
          rich
            ? `${theme.success("Compacted")}: ${theme.accent(formatTokenCount(tokensBefore))} tokens before`
            : `Compacted: ${formatTokenCount(tokensBefore)} tokens before`,
        );
      } else {
        output.write(rich ? theme.success("Compacted") : "Compacted");
      }
    } else {
      const reason = result.reason ?? "unknown";
      output.write(
        rich ? `${theme.muted("Compaction skipped")}: ${reason}` : `Compaction skipped: ${reason}`,
      );
    }
  } catch (error) {
    if (isGatewayTransportError(error)) {
      output.error("Gateway is not running. Start the gateway to compact sessions.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    output.error(`Compaction failed: ${message}`);
  }
}

export async function sessionsCompactCommand(
  opts: SessionsCompactOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  await runSessionsCompact(opts, runtime);
}
