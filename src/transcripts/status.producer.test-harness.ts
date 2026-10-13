import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { selectCurrentPluginMetadataCache } from "../plugins/current-plugin-metadata-state.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import {
  createPluginCache,
  getProcessPluginCache,
  retirePluginCache,
} from "../plugins/plugin-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { startTranscripts } from "./capture.js";
import { clearTranscriptCapturesForTest } from "./capture.test-support.js";
import type { TranscriptSourceProvider } from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import { TranscriptsStore } from "./store.js";

export const transcriptStatusRoom = {
  providerId: "fixture-voice",
  accountId: "work",
  guildId: "guild",
  channelId: "room",
};

export function useTranscriptStatusFixture() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let previousRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let previousCache: ReturnType<typeof getProcessPluginCache>;
  let cache: ReturnType<typeof createPluginCache>;
  beforeEach(() => {
    previousRegistry = captureActivePluginRegistrySnapshot();
    previousCache = getProcessPluginCache();
    cache = createPluginCache({ kind: "process" });
    selectCurrentPluginMetadataCache(cache);
  });
  afterEach(async () => {
    await clearTranscriptCapturesForTest();
    resetConfigRuntimeState();
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    restoreActivePluginRegistrySnapshot(previousRegistry);
    selectCurrentPluginMetadataCache(previousCache);
    await retirePluginCache(cache);
    vi.restoreAllMocks();
  });

  return function fixture(
    config: OpenClawConfig = { transcripts: { autoStart: [transcriptStatusRoom] } },
  ) {
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({ config, manifestRegistry: { plugins: [], diagnostics: [] } }),
      { config },
    );
    const stateDir = tempDirs.make("transcript-status-producer-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const provider: TranscriptSourceProvider = {
      id: transcriptStatusRoom.providerId,
      aliases: ["voice-alias"],
      name: "Fixture voice",
      sourceKinds: ["live-audio"],
      accessControl: {
        channelId: "discord",
        resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId ?? "default" }),
        authorize: async ({ caller }) =>
          caller.kind === "operator"
            ? { ok: true, value: undefined }
            : { ok: false, error: "operator required" },
      },
      start: async ({ session }) => ({ ok: true, session }),
      stop: async ({ sessionId }) => ({ ok: true, sessionId }),
    };
    const registry = createEmptyPluginRegistry();
    const setProviders = (providers: readonly TranscriptSourceProvider[]) => {
      registry.transcriptSourceProviders = providers.map((sourceProvider) => ({
        pluginId: "fixture",
        source: "fixture",
        provider: sourceProvider,
      }));
    };
    setProviders([provider]);
    setActivePluginRegistry(registry);
    const ctx = { config, stateDir, agentId: "main", logger: { warn: vi.fn() } };
    const tool = createTranscriptsTool({ ...ctx, caller: { kind: "operator", source: "local" } });
    return {
      ctx,
      store,
      provider,
      setProviders,
      tool,
      read: () => readTranscriptLibraryStatus(store, config),
      start: (rawParams: Record<string, unknown>, configuredLifecycle?: true) =>
        startTranscripts({
          ctx: { ...ctx, caller: { kind: "operator", source: "local" } },
          store,
          rawParams,
          configuredLifecycle,
        }),
    };
  };
}
