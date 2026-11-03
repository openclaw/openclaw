import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  matchesAgentLifecycleBinding,
} from "../agents/agent-lifecycle-registry.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveAgentConfig, listAgentIds } from "../agents/agent-scope.js";
import {
  createGitHubOAuthRecord,
  deleteGitHubDeviceAuthorizationRecord,
  deleteGitHubOAuthRecord,
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
  listGitHubAuthorizationRecords,
} from "../agents/github-oauth-records.js";
import {
  deleteGitHubDeviceAuthorizationRecordNative,
  deleteGitHubOAuthRecordNative,
  readGitHubDeviceAuthorizationRecordNative,
} from "../agents/github-oauth-records.native.js";
import { registerRuntimeConfigWriteListener } from "../config/runtime-snapshot.js";
import { subscribeSecretStoreChanges } from "../secrets/store/secret-store-changes.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
type GitHubOAuthInventory = Awaited<ReturnType<typeof listGitHubAuthorizationRecords>>;

function createGitHubOAuthInventoryReader(onChange: () => void, signal?: AbortSignal) {
  let dirty = true;
  let databasePath: string | undefined;
  let snapshot: GitHubOAuthInventory | undefined;
  const invalidate = () => {
    dirty = true;
    onChange();
  };
  const unsubscribe = subscribeSecretStoreChanges((change) => {
    if (change.githubOAuth && change.databasePath === resolveOpenClawStateSqlitePath()) {
      invalidate();
    }
  });
  const unregisterResource = registerOpenClawStateDatabaseAsyncResource({
    async close() {
      snapshot = undefined;
      invalidate();
    },
  });
  const unsubscribeLifecycle = registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened" && event.path === resolveOpenClawStateSqlitePath()) {
      snapshot = undefined;
      invalidate();
    }
  });
  return {
    async read() {
      signal?.throwIfAborted();
      const path = resolveOpenClawStateSqlitePath();
      if (snapshot && !dirty && databasePath === path) {
        return snapshot;
      }
      databasePath = path;
      dirty = false;
      try {
        signal?.throwIfAborted();
        snapshot = await listGitHubAuthorizationRecords();
        signal?.throwIfAborted();
        return snapshot;
      } catch (error) {
        dirty = true;
        throw error;
      }
    },
    get dirty() {
      return dirty;
    },
    close() {
      unsubscribe();
      unsubscribeLifecycle();
      unregisterResource();
      snapshot = undefined;
    },
  };
}

/** Storage and agent authority retain their existing owners; the plugin assembles OAuth policy.
 * Calls admitted before shutdown retain storage settlement; the closed service cannot admit new work.
 */
export function createRepositoryOAuthStateHostV1(signal: AbortSignal) {
  const bind =
    <Args extends unknown[], Result>(run: (...args: Args) => Result) =>
    (...args: Args): Result => {
      signal.throwIfAborted();
      return run(...args);
    };
  return {
    authority: {
      captureAgentLifecycleBinding: bind(captureAgentLifecycleBinding),
      matchesAgentLifecycleBindingAsync: bind(matchesAgentLifecycleBindingAsync),
      matchesAgentLifecycleBinding: bind(matchesAgentLifecycleBinding),
      withAgentRosterFactsBatch: bind(withAgentRosterFactsBatch),
      listAgentIds: bind(listAgentIds),
      resolveAgentConfig: bind(resolveAgentConfig),
      registerRuntimeConfigWriteListener: bind(registerRuntimeConfigWriteListener),
    },
    records: {
      createGitHubOAuthRecord: bind(createGitHubOAuthRecord),
      deleteGitHubDeviceAuthorizationRecord: bind(deleteGitHubDeviceAuthorizationRecord),
      deleteGitHubOAuthRecord: bind(deleteGitHubOAuthRecord),
      inspectGitHubOAuthRecord: bind(inspectGitHubOAuthRecord),
      listGitHubDeviceAuthorizationRecords: bind(listGitHubDeviceAuthorizationRecords),
      readGitHubDeviceAuthorizationRecord: bind(readGitHubDeviceAuthorizationRecord),
      writeGitHubDeviceAuthorizationRecord: bind(writeGitHubDeviceAuthorizationRecord),
      writeGitHubOAuthRecord: bind(writeGitHubOAuthRecord),
      deleteGitHubDeviceAuthorizationRecordNative: bind(
        deleteGitHubDeviceAuthorizationRecordNative,
      ),
      deleteGitHubOAuthRecordNative: bind(deleteGitHubOAuthRecordNative),
      readGitHubDeviceAuthorizationRecordNative: bind(readGitHubDeviceAuthorizationRecordNative),
    },
    inventory: {
      createReader: bind((onChange: () => void) =>
        createGitHubOAuthInventoryReader(onChange, signal),
      ),
    },
  };
}
export type RepositoryOAuthStateHostV1 = ReturnType<typeof createRepositoryOAuthStateHostV1>;
