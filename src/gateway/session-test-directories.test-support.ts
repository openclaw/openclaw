import fs from "node:fs/promises";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { isPathInside } from "../infra/path-guards.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  listOpenClawRegisteredAgentDatabases,
} from "../state/openclaw-agent-db.js";
import { testState } from "./test-helpers.runtime-state.js";

export async function releaseSessionTestDirectories(roots: readonly string[]) {
  const canonicalRoots = await Promise.all(roots.map((root) => fs.realpath(root)));
  const owns = (pathname: string) =>
    [...roots, ...canonicalRoots].some((root) => isPathInside(root, pathname));
  if (testState.sessionStorePath && owns(testState.sessionStorePath)) {
    testState.sessionStorePath = undefined;
  }
  const config = getRuntimeConfig();
  if (config.session?.store && owns(config.session.store)) {
    const { store: _store, ...session } = config.session;
    setRuntimeConfigSnapshot({ ...config, session });
  }
  for (const database of listOpenClawRegisteredAgentDatabases()) {
    if (canonicalRoots.some((root) => isPathInside(root, database.path))) {
      unregisterOpenClawAgentDatabase(database);
    }
  }
  for (const root of canonicalRoots) {
    await closeOpenClawAgentDatabasesAsync(root);
  }
}

export async function removeSessionTestDirectories(roots: readonly string[]) {
  await releaseSessionTestDirectories(roots);
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export async function removeChatTestDirectory(dir: string): Promise<void> {
  await releaseSessionTestDirectories([dir]);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
