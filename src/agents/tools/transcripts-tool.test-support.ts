import path from "node:path";
import { afterEach, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { clearTranscriptCapturesForTest } from "../../transcripts/capture.test-support.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";

export function useTranscriptTestState() {
  const dirs = createTempDirTracker();
  afterEach(async () => {
    await clearTranscriptCapturesForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    dirs.cleanup();
  });
  return () => {
    const stateDir = dirs.make("openclaw-transcripts-");
    return {
      stateDir,
      store: new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    };
  };
}

export function registerTranscriptTestProvider(
  provider: TranscriptSourceProvider,
  pluginId = provider.id,
) {
  const registry = createEmptyPluginRegistry();
  registry.transcriptSourceProviders.push({ pluginId, provider, source: import.meta.url });
  setActivePluginRegistry(registry);
}
