import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClawdisConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { applyTemplate, type MsgContext } from "./templating.js";

export function isAudio(mediaType?: string | null) {
  return Boolean(mediaType?.startsWith("audio"));
}

export async function transcribeInboundAudio(
  cfg: ClawdisConfig,
  ctx: MsgContext,
  runtime: RuntimeEnv,
): Promise<{ text: string } | undefined> {
  const transcriber = cfg.inbound?.transcribeAudio;
  if (!transcriber?.command?.length) return undefined;

  const timeoutMs = Math.max((transcriber.timeoutSeconds ?? 45) * 1000, 1_000);
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
        `clawdis-audio-${crypto.randomUUID()}.ogg`,
      );
      await fs.writeFile(tmpPath, buffer);
      mediaPath = tmpPath;
      if (isVerbose()) {
        logVerbose(
          `Downloaded audio for transcription (${(buffer.length / (1024 * 1024)).toFixed(2)}MB) -> ${tmpPath}`,
        );
      }
    }
    if (!mediaPath) return undefined;

    const templCtx: MsgContext = { ...ctx, MediaPath: mediaPath };
    const argv = transcriber.command.map((part) =>
      applyTemplate(part, templCtx),
    );
    if (isVerbose()) {
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
