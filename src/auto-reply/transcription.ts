import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { applyTemplate, type MsgContext } from "./templating.js";

const AUDIO_TRANSCRIPTION_BINARY = "whisper";
const DEFAULT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

export function isAudio(mediaType?: string | null) {
  return Boolean(mediaType?.startsWith("audio"));
}

export function hasAudioTranscriptionConfig(cfg: ClawdbotConfig): boolean {
  if (cfg.tools?.audio?.transcription?.enabled === false) return false;
  if (cfg.tools?.audio?.transcription?.args?.length) return true;
  return Boolean(cfg.audio?.transcription?.command?.length);
}

export async function transcribeInboundAudio(
  cfg: ClawdbotConfig,
  ctx: MsgContext,
  runtime: RuntimeEnv,
): Promise<{ text: string } | undefined> {
  const toolTranscriber = cfg.tools?.audio?.transcription;
  const legacyTranscriber = cfg.audio?.transcription;
  if (toolTranscriber?.enabled === false) return undefined;
  const hasToolTranscriber = Boolean(toolTranscriber?.args?.length);
  if (!hasToolTranscriber && !legacyTranscriber?.command?.length) {
    return undefined;
  }

  const timeoutMs = Math.max(
    (toolTranscriber?.timeoutSeconds ?? legacyTranscriber?.timeoutSeconds ?? 45) * 1000,
    1_000,
  );
  const maxBytes =
    hasToolTranscriber &&
    typeof toolTranscriber?.maxBytes === "number" &&
    toolTranscriber.maxBytes > 0
      ? toolTranscriber.maxBytes
      : hasToolTranscriber
        ? DEFAULT_AUDIO_MAX_BYTES
        : undefined;
  let tmpPath: string | undefined;
  let mediaPath = ctx.MediaPath;
  try {
    if (!mediaPath && ctx.MediaUrl) {
      let fetched;
      try {
        fetched = await fetchRemoteMedia({
          url: ctx.MediaUrl,
          maxBytes,
        });
      } catch (err) {
        const message = String(err);
        if (maxBytes && message.includes("exceeds maxBytes")) {
          if (shouldLogVerbose()) {
            logVerbose(`Skipping audio transcription: ${message}`);
          }
          return undefined;
        }
        throw err;
      }
      const buffer = fetched.buffer;
      tmpPath = path.join(os.tmpdir(), `clawdbot-audio-${crypto.randomUUID()}.ogg`);
      await fs.writeFile(tmpPath, buffer);
      mediaPath = tmpPath;
      if (shouldLogVerbose()) {
        logVerbose(
          `Downloaded audio for transcription (${(buffer.length / (1024 * 1024)).toFixed(2)}MB) -> ${tmpPath}`,
        );
      }
    }
    if (!mediaPath) return undefined;
    if (maxBytes) {
      const stat = await fs.stat(mediaPath);
      if (!stat.isFile()) return undefined;
      if (stat.size > maxBytes) {
        if (shouldLogVerbose()) {
          logVerbose(
            `Skipping audio transcription: ${stat.size} bytes exceeds ${maxBytes}`,
          );
        }
        return undefined;
      }
    }

    const templCtx: MsgContext = { ...ctx, MediaPath: mediaPath };
    const argv = hasToolTranscriber
      ? [AUDIO_TRANSCRIPTION_BINARY, ...(toolTranscriber?.args ?? [])].map((part, index) =>
          index === 0 ? part : applyTemplate(part, templCtx),
        )
      : (legacyTranscriber?.command ?? []).map((part) => applyTemplate(part, templCtx));
    if (shouldLogVerbose()) {
      logVerbose(`Transcribing audio via command: ${argv.join(" ")}`);
    }
    const { stdout } = await runExec(argv[0], argv.slice(1), {
      timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text) return undefined;
    return { text };
  } catch (err) {
    runtime.error?.(`Audio transcription failed: ${String(err)}`);
    return undefined;
  } finally {
    if (tmpPath) {
      void fs.unlink(tmpPath).catch(() => {});
    }
  }
}
