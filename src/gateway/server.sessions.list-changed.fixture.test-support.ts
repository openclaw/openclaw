import fs from "node:fs/promises";
import path from "node:path";
import { afterEach } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RpcSourceAdapter } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createActiveRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import { testState } from "./test-helpers.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";
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
    rpcSourceTesting.reset();
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

export async function registerSessionListRpcSourceForTest(
  run: Partial<RpcSourceAdapter> & { executionStarted?: boolean; projectSessionActive?: boolean },
) {
  const { executionStarted, ...metadata } = run;
  const identity = {
    runId: "run-1",
    sessionKey: "agent:main:main",
    sessionId: "sess-main",
    agentId: "main",
    storeScope: testState.sessionStorePath,
  };
  const source =
    executionStarted || metadata.projectSessionActive === false
      ? await createActiveRpcSourceForTest(metadata, identity)
      : createRpcSourceForTest(metadata, identity);
  // Unaccepted preparation reserves custody without publishing a queued RPC source.
  if (executionStarted !== false) {
    rpcSourceTesting.set("run-1", source);
  }
}
