import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeWorkerDesktopEndpoint } from "./desktop-endpoint.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import {
  isCurrentWorkerWorkspacePendingResultOwner,
  readWorkerWorkspaceReconciliationFacts,
} from "./placement-workspace-result.js";
import { assertPreparedEnvironmentAttachment } from "./prepared-environment-store.js";
import { hasWorkerEnvironmentSessionAttachment } from "./session-attachment-store.js";
import { WorkerSessionAlreadyAttachedError } from "./session-attachment.js";
import { canTransitionWorkerEnvironment } from "./state.js";
import {
  credentialInsert,
  nextGlobalOwnerEpoch,
  replaceSshFallbackPorts,
  revokeCredential,
  updateRow,
  upsertCredential,
} from "./store-mutations.js";
import {
  findCredential,
  getRequiredWorkerEnvironment,
  json,
  listRows,
  queryWorkerEnvironmentStore,
} from "./store-row-codec.js";
import {
  assertShape,
  normalizeAttachedSessionIds,
  normalizeBootstrapReceipt,
  normalizeWorkerSshEndpoint,
  requireWorkerEnvironmentString,
} from "./store-validation.js";
import type { WorkerEnvironmentMutationInput } from "./store.types.js";

function resolveNullablePatch<T>(
  patch: T | null | undefined,
  current: T | null,
  normalize: (value: T) => T,
): T | null {
  return patch === undefined ? current : patch === null ? null : normalize(patch);
}

export function createWorkerEnvironmentTransitionOps(db: DatabaseSync, now: () => number) {
  return {
    refreshBootstrapReceipt(
      input: WorkerEnvironmentMutationInput<"refreshBootstrapReceipt">,
    ): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const expectedReceipt = normalizeBootstrapReceipt(input.expectedBootstrapReceipt);
      const receipt = normalizeBootstrapReceipt(input.bootstrapReceipt);
      const current = getRequiredWorkerEnvironment(db, environmentId);
      if (
        current.state !== input.expectedState ||
        current.ownerEpoch !== input.expectedOwnerEpoch ||
        current.nodeDeviceId !== input.expectedNodeDeviceId ||
        current.destroyRequestedAtMs !== null ||
        !current.leaseId ||
        (!current.nodeDeviceId && !current.sshEndpoint) ||
        !isDeepStrictEqual(current.bootstrapReceipt, expectedReceipt)
      ) {
        throw new Error("Worker environment changed during runtime refresh");
      }
      if (findCredential(db, environmentId)) {
        throw new Error("Worker runtime refresh requires its previous credential to be revoked");
      }
      const updatedAtMs = now();
      if (input.expectedState === "attached") {
        const attachedSessionId = current.attachedSessionIds[0];
        const placements = executeSqliteQuerySync(
          db,
          queryWorkerEnvironmentStore(db)
            .selectFrom("worker_session_placements")
            .selectAll()
            .where("environment_id", "=", environmentId)
            .where("state", "=", input.expectedReclaimResult ? "draining" : "active"),
        ).rows;
        const placement = placements.length === 1 ? placements[0] : undefined;
        if (
          current.attachedSessionIds.length !== 1 ||
          !placement ||
          placement.session_id !== attachedSessionId ||
          placement.active_owner_epoch !== current.ownerEpoch ||
          placement.transition_generation !== input.expectedPlacementGeneration ||
          placement.worker_bundle_hash !== expectedReceipt.bundleHash
        ) {
          throw new Error("Worker placement changed during runtime refresh");
        }
        if (input.expectedReclaimResult) {
          const retained = readWorkerWorkspaceReconciliationFacts(db, [placement.session_id]);
          const pending = retained.pendingResults.get(placement.session_id);
          if (
            !pending ||
            pending.claimId !== pending.runId ||
            !pending.claimId.startsWith("reclaim-") ||
            !isDeepStrictEqual(pending, input.expectedReclaimResult) ||
            !isCurrentWorkerWorkspacePendingResultOwner(
              retained.placements.get(placement.session_id),
              pending,
            )
          ) {
            throw new Error("Worker runtime refresh lost its retained Stop result");
          }
        }
        if (
          executeSqliteQueryTakeFirstSync(
            db,
            queryWorkerEnvironmentStore(db)
              .selectFrom("worker_session_placement_moves")
              .select("session_id")
              .where("session_id", "=", placement.session_id),
          )
        ) {
          throw new Error("Cannot refresh a worker runtime while its session is moving");
        }
        executeSqliteQuerySync(
          db,
          queryWorkerEnvironmentStore(db)
            .updateTable("worker_session_placements")
            .set({ worker_bundle_hash: receipt.bundleHash, updated_at_ms: updatedAtMs })
            .where("session_id", "=", placement.session_id),
        );
      }
      // The epoch also names the node workspace directory. Rotate executable authority
      // through fresh credentials and turn claims without replacing that workspace owner.
      updateRow(db, environmentId, current.state, {
        bootstrap_bundle_hash: receipt.bundleHash,
        bootstrap_openclaw_version: receipt.openclawVersion,
        bootstrap_protocol_features_json: json(receipt.protocolFeatures),
        bootstrap_install_kind: receipt.installKind ?? null,
        updated_at_ms: updatedAtMs,
        last_error: null,
      });
      return getRequiredWorkerEnvironment(db, environmentId);
    },
    transition(input: WorkerEnvironmentMutationInput<"transition">): WorkerEnvironmentRecord {
      const { from, to, patch = {} } = input;
      if (!canTransitionWorkerEnvironment(from, to)) {
        throw new Error(`Illegal worker environment transition: ${from} -> ${to}`);
      }
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const updatedAtMs = now();
      const current = getRequiredWorkerEnvironment(db, environmentId);
      if (current.state !== from) {
        throw new Error(
          `Worker environment ${environmentId} state conflict: expected ${from}, found ${current.state}`,
        );
      }
      if (
        input.expectedOwnerEpoch !== undefined &&
        current.ownerEpoch !== input.expectedOwnerEpoch
      ) {
        throw new Error(`Worker environment ${environmentId} owner epoch changed`);
      }
      if (to === "attached") {
        if (current.destroyRequestedAtMs !== null) {
          throw new Error("Cannot attach worker after destroy is requested");
        }
        if (hasWorkerEnvironmentSessionAttachment(db, environmentId)) {
          throw new Error(
            "Conversation-attached environments cannot be adopted for session placement",
          );
        }
        const sessionId = patch.attachedSessionIds?.[0];
        if (current.preparation && !sessionId) {
          throw new Error("Prepared worker attachment requires its exact session");
        }
        if (sessionId) {
          assertPreparedEnvironmentAttachment(db, current, sessionId, input.placementBinding);
        }
      }
      // Terminal bootstrap failure is valid only after the service proves teardown;
      // explicit clearing prevents the state row from silently losing a paid lease.
      const clearsLeaseAfterTeardownFailure = to === "failed" && from === "destroying";
      if (
        clearsLeaseAfterTeardownFailure &&
        (current.destroyRequestedAtMs === null || current.teardownTerminalState !== "failed")
      ) {
        throw new Error("Failed bootstrap transition requires durable provider teardown intent");
      }
      if (
        clearsLeaseAfterTeardownFailure &&
        (patch.leaseId !== null || patch.sshEndpoint !== null)
      ) {
        throw new Error(
          "Failed bootstrap transition requires explicit lease clearing after provider teardown",
        );
      }
      const leaseId = resolveNullablePatch(patch.leaseId, current.leaseId, (value) =>
        requireWorkerEnvironmentString(value, "lease id"),
      );
      if (current.leaseId && leaseId !== current.leaseId && !clearsLeaseAfterTeardownFailure) {
        throw new Error("Worker environment provider lease id is immutable once persisted");
      }
      const nodeDeviceId = resolveNullablePatch(
        patch.nodeDeviceId,
        current.nodeDeviceId ?? null,
        (value) => requireWorkerEnvironmentString(value, "node device id"),
      );
      if (
        current.nodeDeviceId &&
        nodeDeviceId !== current.nodeDeviceId &&
        !clearsLeaseAfterTeardownFailure
      ) {
        throw new Error("Worker environment node device id is immutable once persisted");
      }
      const sshEndpoint = resolveNullablePatch(
        patch.sshEndpoint,
        current.sshEndpoint,
        normalizeWorkerSshEndpoint,
      );
      const sharedHost = leaseId === null ? null : (patch.sharedHost ?? current.sharedHost);
      const desktop =
        leaseId === null
          ? null
          : resolveNullablePatch(patch.desktop, current.desktop, normalizeWorkerDesktopEndpoint);
      const acceptsBootstrapReceipt =
        to === "ready" &&
        (from === "bootstrapping" || (from === "provisioning" && sshEndpoint === null));
      if (to === "ready" && !acceptsBootstrapReceipt) {
        throw new Error("Ready worker transition requires bootstrap proof or a node lease");
      }
      if (patch.bootstrapReceipt !== undefined && !acceptsBootstrapReceipt) {
        throw new Error("Bootstrap receipt can only be recorded when a worker becomes ready");
      }
      if (acceptsBootstrapReceipt && patch.bootstrapReceipt === undefined) {
        throw new Error("Ready worker transition requires a bootstrap receipt");
      }
      const acceptsAttachedCredential = to === "attached";
      const acceptsCredential = acceptsBootstrapReceipt || acceptsAttachedCredential;
      if (patch.credential !== undefined && !acceptsCredential) {
        throw new Error("Worker credential cannot be minted during this transition");
      }
      if (acceptsCredential && patch.credential === undefined) {
        throw new Error(
          `${to === "ready" ? "Ready" : "Attached"} worker transition requires a worker credential`,
        );
      }
      // Rebootstrap invalidates the old admission proof before remote mutation;
      // a crash therefore resumes in bootstrapping instead of advertising stale readiness.
      const clearsBootstrapReceipt =
        to === "bootstrapping" && (from === "ready" || from === "idle");
      const bootstrapReceipt = clearsBootstrapReceipt
        ? null
        : patch.bootstrapReceipt === undefined
          ? current.bootstrapReceipt
          : normalizeBootstrapReceipt(patch.bootstrapReceipt);
      if (acceptsCredential && !bootstrapReceipt) {
        throw new Error(`${to === "ready" ? "Ready" : "Attached"} worker requires bootstrap proof`);
      }
      const attachedSessionIds =
        to !== "attached"
          ? []
          : patch.attachedSessionIds === undefined
            ? current.attachedSessionIds
            : normalizeAttachedSessionIds(patch.attachedSessionIds);
      assertShape({
        state: to,
        leaseId,
        nodeDeviceId,
        sshEndpoint,
        desktop,
        bootstrapReceipt,
        attachedSessionIds,
      });
      const [attachedSessionId] = attachedSessionIds;
      if (to === "attached" && attachedSessionId) {
        // Destroy-requested attachments retain physical cleanup scope, not live ownership.
        // Change session ownership atomically without discarding that old scope.
        const existingOwner = listRows(db).find(
          (record) =>
            record.environmentId !== environmentId &&
            record.state === "attached" &&
            record.destroyRequestedAtMs === null &&
            record.attachedSessionIds[0] === attachedSessionId,
        );
        if (existingOwner) {
          throw new WorkerSessionAlreadyAttachedError(
            attachedSessionId,
            existingOwner.environmentId,
          );
        }
      }
      const revokesCredential =
        clearsBootstrapReceipt ||
        to === "attached" ||
        (from === "attached" && to === "idle") ||
        to === "draining" ||
        to === "destroyed" ||
        to === "failed" ||
        to === "orphaned";
      const ownerEndingTransition =
        revokesCredential &&
        !acceptsAttachedCredential &&
        (from === "ready" || from === "idle" || from === "attached");
      const ownerEpoch = acceptsBootstrapReceipt
        ? Math.max(1, current.ownerEpoch)
        : acceptsAttachedCredential || ownerEndingTransition
          ? nextGlobalOwnerEpoch(db)
          : current.ownerEpoch;
      updateRow(db, environmentId, from, {
        lease_id: leaseId,
        node_device_id: nodeDeviceId,
        shared_host: sharedHost === null ? null : sharedHost ? 1 : 0,
        ssh_host: sshEndpoint?.host ?? null,
        ssh_port: sshEndpoint?.port ?? null,
        ssh_user: sshEndpoint?.user ?? null,
        ssh_host_key: sshEndpoint?.hostKey ?? null,
        ssh_key_ref_json: sshEndpoint ? json(sshEndpoint.keyRef) : null,
        desktop_json: desktop ? json(desktop) : null,
        bootstrap_bundle_hash: bootstrapReceipt?.bundleHash ?? null,
        bootstrap_openclaw_version: bootstrapReceipt?.openclawVersion ?? null,
        bootstrap_protocol_features_json: bootstrapReceipt
          ? json(bootstrapReceipt.protocolFeatures)
          : null,
        bootstrap_install_kind: bootstrapReceipt?.installKind ?? null,
        owner_epoch: ownerEpoch,
        state: to,
        attached_session_ids_json: json(attachedSessionIds),
        updated_at_ms: updatedAtMs,
        state_changed_at_ms: updatedAtMs,
        idle_since_at_ms: to === "idle" ? updatedAtMs : null,
        last_error: patch.lastError?.trim() || null,
      });
      if (patch.sshEndpoint !== undefined) {
        replaceSshFallbackPorts(db, environmentId, sshEndpoint?.fallbackPorts ?? []);
      }
      if (revokesCredential) {
        revokeCredential(db, environmentId);
      }
      if (patch.credential && bootstrapReceipt) {
        upsertCredential(
          db,
          credentialInsert({
            input: patch.credential,
            environmentId,
            bundleHash: bootstrapReceipt.bundleHash,
            attachedSessionIds,
            ownerEpoch,
            nowMs: updatedAtMs,
          }),
        );
      }
      return getRequiredWorkerEnvironment(db, environmentId);
    },
  };
}
