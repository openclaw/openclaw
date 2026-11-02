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

type ToolResult = { details?: unknown };

const PLUGIN_ID = "qa-music-controls";
function detailsOf(result: ToolResult): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected music_generate result details");
  }
  return result.details as Record<string, unknown>;
}

function createMusicFixture() {
  const calls: MusicGenerationRequest[] = [];
  const provider: MusicGenerationProvider = {
    id: "qa-music",
    capabilities: {},
    isConfigured: () => true,
    generateMusic: async (request) => {
      calls.push(request);
      return {
        tracks: [
          { buffer: Buffer.from("ID3-qa-audio"), mimeType: "audio/mpeg", fileName: "song.mp3" },
        ],
        model: request.model,
      };
    },
  };
  const config: OpenClawConfig = {
    plugins: {
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    },
    agents: { defaults: { mediaModels: { music: { primary: "qa-music/song-v1" } } } },
  };
  const registry = createEmptyPluginRegistry();
  registry.musicGenerationProviders.push({
    pluginId: PLUGIN_ID,
    pluginName: "QA music controls",
    source: "test",
    provider,
  });
  const manifest = createPluginManifestRecordFixture({
    id: PLUGIN_ID,
    rootDir: `/fake/${PLUGIN_ID}`,
    contracts: { musicGenerationProviders: [provider.id] },
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

  it("invokes the prepared provider and persists audio", async () => {
    const fixture = createMusicFixture();
    const stateDir = tempDirs.make("openclaw-qa-music-controls-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const result = await fixture.execute({ prompt: "bright QA chorus" });
      expect(fixture.calls).toMatchObject([{ model: "song-v1", prompt: "bright QA chorus" }]);
      const details = detailsOf(result);
      expect(details).toMatchObject({
        provider: "qa-music",
        model: "song-v1",
        count: 1,
      });
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
