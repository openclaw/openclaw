// Thread-binding artifact parity contract for bundled channel plugins.
//
// Core resolves default thread placement from lightweight `thread-binding-api`
// artifacts before full plugin loading (src/channels/plugins/thread-binding-api.ts).
// This suite pins artifact exports to the runtime plugin's conversationBindings
// so the fast path cannot drift from loaded-plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";
import { loadBundledPluginPublicSurface } from "../../../test-utils/bundled-plugin-public-surface.js";
import {
  getBundledChannelPluginAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

// Bundled channels expected to ship a top-level thread-binding artifact.
const THREAD_BINDING_ARTIFACT_PLUGIN_IDS = ["discord", "matrix"] as const;

const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";

type ThreadBindingArtifactModule = { defaultTopLevelPlacement?: unknown };

async function loadThreadBindingArtifact(
  pluginId: string,
): Promise<ThreadBindingArtifactModule | null> {
  try {
    return await loadBundledPluginPublicSurface<ThreadBindingArtifactModule>({
      pluginId,
      artifactBasename: "thread-binding-api.js",
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
      return null;
    }
    throw error;
  }
}

describe("bundled channel thread-binding artifact parity", () => {
  const artifactPlacements = new Map<string, unknown>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await loadThreadBindingArtifact(id);
      if (artifact) {
        artifactPlacements.set(id, artifact.defaultTopLevelPlacement);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    expect([...artifactPlacements.keys()].toSorted()).toEqual([
      ...THREAD_BINDING_ARTIFACT_PLUGIN_IDS,
    ]);
  });

  it.each(THREAD_BINDING_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s artifact placement equal to the runtime plugin default",
    async (id) => {
      const artifactPlacement = artifactPlacements.get(id);
      expect(["current", "child"]).toContain(artifactPlacement);

      const plugin = await getBundledChannelPluginAsync(id);
      expect(plugin?.conversationBindings?.defaultTopLevelPlacement).toBe(artifactPlacement);
    },
  );
});
