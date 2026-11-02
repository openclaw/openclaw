import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSessionStoreTopologyChange, sessionChanges } from "../sessions/session-row-changes.js";
import type { OpenClawAgentDatabaseRegistrationCommit } from "./openclaw-agent-db-contract.js";
import * as registryListing from "./openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
} from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

export function useRegistrationFixture(beforeCleanup = () => {}) {
  const subscriptions = new Set<() => void>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      beforeCleanup();
      for (const stop of subscriptions) {
        stop();
      }
      subscriptions.clear();
      vi.restoreAllMocks();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  function createFixture(
    env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-registration-commit-") },
  ) {
    const shared = openOpenClawStateDatabase({ env });
    const options = { agentId: "registration-commit", env };
    const target = { ...options, path: resolveOpenClawAgentSqlitePath(options) };
    const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
    const receipt: OpenClawAgentDatabaseRegistrationCommit = {
      agentId: target.agentId,
      agentPath: target.path,
      stateDatabasePath: shared.path,
      stateDatabaseIdentity: admission.identity.key,
    };
    const registrations = () => registryListing.readRegisteredAgentDatabases({ env }, false);
    const capture = (
      overrides: Partial<
        Parameters<typeof registryListing.captureOpenClawAgentDatabaseRegistration>[0]
      > = {},
    ) =>
      registryListing.captureOpenClawAgentDatabaseRegistration({
        agentId: target.agentId,
        agentPath: target.path,
        admission,
        ...overrides,
      });
    const entries = [expect.objectContaining({ agentId: target.agentId, path: target.path })];
    return { env, shared, target, admission, receipt, registrations, capture, entries };
  }
  function observeStores(database: ReturnType<typeof openOpenClawStateDatabase>) {
    const trace: Array<{ kind: "commit" | "stores"; inTransaction: boolean }> = [];
    const facts: boolean[] = [];
    subscriptions.add(
      sessionChanges.subscribeFacts((change) => {
        if (isSessionStoreTopologyChange(change)) {
          facts.push(registryListing.isOpenClawAgentDatabaseRegistryChange(change));
        }
      }),
    );
    const stop = sessionChanges.subscribe((change) => {
      if (isSessionStoreTopologyChange(change)) {
        trace.push({ kind: "stores", inTransaction: database.db.isTransaction });
      }
    });
    subscriptions.add(stop);
    return { trace, stop, facts };
  }
  return { createFixture, observeStores };
}
