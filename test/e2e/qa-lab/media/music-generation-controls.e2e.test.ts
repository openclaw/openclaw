import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawTools } from "../../../../src/agents/openclaw-tools.js";
import type { PreparedModelRuntimeSnapshot } from "../../../../src/agents/prepared-model-runtime.js";
import { createPluginMetadataSnapshot } from "../../../../src/config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "../../../../src/music-generation/types.js";
import { prepareMediaCapabilityProviders } from "../../../../src/plugins/capability-provider-runtime.js";
import { createPluginManifestRecordFixture } from "../../../../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; details?: unknown };
type ProviderCall = { provider: string; request: MusicGenerationRequest };

const PLUGIN_ID = "qa-music-controls";
const VOCAL_CONTROLS = {
  lyrics: "OpenClaw keeps the signal clear",
  instrumental: false,
  durationSeconds: 45,
  format: "wav",
};
const INSTRUMENTAL_CONTROLS = { instrumental: true, durationSeconds: 12, format: "mp3" };

function detailsOf(result: ToolResult): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected music_generate result details");
  }
  return result.details as Record<string, unknown>;
}

function textOf(result: ToolResult): string {
  return result.content?.find((entry) => entry.type === "text")?.text ?? "";
}

function createMusicFixture() {
  const calls: ProviderCall[] = [];
  const primary: MusicGenerationProvider = {
    id: "qa-primary",
    label: "QA primary music",
    defaultModel: "song-v1",
    models: ["song-v1"],
    capabilities: {
      generate: {
        maxDurationSeconds: 60,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
    },
    isConfigured: () => true,
    generateMusic: async (request) => {
      calls.push({ provider: "qa-primary", request });
      throw new Error("intentional primary provider outage");
    },
  };
  const fallback: MusicGenerationProvider = {
    ...primary,
    id: "qa-fallback",
    label: "QA fallback music",
    defaultModel: "beat-v2",
    models: ["beat-v2"],
    capabilities: {
      generate: {
        ...primary.capabilities.generate,
        maxDurationSeconds: 30,
        supportsLyrics: false,
        supportedFormats: ["mp3"],
      },
    },
    generateMusic: async (request) => {
      calls.push({ provider: "qa-fallback", request });
      const kind = request.instrumental ? "instrumental" : "vocal-fallback";
      const fileName = `${kind}.mp3`;
      return {
        tracks: [{ buffer: Buffer.from(`ID3-qa-${kind}-audio`), mimeType: "audio/mpeg", fileName }],
        model: request.model,
      };
    },
  };
  const music = { primary: "qa-primary/song-v1", fallbacks: ["qa-fallback/beat-v2"] };
  const config: OpenClawConfig = {
    plugins: {
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    },
    agents: { defaults: { mediaModels: { music } } },
  };
  const registry = createEmptyPluginRegistry();
  for (const provider of [primary, fallback]) {
    registry.musicGenerationProviders.push({
      pluginId: PLUGIN_ID,
      pluginName: "QA music controls",
      source: "test",
      provider,
    });
  }
  const manifest = createPluginManifestRecordFixture({
    id: PLUGIN_ID,
    rootDir: `/fake/${PLUGIN_ID}`,
    contracts: { musicGenerationProviders: [primary.id, fallback.id] },
  });
  const pluginMetadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [manifest], diagnostics: [] },
  });
  const mediaCapabilityProviders = prepareMediaCapabilityProviders({
    cfg: config,
    pluginMetadataSnapshot,
    registry,
  });
  const preparedModelRuntime = {
    metadataSnapshot: pluginMetadataSnapshot,
    mediaCapabilityProviders,
  } as unknown as PreparedModelRuntimeSnapshot;
  const musicTools = createOpenClawTools({
    config,
    preparedModelRuntime,
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
  }).filter((candidate) => candidate.name === "music_generate");
  expect(musicTools).toHaveLength(1);
  const [tool] = musicTools;
  if (!tool) {
    throw new Error("missing prepared music_generate tool");
  }
  const execute = (args: Record<string, unknown>) => tool.execute("qa-music-controls", args);
  return { calls, execute };
}

describe("music generation controls QA product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("normalizes fallback and explicit controls and persists audio", async () => {
    const fixture = createMusicFixture();
    for (const { explicit, controls } of [
      { explicit: false, controls: VOCAL_CONTROLS },
      { explicit: true, controls: INSTRUMENTAL_CONTROLS },
    ]) {
      const stateDir = tempDirs.make("openclaw-qa-music-controls-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const result = await fixture.execute({
          prompt: "bright QA chorus",
          ...controls,
          ...(explicit ? { model: "qa-fallback/beat-v2" } : {}),
        });
        const normalized = explicit ? controls : { instrumental: false, durationSeconds: 30 };
        const fallbackCall = {
          provider: "qa-fallback",
          request: { model: "beat-v2", ...normalized },
        };
        expect(fixture.calls.slice(explicit ? 2 : 0)).toMatchObject(
          explicit
            ? [fallbackCall]
            : [
                {
                  provider: "qa-primary",
                  request: { model: "song-v1", ...VOCAL_CONTROLS },
                },
                fallbackCall,
              ],
        );
        const details = detailsOf(result);
        expect(details).toMatchObject({
          provider: "qa-fallback",
          model: "beat-v2",
          ...normalized,
          ...(explicit
            ? { attempts: [] }
            : {
                count: 1,
                requestedDurationSeconds: 45,
              }),
        });
        if (!explicit) {
          expect([fixture.calls[1]?.request.lyrics, fixture.calls[1]?.request.format]).toEqual([
            undefined,
            undefined,
          ]);
          expect(details).not.toHaveProperty("requestedLyrics");
          expect(details).not.toHaveProperty("format");
          expect(textOf(result)).toContain(
            "Warning: Ignored unsupported overrides for qa-fallback/beat-v2: lyrics=OpenClaw keeps the signal clear, format=wav.",
          );
          expect(textOf(result)).toContain("Duration normalized: requested 45s; used 30s.");
        }
        const persisted = details.paths as string[];
        expect(persisted).toHaveLength(1);
        for (const filePath of persisted) {
          const canonicalPath = await fs.realpath(filePath);
          expect(
            canonicalPath.startsWith(path.join(stateDir, "media", "tool-music-generation")),
          ).toBe(true);
          expect((await fs.readFile(canonicalPath)).byteLength).toBeGreaterThan(0);
        }
      });
    }
  });

  it("rejects invalid output formats before invoking a prepared provider", async () => {
    const fixture = createMusicFixture();

    await expect(
      fixture.execute({
        prompt: "QA invalid format proof",
        format: "flac",
      }),
    ).rejects.toThrow('format must be one of "mp3" or "wav"');
    expect(fixture.calls).toEqual([]);
  });
});
