import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { maybeApplyTtsToPayload } from "../../../../packages/speech-core/src/tts.ts";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "../../../../src/gateway/server-methods/chat-webchat-media.ts";
import { createPluginRecord } from "../../../../src/plugins/loader-records.ts";
import { createPluginRegistry } from "../../../../src/plugins/registry.ts";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function installMockTtsProvider() {
  const registry = createPluginRegistry({
    logger: noopLogger,
    runtime: {},
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "qa-webchat-auto-tts",
    name: "QA WebChat Auto TTS",
    source: "test/e2e/qa-lab/media/webchat-auto-tts.e2e.test.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const synthesizeCalls: string[] = [];

  registry.registerSpeechProvider(record, {
    id: "mock",
    label: "Mock",
    autoSelectOrder: 1,
    isConfigured: () => true,
    synthesize: async (request) => {
      synthesizeCalls.push(request.text);
      return {
        audioBuffer: Buffer.from("voice"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: request.target === "voice-note",
      };
    },
  });
  setActivePluginRegistry(registry.registry);
  return synthesizeCalls;
}

describe("QA WebChat auto TTS", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("synthesizes only the final WebChat tail and exposes trusted local audio", async () => {
    resetPluginRuntimeStateForTest();
    const synthesizeCalls = installMockTtsProvider();
    const prefsPath = path.join(os.tmpdir(), `openclaw-webchat-tts-${process.pid}.json`);
    let mediaPath: string | undefined;

    try {
      const text = "WebChat streams block text; dispatch synthesizes one TTS tail with kind final.";
      const cfg = {
        messages: {
          tts: {
            enabled: true,
            provider: "mock",
            prefsPath,
          },
        },
      } satisfies OpenClawConfig;

      const blockResult = await maybeApplyTtsToPayload({
        payload: { text },
        cfg,
        channel: "webchat",
        kind: "block",
      });
      expect(blockResult.mediaUrl).toBeUndefined();
      expect(blockResult.text).toBe(text);
      expect(synthesizeCalls).toEqual([]);

      const tailResult = await maybeApplyTtsToPayload({
        payload: { text },
        cfg,
        channel: "webchat",
        kind: "final",
      });
      mediaPath = tailResult.mediaUrl;

      expect(synthesizeCalls).toEqual([text]);
      expect(mediaPath).toMatch(/voice-\d+\.ogg$/);
      if (!mediaPath || !fs.existsSync(mediaPath)) {
        throw new Error("expected final WebChat TTS to write local audio");
      }
      expect(tailResult).toMatchObject({
        spokenText: text,
        trustedLocalMedia: true,
      });

      const trustedBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
        [
          {
            mediaUrl: mediaPath,
            audioAsVoice: tailResult.audioAsVoice,
            spokenText: text,
            trustedLocalMedia: true,
          },
        ],
        { localRoots: [path.dirname(mediaPath)] },
      );
      const untrustedBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
        [{ mediaUrl: mediaPath }],
        { localRoots: [path.dirname(mediaPath)] },
      );

      expect(trustedBlocks).toHaveLength(1);
      expect(trustedBlocks[0]).toMatchObject({
        type: "attachment",
        attachment: {
          kind: "audio",
          label: path.basename(mediaPath),
          mimeType: "audio/ogg",
          url: fs.realpathSync(mediaPath),
        },
      });
      expect(untrustedBlocks).toHaveLength(0);
    } finally {
      if (mediaPath) {
        fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
      }
      fs.rmSync(prefsPath, { force: true });
    }
  });
});
