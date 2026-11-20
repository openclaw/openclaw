import { projectAgentHarnessTranscriptMessageForDisplay } from "../agents/harness/transcript-visibility.js";
import { buildUsageWithNoCost } from "../agents/stream-message-shared.js";
import { REALTIME_VOICE_TRANSCRIPT_API } from "../agents/usage.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RealtimeVoiceUsageReport } from "./provider-types.js";

const log = createSubsystemLogger("talk/usage");

function describeUsage(usage: RealtimeVoiceUsageReport): string {
  const { input, cachedInput, output } = usage;
  return [
    `provider=${usage.provider}`,
    `model=${usage.model}`,
    `response=${usage.responseId ?? "unknown"}`,
    `status=${usage.status}`,
    `input=text:${input.text},audio:${input.audio},image:${input.image}`,
    `cached=text:${cachedInput.text},audio:${cachedInput.audio},image:${cachedInput.image}`,
    `output=text:${output.text},audio:${output.audio}`,
  ].join(" ");
}

/**
 * Records one realtime response's usage as a hidden, empty assistant row so session usage and
 * cost reports include it. The response id is the idempotency key: a replayed report adds nothing.
 */
export async function recordRealtimeVoiceUsage(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  usage: RealtimeVoiceUsageReport;
}): Promise<void> {
  const { usage } = params;
  const { input, cachedInput, output } = usage;
  const cacheRead = cachedInput.text + cachedInput.audio + cachedInput.image;
  log.debug(`realtime voice usage ${describeUsage(usage)}`);
  try {
    const result = await appendExactAssistantMessageToSessionTranscript({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      ...(params.cfg ? { config: params.cfg } : {}),
      ...(usage.responseId
        ? { idempotencyKey: `realtime-voice-usage:${usage.provider}:${usage.responseId}` }
        : {}),
      // Like CLI usage-only rows: hidden in chat, and replay drops empty assistant rows.
      message: projectAgentHarnessTranscriptMessageForDisplay({
        hidden: true,
        message: {
          role: "assistant",
          content: [],
          // Marks a billing-only row: context and model readers skip it (isBillingOnlyUsageRecord).
          api: REALTIME_VOICE_TRANSCRIPT_API,
          provider: usage.provider,
          model: usage.model,
          usage: buildUsageWithNoCost({
            // Provider input counts include cached tokens; transcript input is uncached only.
            input: Math.max(0, input.text + input.audio + input.image - cacheRead),
            output: output.text + output.audio,
            cacheRead,
          }),
          // A barge-in cancel is normal turn-taking, not an error in usage reports.
          stopReason: usage.status === "failed" || usage.status === "incomplete" ? "error" : "stop",
          timestamp: Date.now(),
        },
      }),
    });
    if (!result.ok) {
      log.warn(`realtime voice usage not recorded: ${result.reason} ${describeUsage(usage)}`);
    }
  } catch (error) {
    log.warn(
      `realtime voice usage not recorded: ${formatErrorMessage(error)} ${describeUsage(usage)}`,
    );
  }
}
