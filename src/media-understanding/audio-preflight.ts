// Audio preflight transcribes voice notes before mention checks and optionally
// echoes the transcript back to the source chat.
import { createHash } from "node:crypto";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import { isAudioAttachment } from "./attachments.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import { normalizeMediaAttachments, resolveMediaAttachmentLocalRoots } from "./runner.js";
import type {
  MediaAttachment,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export type AudioPreflightStatus =
  | "success"
  | "missing"
  | "timeout"
  | "failed"
  | "truncated"
  | "disabled";

export type AudioPreflightTranscriptTelemetry = {
  length: number;
  sha256?: string;
  trusted: boolean;
  truncated: boolean;
  enteredAgentContext: boolean;
};

export type AudioPreflightTelemetry = {
  status: AudioPreflightStatus;
  provider?: string;
  model?: string;
  baseUrl?: string;
  durationMs: number;
  errorClass?: string;
  transcript: AudioPreflightTranscriptTelemetry;
};

export type AudioPreflightResult = {
  transcript?: string;
  attachments: MediaAttachment[];
  telemetry: AudioPreflightTelemetry;
};

type TranscribeFirstAudioParams = {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
};

function hashTranscript(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex");
}

function classifyError(err: unknown): { status: "timeout" | "failed"; errorClass: string } {
  const name =
    err && typeof err === "object" && "name" in err && typeof err.name === "string"
      ? err.name.trim()
      : "";
  const message = err instanceof Error ? err.message : String(err);
  const errorClass = name || (err instanceof Error ? err.constructor.name : "") || "Error";
  if (/timeout|timed out|abort/i.test(`${errorClass} ${message}`)) {
    return { status: "timeout", errorClass };
  }
  return { status: "failed", errorClass };
}

function selectedDecisionAttempt(decision?: MediaUnderstandingDecision) {
  for (const attachment of decision?.attachments ?? []) {
    if (attachment.chosen) {
      return attachment.chosen;
    }
  }
  for (const attachment of decision?.attachments ?? []) {
    const attempt = attachment.attempts.find((entry) => entry.provider || entry.model);
    if (attempt) {
      return attempt;
    }
  }
  return undefined;
}

function resolveMissingErrorClass(decision?: MediaUnderstandingDecision): string | undefined {
  for (const attachment of decision?.attachments ?? []) {
    const failed = attachment.attempts.find((entry) => entry.outcome === "failed");
    if (failed?.reason) {
      return failed.reason.split(":")[0]?.trim() || failed.reason;
    }
    const skipped = attachment.attempts.find((entry) => entry.outcome === "skipped");
    if (skipped?.reason) {
      return skipped.reason.split(":")[0]?.trim() || skipped.reason;
    }
  }
  return undefined;
}

function buildTelemetry(params: {
  status: AudioPreflightStatus;
  startedAtMs: number;
  transcript?: string;
  output?: MediaUnderstandingOutput;
  decision?: MediaUnderstandingDecision;
  errorClass?: string;
}): AudioPreflightTelemetry {
  const transcript = params.transcript ?? "";
  const decisionAttempt = selectedDecisionAttempt(params.decision);
  const truncated = params.status === "truncated" || params.output?.truncated === true;
  const provider = params.output?.provider ?? decisionAttempt?.provider;
  const model = params.output?.model ?? decisionAttempt?.model;
  return {
    status: truncated && params.transcript ? "truncated" : params.status,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(params.output?.baseUrl ? { baseUrl: params.output.baseUrl } : {}),
    durationMs: Math.max(0, Date.now() - params.startedAtMs),
    ...(params.errorClass ? { errorClass: params.errorClass } : {}),
    transcript: {
      length: transcript.length,
      ...(transcript ? { sha256: hashTranscript(transcript) } : {}),
      trusted: params.output?.trusted === true,
      truncated,
      enteredAgentContext: false,
    },
  };
}

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: TranscribeFirstAudioParams): Promise<
  string | undefined
> {
  return (await transcribeFirstAudioWithTelemetry(params))?.transcript;
}

/**
 * Transcribes the first audio attachment and returns telemetry even when the
 * transcript is missing, timed out, failed, truncated, or explicitly untrusted.
 */
export async function transcribeFirstAudioWithTelemetry(
  params: TranscribeFirstAudioParams,
): Promise<AudioPreflightResult | undefined> {
  const { ctx, cfg } = params;
  const startedAtMs = Date.now();

  const audioConfig = cfg.tools?.media?.audio;
  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (audioConfig?.enabled === false) {
    return {
      attachments,
      telemetry: buildTelemetry({
        status: "disabled",
        startedAtMs,
      }),
    };
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  try {
    const { transcript, output, decision } = await runAudioTranscription({
      ctx,
      cfg,
      attachments,
      agentDir: params.agentDir,
      providers: params.providers,
      activeModel: params.activeModel,
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg, ctx }),
    });
    if (!transcript) {
      return {
        attachments,
        telemetry: buildTelemetry({
          status: "missing",
          startedAtMs,
          output,
          decision,
          errorClass: resolveMissingErrorClass(decision),
        }),
      };
    }

    if (audioConfig?.echoTranscript) {
      await sendTranscriptEcho({
        ctx,
        cfg,
        transcript,
        format: audioConfig.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
      });
    }

    // Mark this attachment as transcribed so the main media pass does not duplicate STT output.
    firstAudio.alreadyTranscribed = true;
    const status = output?.truncated === true ? "truncated" : "success";

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return {
      transcript,
      attachments,
      telemetry: buildTelemetry({
        status,
        startedAtMs,
        transcript,
        output,
        decision,
      }),
    };
  } catch (err) {
    // Preflight cannot block message handling; mention checks can still run on text-only input.
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    const { status, errorClass } = classifyError(err);
    return {
      attachments,
      telemetry: buildTelemetry({
        status,
        startedAtMs,
        errorClass,
      }),
    };
  }
}
