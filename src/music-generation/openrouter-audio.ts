import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import {
  collectErrorGraphCandidates,
  readErrorCauses,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withResponseBodyTimeout } from "../infra/http-response-body-timeout.js";

const OPENROUTER_SSE_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

function readDeltaAudio(part: unknown) {
  const choices = asOptionalRecord(part)?.choices;
  const first = Array.isArray(choices) ? asOptionalRecord(choices[0]) : undefined;
  const audio = asOptionalRecord(asOptionalRecord(first?.delta)?.audio);
  if (!audio) {
    return undefined;
  }
  return {
    data: normalizeOptionalString(audio.data),
    transcript: typeof audio.transcript === "string" ? audio.transcript : undefined,
  };
}

function resolveOpenRouterSseEventMaxBytes(maxBytes: number): number {
  const maxBase64Bytes = Math.ceil(maxBytes / 3) * 4;
  return maxBase64Bytes + maxBytes + OPENROUTER_SSE_ENVELOPE_OVERHEAD_BYTES;
}

function createOpenRouterMusicTooLargeError(kind: "audio" | "transcript", maxBytes: number) {
  return new Error(`OpenRouter music generation ${kind} exceeded ${maxBytes} bytes`);
}

function readOpenRouterStreamError(part: unknown): string | undefined {
  if (!isRecord(part) || !isRecord(part.error)) {
    return undefined;
  }
  return normalizeOptionalString(part.error.message) ?? "unknown provider stream error";
}

/** Decode native audio deltas without selecting credentials, a model, or a network destination. */
export async function readOpenRouterAudioStream(
  response: Response,
  maxBytes: number,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number | (() => number);
    maxWireBytes?: number;
    maxTranscriptBytes?: number;
    /** Require complete EOF, fatal UTF-8 and an unambiguous single-choice stream. */
    requireEof?: boolean;
  },
) {
  if (!response.body) {
    throw new Error("OpenRouter music generation response missing stream body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: options?.requireEof === true });
  let wireBytes = 0;
  let completed = false;
  const result = {
    audioBuffers: [] as Buffer[],
    audioBytes: 0,
    audioBase64Remainder: "",
    transcriptChunks: [] as string[],
    transcriptBytes: 0,
  };
  function appendDecodedOpenRouterMusicAudio(base64: string): void {
    if (!base64) {
      return;
    }
    const remainingBytes = maxBytes - result.audioBytes;
    if (estimateBase64DecodedBytes(base64) > remainingBytes) {
      throw createOpenRouterMusicTooLargeError("audio", maxBytes);
    }
    const canonicalAudio = canonicalizeBase64(base64);
    if (!canonicalAudio) {
      throw new Error("OpenRouter music generation returned malformed base64 audio data");
    }
    const buffer = Buffer.from(canonicalAudio, "base64");
    result.audioBytes += buffer.byteLength;
    result.audioBuffers.push(buffer);
  }

  function appendOpenRouterMusicAudio(data: string): void {
    // OpenRouter defines delta.audio.data as slices of one base64 stream. Keep
    // only the incomplete quartet so arbitrary provider chunk boundaries decode safely.
    const combined = result.audioBase64Remainder + data;
    const completeLength = combined.length - (combined.length % 4);
    result.audioBase64Remainder = combined.slice(completeLength);
    appendDecodedOpenRouterMusicAudio(combined.slice(0, completeLength));
  }

  function finishOpenRouterMusicStream() {
    appendDecodedOpenRouterMusicAudio(result.audioBase64Remainder);
    result.audioBase64Remainder = "";
    return {
      audioBuffer: Buffer.concat(result.audioBuffers, result.audioBytes),
      transcript: result.transcriptChunks.join(""),
    };
  }

  function appendOpenRouterMusicTranscript(transcript: string): void {
    const nextBytes = result.transcriptBytes + Buffer.byteLength(transcript, "utf8");
    const limit = options?.maxTranscriptBytes ?? maxBytes;
    if (nextBytes > limit) {
      throw createOpenRouterMusicTooLargeError("transcript", limit);
    }
    result.transcriptBytes = nextBytes;
    result.transcriptChunks.push(transcript);
  }

  function processOpenRouterSseLine(line: string): boolean {
    if (!line.startsWith("data:")) {
      return false;
    }
    const data = line.slice("data:".length).trim();
    if (!data) {
      return false;
    }
    if (completed) {
      throw new Error("OpenRouter music generation returned data after completion");
    }
    if (data === "[DONE]") {
      completed = true;
      return true;
    }
    let payload: unknown;
    if (!options?.requireEof) {
      payload = JSON.parse(data);
    } else {
      try {
        payload = JSON.parse(data);
      } catch {
        // Parser diagnostics may contain generated content; keep proxy failures sanitized.
        throw new Error("OpenRouter music generation returned malformed stream JSON");
      }
    }
    if (options?.requireEof) {
      const object = asOptionalRecord(payload);
      if (!object || object.error !== undefined) {
        throw new Error("OpenRouter music generation stream failed");
      }
      const choices = object.choices;
      if (choices !== undefined && (!Array.isArray(choices) || choices.length > 1)) {
        throw new Error("OpenRouter music generation returned ambiguous choices");
      }
      const choice = Array.isArray(choices) ? asOptionalRecord(choices[0]) : undefined;
      if (choice?.index != null && choice.index !== 0) {
        throw new Error("OpenRouter music generation returned ambiguous choices");
      }
      const audio = asOptionalRecord(asOptionalRecord(choice?.delta)?.audio);
      if (
        audio &&
        ((audio.data !== undefined && typeof audio.data !== "string") ||
          (audio.transcript !== undefined && typeof audio.transcript !== "string"))
      ) {
        throw new Error("OpenRouter music generation returned malformed audio");
      }
      if (choice?.finish_reason != null && choice.finish_reason !== "stop") {
        throw new Error("OpenRouter music generation returned incomplete output");
      }
    }
    const streamError = readOpenRouterStreamError(payload);
    if (streamError) {
      throw new Error(
        options?.requireEof
          ? "OpenRouter music generation stream failed"
          : `OpenRouter music generation failed: ${streamError}`,
      );
    }
    const audio = readDeltaAudio(payload);
    if (audio?.data) {
      appendOpenRouterMusicAudio(audio.data);
    }
    if (audio?.transcript) {
      appendOpenRouterMusicTranscript(audio.transcript);
    }
    return false;
  }

  const maxEventBytes = resolveOpenRouterSseEventMaxBytes(maxBytes);
  const lineFragments: string[] = [];
  let pendingBytes = 0;
  try {
    const timeoutMs =
      typeof options?.timeoutMs === "function" ? options.timeoutMs() : options?.timeoutMs;
    return await withResponseBodyTimeout({
      timeoutMs,
      signal: options?.signal,
      onTimeout: undefined,
      cancel: async (error) => await reader.cancel(error),
      read: async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          wireBytes += value.byteLength;
          if (options?.maxWireBytes !== undefined && wireBytes > options.maxWireBytes) {
            throw new Error("OpenRouter music generation wire exceeded its byte limit");
          }
          for (const byte of value) {
            pendingBytes = byte === 0x0a ? 0 : pendingBytes + 1;
            if (pendingBytes > maxEventBytes) {
              throw new Error(
                `OpenRouter music generation SSE event exceeded ${maxEventBytes} bytes for a ${maxBytes}-byte media limit`,
              );
            }
          }
          const chunk = decoder.decode(value, { stream: true });
          let start = 0;
          // Audio events can span many chunks; scan only new text and join each line once.
          for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
            let line = chunk.slice(start, end);
            start = end + 1;
            if (lineFragments.length > 0) {
              lineFragments.push(line);
              line = lineFragments.join("");
              lineFragments.length = 0;
            }
            if (processOpenRouterSseLine(line.trim()) && !options?.requireEof) {
              return finishOpenRouterMusicStream();
            }
          }
          if (start < chunk.length) {
            lineFragments.push(chunk.slice(start));
          }
        }
        lineFragments.push(decoder.decode());
        const buffer = lineFragments.join("");
        pendingBytes = Buffer.byteLength(buffer, "utf8");
        if (pendingBytes > maxEventBytes) {
          throw new Error(
            `OpenRouter music generation SSE event exceeded ${maxEventBytes} bytes for a ${maxBytes}-byte media limit`,
          );
        }
        if (buffer.trim()) {
          processOpenRouterSseLine(buffer.trim());
        }
        if (!completed) {
          throw new Error("OpenRouter music generation stream ended before completion");
        }
        options?.signal?.throwIfAborted();
        if (typeof options?.timeoutMs === "function") {
          options.timeoutMs();
        }
        return finishOpenRouterMusicStream();
      },
    });
  } catch (error) {
    if (
      options?.requireEof &&
      collectErrorGraphCandidates(error, readErrorCauses).some(
        (cause) => readErrorName(cause) === "TimeoutError",
      )
    ) {
      // Guarded fetch can wrap its actual deadline cause as a generic body termination.
      throw new Error("OpenRouter music generation timed out", { cause: error });
    }
    throw error;
  } finally {
    // A capture tee can keep cancellation pending until its sibling finishes.
    // Release the reader without waiting so the request owner can abort transport.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read can still be pending while transport cancellation settles.
    }
  }
}
