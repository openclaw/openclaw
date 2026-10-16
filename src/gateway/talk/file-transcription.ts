import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { RealtimeTranscriptionSessionCallbacks } from "../../realtime-transcription/provider-types.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { mulawToPcm } from "../../talk/audio-codec.js";

export type TalkFileTranscriptionConfig = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  maxBytes: number;
  ready: boolean;
  provider?: string;
  providers: Array<{ id: string; models: string[]; configured: boolean }>;
};

/** Explicit file models use the same selection and input budget as uploaded voice notes. */
export async function resolveTalkFileTranscriptionConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<TalkFileTranscriptionConfig | undefined> {
  if (!cfg.tools?.media?.models?.length || cfg.tools.media.audio?.enabled === false) {
    return undefined;
  }
  const [
    { buildMediaUnderstandingRegistry, normalizeMediaProviderId },
    { resolveModelEntries, resolveMaxBytes },
  ] = await Promise.all([
    import("../../media-understanding/provider-registry.js"),
    import("../../media-understanding/resolve.js"),
  ]);
  const registry = buildMediaUnderstandingRegistry(undefined, cfg);
  const entries = resolveModelEntries({
    cfg,
    capability: "audio",
    config: cfg.tools.media.audio,
    providerRegistry: registry,
  });
  if (entries.length === 0) {
    return undefined;
  }
  const resolvedAgentId = agentId ?? resolveTalkSessionAgentId(cfg);
  const scope = {
    agentId: resolvedAgentId,
    agentDir: resolveAgentDir(cfg, resolvedAgentId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, resolvedAgentId),
  };
  const { isAudioModelEntryAvailable } =
    await import("../../media-understanding/provider-execution.js");
  const providers = new Map<string, { models: string[]; configured: boolean }>();
  const providerId = (id: string) => registry.get(normalizeMediaProviderId(id))?.id ?? id;
  let ready = false;
  let maxBytes = 0;
  let selectedProvider: string | undefined;
  for (const { entry, secretOwnerId } of entries) {
    maxBytes = Math.max(
      maxBytes,
      resolveMaxBytes({ cfg, capability: "audio", config: cfg.tools.media.audio, entry }),
    );
    const configured = await isAudioModelEntryAvailable({
      cfg,
      ...scope,
      entry,
      secretOwnerId,
      providerRegistry: registry,
    });
    if (configured && !ready) {
      selectedProvider = entry.provider ? providerId(entry.provider) : undefined;
    }
    ready ||= configured;
    if (!entry.provider) {
      continue;
    }
    const id = providerId(entry.provider);
    const state = providers.get(id) ?? { models: [], configured: false };
    state.configured ||= configured;
    if (entry.model && !state.models.includes(entry.model)) {
      state.models.push(entry.model);
    }
    providers.set(id, state);
  }
  return {
    cfg,
    ...scope,
    maxBytes,
    ready,
    provider: selectedProvider,
    providers: Array.from(providers, ([id, state]) => ({ id, ...state })),
  };
}

function encodeWav(audio: Buffer): Buffer {
  const pcm = mulawToPcm(audio);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Adapts the browser's existing audio frames to the file-transcription owner. */
export function createTalkFileTranscriptionSession(
  config: TalkFileTranscriptionConfig,
  callbacks: RealtimeTranscriptionSessionCallbacks,
  assertCurrent: () => void,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const cancellation = new AbortController();
  return {
    connect: () => Promise.resolve(),
    sendAudio(audio: Buffer) {
      if (cancellation.signal.aborted) {
        throw new Error("Transcription session is closed");
      }
      if ((bytes + audio.length) * 2 + 44 > config.maxBytes) {
        throw new Error(`Transcription audio exceeds the configured ${config.maxBytes} byte limit`);
      }
      chunks.push(audio);
      bytes += audio.length;
    },
    close() {
      cancellation.abort();
      chunks.length = 0;
      bytes = 0;
    },
    async finish() {
      if (cancellation.signal.aborted || bytes === 0) {
        return;
      }
      const audio = Buffer.concat(chunks, bytes);
      chunks.length = 0;
      bytes = 0;
      const root = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(root, "talk-stt-"));
      try {
        const filePath = path.join(directory, "speech.wav");
        await fs.writeFile(filePath, encodeWav(audio), { mode: 0o600 });
        const { transcribeAudioFile } = await import("../../media-understanding/runtime.js");
        if (cancellation.signal.aborted) {
          return;
        }
        assertCurrent();
        const result = await transcribeAudioFile(
          {
            cfg: config.cfg,
            agentId: config.agentId,
            agentDir: config.agentDir,
            workspaceDir: config.workspaceDir,
            filePath,
            mime: "audio/wav",
          },
          { signal: cancellation.signal, assertCurrent },
        );
        if (!cancellation.signal.aborted) {
          assertCurrent();
          callbacks.onTranscript?.(result.text ?? "");
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  };
}
