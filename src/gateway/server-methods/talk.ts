import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "../../media-understanding/runner.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkModeParams,
  validateTalkSttParams,
} from "../protocol/index.js";

function isNoSpeechDecision(decision: unknown): boolean {
  const attachments = (decision as { attachments?: unknown } | null)?.attachments as
    | Array<{ attempts?: Array<{ reason?: unknown; outcome?: unknown }> }>
    | undefined;
  const firstAttempts = attachments?.[0]?.attempts ?? [];
  for (const attempt of firstAttempts) {
    if (attempt?.outcome !== "failed") {
      continue;
    }
    const reason = typeof attempt.reason === "string" ? attempt.reason : "";
    const normalized = reason.toLowerCase();
    if (normalized.includes("missing transcript") || normalized.includes("missing text")) {
      return true;
    }
  }
  return false;
}

export const talkHandlers: GatewayRequestHandlers = {
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
  "talk.stt": async ({ params, respond }) => {
    if (!validateTalkSttParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.stt params: ${formatValidationErrors(validateTalkSttParams.errors)}`,
        ),
      );
      return;
    }

    const decoded = Buffer.from((params as { audioB64: string }).audioB64, "base64");
    if (decoded.length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "audioB64 decoded empty"));
      return;
    }

    const mime = (params as { mime?: string }).mime?.trim() || "audio/wav";
    const language = (params as { language?: string }).language?.trim() || undefined;
    const sessionKey = (params as { sessionKey?: string }).sessionKey?.trim() || "main";
    const timeoutMs = (params as { timeoutMs?: number }).timeoutMs;

    const cfg = loadConfig();
    const configOverride =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? {
            ...cfg.tools?.media?.audio,
            timeoutSeconds: Math.max(1, Math.floor(timeoutMs / 1000)),
          }
        : undefined;

    const tmpPath = path.join(os.tmpdir(), `openclaw-talk-stt-${crypto.randomUUID()}.wav`);
    await fs.writeFile(tmpPath, decoded);

    const ctx: MsgContext = {
      Provider: "gateway",
      Surface: "gateway",
      ChatType: "direct",
      SessionKey: sessionKey,
      Body: "<media:audio>",
      MediaPath: tmpPath,
      MediaType: mime,
    };

    const attachments = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(attachments);

    try {
      const { outputs, decision } = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media: attachments,
        providerRegistry: buildProviderRegistry(),
        config: configOverride,
      });

      const transcript = outputs.find((item) => item.kind === "audio.transcription")?.text?.trim();
      if (!transcript) {
        if (isNoSpeechDecision(decision)) {
          respond(
            true,
            {
              text: null,
              noSpeech: true,
              decision,
              provider: null,
              model: null,
              language: language ?? null,
            },
            undefined,
          );
          return;
        }
        respond(
          false,
          { decision },
          errorShape(ErrorCodes.UNAVAILABLE, "audio transcription unavailable"),
        );
        return;
      }
      respond(
        true,
        {
          text: transcript,
          noSpeech: false,
          decision,
          provider: outputs[0]?.provider ?? null,
          model: outputs[0]?.model ?? null,
          language: language ?? null,
        },
        undefined,
      );
    } finally {
      await cache.cleanup().catch(() => {});
      await fs.unlink(tmpPath).catch(() => {});
    }
  },
};
