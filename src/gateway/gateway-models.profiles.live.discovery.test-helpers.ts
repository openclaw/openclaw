import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { buildPortableAuthProfileStoreForAgentCopy } from "../agents/auth-profiles/portability.js";
import { listProfilesForProvider } from "../agents/auth-profiles/profile-list.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

export async function enterIsolatedGatewayLiveDiscoveryState(params: {
  config: OpenClawConfig;
  providers?: Iterable<string>;
  logProgress: (message: string) => void;
}): Promise<() => Promise<void>> {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const source = ensureAuthProfileStoreWithoutExternalProfiles(
    resolveDefaultAgentDir(params.config),
    {
      allowKeychainPrompt: false,
      readOnly: true,
      syncExternalCli: false,
    },
  );
  const selected = params.providers
    ? new Set(
        [...params.providers].flatMap((provider) => listProfilesForProvider(source, provider)),
      )
    : undefined;
  const portable = buildPortableAuthProfileStoreForAgentCopy({
    ...source,
    profiles: Object.fromEntries(
      Object.entries(source.profiles).filter(([id]) => !selected || selected.has(id)),
    ),
  });
  if (portable.skippedProfileIds.length > 0) {
    params.logProgress(
      `[all-models] isolated discovery omitted ${portable.skippedProfileIds.length} non-portable auth profile(s)`,
    );
  }
  // openclaw-temp-dir: allow discovery owns the directory through asynchronous database cleanup
  const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-discovery-state-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
  const cleanup = async () => {
    try {
      await cleanupSessionStateForTest({ stateDir: tempStateDir });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
    await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  try {
    // Discovery may materialize env credentials; copy selected portable profiles
    // first so it never writes the ambient store or duplicates native OAuth owners.
    saveAuthProfileStore(portable.store, resolveDefaultAgentDir({}), { syncExternalCli: false });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}
