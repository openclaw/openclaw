import { isDeepStrictEqual } from "node:util";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  parseWorkspaceInspectionResult,
  WORKSPACE_INSPECTION_COMMAND,
  type WorkspaceInspectionInput,
  type WorkspaceInspectionResult,
} from "../../worker/workspace-inspection-protocol.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

type LoadedSession = ReturnType<typeof loadGatewaySessionEntryReadOnly>;
type Operation = WorkspaceInspectionInput["operation"];

export class DeviceFolderFilesUnavailableError extends Error {}

/** Device-folder access is valid only through its exact live paired-device placement. */
export async function resolveDeviceFolderWorkspaceAccess(
  loaded: LoadedSession,
  context?: GatewayRequestContext,
) {
  const entry = loaded.entry;
  const folder = entry?.deviceFolder;
  if (!folder) {
    return undefined;
  }
  if (!entry.sessionId || !loaded.agentId || !loaded.storePath) {
    throw new DeviceFolderFilesUnavailableError(
      "Start this session on its paired device to browse or edit its files.",
    );
  }
  const sessionId = entry.sessionId;
  const scope = {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.storePath,
  };
  const metadata = captureSessionEntryMetadataRead(scope);
  let facts: ReturnType<typeof retainPreparedSessionSharingFacts> | undefined;
  let placementRead:
    | Awaited<ReturnType<WorkerSessionPlacementStore["prepareSessionPlacement"]>>
    | undefined;
  let active = true;
  let unregister = () => {};
  const release = () => {
    active = false;
    facts?.release();
    placementRead?.release();
    unregister();
  };
  let readEntry: () => SessionEntryCurrentFacts | undefined = () =>
    metadata
      ? metadata.readCurrent()
      : loadGatewaySessionEntryReadOnly(loaded.canonicalKey, { agentId: loaded.agentId }).entry;
  const assertSession = () => {
    if (!active) {
      throw new Error("The device-folder session source is unavailable.");
    }
    const current = readEntry();
    if (
      current?.sessionId !== sessionId ||
      current.lifecycleRevision !== entry.lifecycleRevision ||
      current.archivedAt !== entry.archivedAt ||
      !isDeepStrictEqual(current.deviceFolder, folder)
    ) {
      throw new Error("The device-folder session changed; refresh this session.");
    }
  };
  try {
    const placements = context?.workerSessionPlacementService;
    const environments = context?.workerEnvironmentService;
    placementRead = await placements?.prepareSessionPlacement?.(sessionId);
    const placement = placementRead
      ? placementRead.current()
      : await readSessionWorkerPlacementAsync({ context: context ?? {}, sessionId });
    if (placement?.state !== "active" || !placements || !environments) {
      throw new DeviceFolderFilesUnavailableError(
        "Start this session on its paired device to browse or edit its files.",
      );
    }
    if (!metadata && !isIncognitoSessionKey(loaded.canonicalKey)) {
      await withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          if (!facts) {
            throw new Error("The device-folder session source is unavailable.");
          }
          facts.initialize({
            entry: read.value && projectSessionSharingEntry(read.value),
            membership: new Set(),
          });
          readEntry = () => facts?.readCurrent()?.entry;
        },
        (database, identity) => {
          facts = retainPreparedSessionSharingFacts({
            databaseIdentity: identity.key,
            sessionKey: loaded.canonicalKey,
            acquiring: true,
          });
          unregister = registerOpenClawAgentDatabaseAsyncResource({
            ...database,
            revoke: release,
            close: async () => release(),
          });
        },
      );
    }
    assertSession();
    const assertCurrent = () => {
      assertSession();
      const current = placementRead
        ? placementRead.current()
        : placements.getMany([sessionId]).get(sessionId);
      const environment = environments.get(placement.environmentId);
      if (
        current?.state !== "active" ||
        current.sessionId !== sessionId ||
        current.agentId !== loaded.agentId ||
        current.sessionKey !== loaded.canonicalKey ||
        current.generation !== placement.generation ||
        current.environmentId !== placement.environmentId ||
        current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
        current.remoteWorkspaceDir !== folder.path ||
        environment?.state !== "attached" ||
        environment.ownerEpoch !== placement.activeOwnerEpoch ||
        environment.nodeDeviceId !== folder.deviceId ||
        environment.attachedSessionIds.length !== 1 ||
        environment.attachedSessionIds[0] !== sessionId
      ) {
        throw new Error("The device-folder placement changed; refresh this session.");
      }
    };
    return {
      kind: "active" as const,
      [Symbol.dispose]: release,
      async inspect<T extends Operation>(
        operation: T,
        request: Omit<
          Extract<WorkspaceInspectionInput, { operation: T }>,
          "operation" | "sessionKey"
        >,
        authorize?: () => void,
      ): Promise<WorkspaceInspectionResult<T>> {
        const assertAuthorized = () => {
          assertCurrent();
          authorize?.();
        };
        const run = async () => {
          assertAuthorized();
          const tunnel = await environments.startTunnel({
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          });
          assertAuthorized();
          if (
            tunnel.environmentId !== placement.environmentId ||
            tunnel.ownerEpoch !== placement.activeOwnerEpoch
          ) {
            throw new Error("The device-folder tunnel owner changed.");
          }
          const result = await tunnel.runWorkspaceCommand({
            argv: [WORKSPACE_INSPECTION_COMMAND],
            input: JSON.stringify({ ...request, operation, sessionKey: loaded.canonicalKey }),
            transportRetry: operation === "set" ? "never" : "idempotent",
            assertCurrent: assertAuthorized,
            timeoutMs: 30_000,
          });
          assertAuthorized();
          if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
            throw new Error(
              "Device-folder inspection failed; reconnect the paired device and retry.",
            );
          }
          return parseWorkspaceInspectionResult(operation, result.stdout);
        };
        if (operation !== "set") {
          return await run();
        }
        // Device folders have no Gateway checkpoint to reconcile. The session lifecycle lock is the
        // authoritative save fence: it serializes editor writes with stop, archive, and *** rewrites.
        return await runExclusiveSessionLifecycleMutation("workspace-edit", {
          scope: loaded.storePath,
          identities: [loaded.canonicalKey, ...loaded.storeKeys, sessionId],
          run,
        });
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
