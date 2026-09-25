import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../../gateway/connection-details.js";
import { isLoopbackHost } from "../../gateway/net.js";
import {
  designSpeechVoice,
  getTtsProvider,
  replicateSpeechVoice,
  resolveTtsConfig,
  resolveTtsPrefsPath,
} from "../../tts/tts.js";
import { getTtsCommandSecretTargetIds } from "../command-secret-targets.js";
import { publishOutputFileAtomically } from "../media-output.js";
import type { CapabilityTransport } from "./metadata.js";
import { resolveLocalCapabilityRuntimeConfig } from "./shared.js";

async function writePreviewAudio(target: string, audio: Buffer): Promise<void> {
  await publishOutputFileAtomically({
    filePath: target,
    writeTemp: async (tempPath) => {
      await fs.writeFile(tempPath, audio);
    },
  });
}

function mimeTypeFromAudioPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") {
    return "audio/mpeg";
  }
  if (ext === ".ogg" || ext === ".oga") {
    return "audio/ogg";
  }
  if (ext === ".m4a" || ext === ".mp4") {
    return "audio/mp4";
  }
  if (ext === ".webm") {
    return "audio/webm";
  }
  return "audio/wav";
}

export async function runTtsDesignVoice(params: {
  provider?: string;
  displayName: string;
  prompt: string;
  languageCode?: string;
  gender?: string;
  model?: string;
  output: string;
  transport: CapabilityTransport;
}) {
  const target = path.resolve(params.output);
  if (params.transport === "gateway") {
    const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
      config: getRuntimeConfig(),
    });
    if (!isLoopbackHost(new URL(gatewayConnection.url).hostname)) {
      throw new Error(
        `--output is not supported for remote gateway voice design yet (gateway target: ${gatewayConnection.url}).`,
      );
    }
    const result: {
      provider?: string;
      id?: string;
      name?: string;
      mimeType?: string;
      audioBase64?: string;
    } = await callGateway({
      method: "tts.designVoice",
      params: {
        provider: normalizeOptionalString(params.provider),
        displayName: params.displayName,
        prompt: params.prompt,
        languageCode: params.languageCode,
        gender: params.gender,
        modelId: params.model,
      },
      timeoutMs: 120_000,
    });
    const audio = Buffer.from(result.audioBase64 ?? "", "base64");
    if (!result.id || audio.length === 0) {
      throw new Error("Gateway voice design did not return a voice id and preview");
    }
    await writePreviewAudio(target, audio);
    return {
      ok: true,
      capability: "tts.designVoice",
      transport: "gateway" as const,
      provider: result.provider,
      id: result.id,
      name: result.name,
      outputs: [{ path: target, format: result.mimeType ?? "audio/wav" }],
    };
  }
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts design",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const config = resolveTtsConfig(cfg);
  const provider =
    normalizeOptionalString(params.provider) ?? getTtsProvider(config, resolveTtsPrefsPath(config));
  const designed = await designSpeechVoice({
    cfg,
    provider,
    displayName: params.displayName,
    prompt: params.prompt,
    languageCode: params.languageCode,
    gender: params.gender,
    model: params.model,
  });
  await writePreviewAudio(target, designed.previewAudio);
  return {
    ok: true,
    capability: "tts.designVoice",
    transport: "local" as const,
    provider,
    id: designed.id,
    name: designed.name,
    outputs: [{ path: target, format: designed.mimeType }],
  };
}

export async function runTtsReplicateVoice(params: {
  provider?: string;
  displayName: string;
  source: string;
  consent: string;
  model?: string;
  output: string;
  transport: CapabilityTransport;
}) {
  const target = path.resolve(params.output);
  const sourcePath = path.resolve(params.source);
  const consentPath = path.resolve(params.consent);
  const sourceAudio = await fs.readFile(sourcePath);
  const consentAudio = await fs.readFile(consentPath);
  const sourceMimeType = mimeTypeFromAudioPath(sourcePath);
  const consentMimeType = mimeTypeFromAudioPath(consentPath);
  if (params.transport === "gateway") {
    const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
      config: getRuntimeConfig(),
    });
    if (!isLoopbackHost(new URL(gatewayConnection.url).hostname)) {
      throw new Error(
        `--output is not supported for remote gateway voice replication yet (gateway target: ${gatewayConnection.url}).`,
      );
    }
    const result: {
      provider?: string;
      id?: string;
      name?: string;
      mimeType?: string;
      audioBase64?: string;
    } = await callGateway({
      method: "tts.replicateVoice",
      params: {
        provider: normalizeOptionalString(params.provider),
        displayName: params.displayName,
        sourceAudioBase64: sourceAudio.toString("base64"),
        consentAudioBase64: consentAudio.toString("base64"),
        sourceMimeType,
        consentMimeType,
        modelId: params.model,
      },
      timeoutMs: 120_000,
    });
    const audio = Buffer.from(result.audioBase64 ?? "", "base64");
    if (!result.id || audio.length === 0) {
      throw new Error("Gateway voice replication did not return a voice id and preview");
    }
    await writePreviewAudio(target, audio);
    return {
      ok: true,
      capability: "tts.replicateVoice",
      transport: "gateway" as const,
      provider: result.provider,
      id: result.id,
      name: result.name,
      outputs: [{ path: target, format: result.mimeType ?? "audio/wav" }],
    };
  }
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts replicate",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const config = resolveTtsConfig(cfg);
  const provider =
    normalizeOptionalString(params.provider) ?? getTtsProvider(config, resolveTtsPrefsPath(config));
  const replicated = await replicateSpeechVoice({
    cfg,
    provider,
    displayName: params.displayName,
    sourceAudio,
    consentAudio,
    sourceMimeType,
    consentMimeType,
    model: params.model,
  });
  await writePreviewAudio(target, replicated.previewAudio);
  return {
    ok: true,
    capability: "tts.replicateVoice",
    transport: "local" as const,
    provider,
    id: replicated.id,
    name: replicated.name,
    outputs: [{ path: target, format: replicated.mimeType }],
  };
}
