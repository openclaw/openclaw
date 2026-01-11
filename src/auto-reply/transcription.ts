import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { applyTemplate, type MsgContext } from "./templating.js";

const AUDIO_TRANSCRIPTION_BINARY = "whisper";

export function isAudio(mediaType?: string | null) {
  return Boolean(mediaType?.startsWith("audio"));
}

export function hasAudioTranscriptionConfig(cfg: ClawdbotConfig): boolean {
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
  const hasToolTranscriber = Boolean(toolTranscriber?.args?.length);
  if (!hasToolTranscriber && !legacyTranscriber?.command?.length) {
    return undefined;
  }

  const timeoutMs = Math.max(
    (toolTranscriber?.timeoutSeconds ??
      legacyTranscriber?.timeoutSeconds ??
      45) * 1000,
    1_000,
  );
  let tmpPath: string | undefined;
  let mediaPath = ctx.MediaPath;
  try {
    if (!mediaPath && ctx.MediaUrl) {
      const res = await fetch(ctx.MediaUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      tmpPath = path.join(
        os.tmpdir(),
        `clawdbot-audio-${crypto.randomUUID()}.ogg`,
      );
      await fs.writeFile(tmpPath, buffer);
      mediaPath = tmpPath;
      if (shouldLogVerbose()) {
        logVerbose(
          `Downloaded audio for transcription (${(buffer.length / (1024 * 1024)).toFixed(2)}MB) -> ${tmpPath}`,
        );
      }
    }
    if (!mediaPath) return undefined;

    const templCtx: MsgContext = { ...ctx, MediaPath: mediaPath };
    const argv = hasToolTranscriber
      ? [AUDIO_TRANSCRIPTION_BINARY, ...(toolTranscriber?.args ?? [])].map(
          (part, index) => (index === 0 ? part : applyTemplate(part, templCtx)),
        )
      : (legacyTranscriber?.command ?? []).map((part) =>
          applyTemplate(part, templCtx),
        );
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
