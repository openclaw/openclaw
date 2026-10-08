import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { testing as embeddedRunTesting } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../../test-utils/session-state-cleanup.js";
import { deletePersistentSessionStoreRows } from "../../test/persistent-session-store.test-support.js";
import { drainRelayTestSessions } from "./index.test-support.js";

export function usePersistentRelayTestState(activeRelaySessions: Map<string, string>) {
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      label: "talk-realtime-relay",
      scenario: "minimal",
    });
  });

  afterAll(async () => {
    await testState?.cleanup();
  });

  beforeEach(async () => {
    testState.applyEnv();
    // The RPC owner creates this row before starting a relay. Explicit missing-key
    // tests keep their own target and isolated state instead of inheriting this row.
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  });

  async function stopTrackedRelaySessions() {
    try {
      await drainRelayTestSessions(activeRelaySessions);
    } finally {
      activeRelaySessions.clear();
    }
  }

  async function cleanupIsolatedRelayState(tempDir: string) {
    await stopTrackedRelaySessions();
    vi.useRealTimers();
    await cleanupSessionStateForTest({ stateDir: tempDir, rootPath: tempDir });
  }

  afterEach(async () => {
    try {
      await stopTrackedRelaySessions();
    } finally {
      vi.useRealTimers();
      clientVoiceSessionTesting.reset();
      resetClientVoiceConfirmationStateForTest();
      embeddedRunTesting.resetActiveEmbeddedRuns();
      await drainSessionStateForTest({ stateDir: testState.stateDir, rootPath: testState.root });
      await deletePersistentSessionStoreRows({
        agentId: "main",
        storePath: path.join(testState.sessionsDir(), "sessions.json"),
      });
      await drainSessionStateForTest({ stateDir: testState.stateDir, rootPath: testState.root });
    }
  });

  return { cleanupIsolatedRelayState };
}
