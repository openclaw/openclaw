import fs from "node:fs/promises";
import path from "node:path";
import { afterEach } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { testState } from "./test-helpers.js";
import { resetPersistentGatewaySessionStore } from "./test/persistent-session-store.test-support.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
} from "./test/server-sessions.test-helpers.js";

export function setupPersistentSessionListTestHarness() {
  let dir: string;
  let used = false;
  const fixture = setupGatewaySessionsTestHarness(async (makeTempDir) => {
    dir = await fs.realpath(makeTempDir("openclaw-sessions-list-persistent-"));
  });
  afterEach(async () => {
    if (used) {
      await resetPersistentGatewaySessionStore(dir);
      used = false;
    }
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  return {
    ...fixture,
    createFreshSessionStoreDir: fixture.createSessionStoreDir,
    createSessionStoreDir: async () => {
      const storePath = path.join(dir, "sessions.json");
      used = true;
      testState.sessionStorePath = storePath;
      (await getGatewayConfigModule()).clearRuntimeConfigSnapshot();
      return { dir, storePath };
    },
  };
}
