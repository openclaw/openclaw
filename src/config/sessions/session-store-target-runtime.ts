import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import {
  withSessionHistoryWorkerReadCandidates,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";

type PreparedStoreTarget = Extract<SessionStoreTargetReadResult, { kind: "session-store-target" }>;
type StoreTargetReadOwner = {
  assertCurrent: () => void;
};

export async function withSessionStoreTarget<T>(
  request: Omit<SessionStoreTargetReadRequest, "registeredDatabases">,
  operation: (target: PreparedStoreTarget, owner: StoreTargetReadOwner) => Promise<T>,
  assertCallerCurrent?: () => void,
  onReadError?: (error: unknown, assertCurrent: () => void) => Promise<T>,
  { lane }: { lane?: SessionHistoryWorkerLane } = {},
): Promise<T> {
  assertCallerCurrent?.();
  const { candidates, ...targetRequest } = request;
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: targetRequest.env });
  return withSessionHistoryWorkerReadCandidates(
    candidates,
    async (discovery) => {
      let registryStarted = false;
      const assertDiscoveryCurrent = () => {
        assertCallerCurrent?.();
        discovery.assertCurrent();
        if (registryStarted) {
          registryRead.assertCurrent();
        }
      };
      const failedRead = async (error: unknown): Promise<T> => {
        assertDiscoveryCurrent();
        if (!onReadError) {
          throw error;
        }
        return await onReadError(error, assertDiscoveryCurrent);
      };
      let read = await discovery.readStoreTargetResult({
        ...targetRequest,
        registeredDatabases: { status: "deferred" },
      });
      if (!read.ok) {
        return await failedRead(read.error);
      }
      let resolved = read.value;
      let registry: Awaited<ReturnType<typeof registryRead.read>> | undefined;
      if (resolved.kind === "session-target-registry-required") {
        registryStarted = true;
        registryRead.assertCurrent();
        registry = await registryRead.read();
        registry.assertCurrent();
        discovery.assertCurrent();
        assertCallerCurrent?.();
        read = await discovery.readStoreTargetResult({
          ...targetRequest,
          registeredDatabases:
            registry.result.status === "available"
              ? registry.result.entries
              : { status: "unavailable" },
        });
        if (!read.ok) {
          return await failedRead(read.error);
        }
        resolved = read.value;
        if (resolved.kind === "session-target-registry-required") {
          throw new Error("Session store target requested registry rows twice");
        }
      }
      registry?.assertCurrent();
      const target = resolved;
      const assertCurrent = () => {
        assertDiscoveryCurrent();
        registry?.assertCurrent();
        assertSessionStoreReadCandidate(target.sourcePath, candidates);
      };
      assertCurrent();
      // A synchronous consumer may already publish; its operation owns the final currentness check.
      return await operation(target, { assertCurrent });
    },
    lane,
  );
}
