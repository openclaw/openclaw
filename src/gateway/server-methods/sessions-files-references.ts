import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionsFilesReferencesParams } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import {
  createSessionFileReadAuthority,
  sessionFileWorkspaceMatches,
} from "./session-file-read-authority.js";
import { prepareSessionFileReadPath } from "./session-file-read.js";
import { createLocalFileReferenceLease } from "./session-file-references.js";
import { requireSessionFilesAgentId, withSessionFileRoot } from "./session-files-root.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";
import { openWorkspaceRoot } from "./workspace-fs.js";

const resolverRevision = randomUUID();
const MAX_CONNECTION_LEASES = 8;
type Lease = Awaited<ReturnType<typeof createLocalFileReferenceLease>>;
type BoundLease = {
  lease: Lease;
  sessionKey: string;
  rootPath: string;
  readRootPath: string;
  account: string;
  context: SessionsFilesReferencesParams["context"];
  entry: InternalSessionEntry;
  assertWorkspace: NonNullable<
    Parameters<Parameters<typeof withSessionFileRoot>[2]>[0]["fileWorkspace"]
  >["assertCurrent"];
};
type LeaseSlot = {
  state:
    | { kind: "preparing"; lease?: Lease }
    | { kind: "ready"; bound: BoundLease }
    | { kind: "retiring"; lease: Lease };
};
const connections = new WeakMap<GatewayClient, Map<string, LeaseSlot>>();

async function retireSlot(leases: Map<string, LeaseSlot>, sessionKey: string, slot: LeaseSlot) {
  const lease = slot.state.kind === "ready" ? slot.state.bound.lease : slot.state.lease;
  if (lease) {
    slot.state = { kind: "retiring", lease };
  }
  try {
    await lease?.dispose();
  } finally {
    if (leases.get(sessionKey) === slot) {
      leases.delete(sessionKey);
    }
  }
}

function accountBinding(client: GatewayClient) {
  return JSON.stringify([
    client.authenticatedUserId,
    client.authenticatedUserProfile?.profileId,
    client.authenticatedGitHubAccountId,
    client.sharedGatewaySessionGeneration,
    client.connect.role,
    client.connect.scopes,
  ]);
}

function opaqueId(value: string) {
  return createHash("sha256").update(resolverRevision).update(value).digest("hex");
}

function connectionLeases(client: GatewayClient) {
  let leases = connections.get(client);
  if (!leases) {
    leases = new Map();
    connections.set(client, leases);
    const owned = leases;
    client.connectionSignal?.addEventListener(
      "abort",
      () => {
        for (const [sessionKey, slot] of owned) {
          void retireSlot(owned, sessionKey, slot).catch(() => {});
        }
        owned.clear();
      },
      { once: true },
    );
  }
  return leases;
}

/** Metadata-only sibling of the file browser, through its existing session admission owner. */
export async function handleSessionFilesReferences(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: SessionsFilesReferencesParams },
): Promise<void> {
  const { params, client, context, respond } = options;
  const reply = (result: import("../../shared/file-references.js").FileReferenceResult) =>
    respond(true, result);
  if (!client || client.invalidated || client.connectionSignal?.aborted) {
    reply({ status: "denied" });
    return;
  }
  const agentId = requireSessionFilesAgentId({
    cfg: context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    respond,
  });
  if (!agentId) {
    return;
  }
  let read: Awaited<ReturnType<typeof retainSessionScopedRead>>;
  let admission:
    | { leases: Map<string, LeaseSlot>; sessionKey: string; slot: LeaseSlot; bound?: BoundLease }
    | undefined;
  try {
    read = await retainSessionScopedRead(options, params.sessionKey, agentId, {
      requireMaterialized: true,
      retain: true,
      projection: ["skillsSnapshot"],
      entryMatches: (previous, current) =>
        !hasSessionReadAccessChanged(previous, current) &&
        sessionFileWorkspaceMatches(previous, current),
    });
    const result = await withSessionFileRoot(
      {
        sessionKey: params.sessionKey,
        agentId,
        getRuntimeConfig: context.getRuntimeConfig,
        projection: "list",
        retained: read?.prepared,
      },
      context.getRuntimeConfig(),
      async (source, assertSourceCurrent, readEntry) => {
        const host = createSessionFileReadAuthority(options, {
          ...source,
          agentId,
          readEntry: read?.prepared.readRetainedEntry ?? readEntry,
          assertSourceCurrent: read?.assertCurrent ?? assertSourceCurrent,
          isInvitedWorkspaceTarget: read?.isInvitedWorkspaceTarget,
        });
        const authority = readGatewayRequestMutationAuthority(options);
        const account = accountBinding(client);
        const assertAuthorityCurrent = () => {
          authority.assertCurrent();
          read?.assertCurrent();
          assertSourceCurrent();
          host.assertCurrent();
          if (
            client.invalidated ||
            client.connectionSignal?.aborted ||
            accountBinding(client) !== account
          ) {
            throw new Error("File reference authority changed");
          }
        };
        let assertReadCurrent: (() => void) | undefined;
        const assertCurrent = () => {
          assertAuthorityCurrent();
          assertReadCurrent?.();
        };
        try {
          assertCurrent();
          // A local-looking path is not a remote workspace's identity contract.
          if (
            !source.entry?.sessionId ||
            !source.root ||
            !source.fileWorkspace ||
            source.entry.repositoryWorkspaceId ||
            source.entry.deviceFolder ||
            source.entry.execNode ||
            getAgentWorkspaceAccess(source.root)
          ) {
            return { status: "unsupported" } as const;
          }
          if (source.fileWorkspace.readScope === "host" && !(await host.authorizeHostRead())) {
            return { status: "denied" } as const;
          }
          const preparedPath = await prepareSessionFileReadPath({
            root: source.root,
            fileRoot: source.fileRoot,
            sandboxWorkspace: source.fileWorkspace.sandboxWorkspace,
            worktreeId: source.entry.worktree?.id,
            historical: source.fileWorkspace.historical,
            assertCurrent: assertSourceCurrent,
            assertReadCurrent: assertAuthorityCurrent,
          });
          if (preparedPath.path === null) {
            return { status: "denied" } as const;
          }
          // The public workspace path can name a checkpoint, while its authorized
          // live files belong to a private sandbox projection. Re-enter that owner
          // on each RPC; its guard must not outlive this request's retained read.
          const readRootPath = preparedPath.readRoot ?? source.root;
          assertReadCurrent = preparedPath.assertCurrent;
          assertCurrent();
          const leases = connectionLeases(client);
          if (params.action === "capabilities") {
            for (const [sessionKey, slot] of leases) {
              if (
                sessionKey !== source.canonicalKey &&
                slot.state.kind === "ready" &&
                slot.state.bound.lease.capability.leaseExpiresAt <= Date.now()
              ) {
                // Retiring slots still count until their resources have closed.
                void retireSlot(leases, sessionKey, slot).catch(() => {});
              }
            }
            const previous = leases.get(source.canonicalKey);
            if (
              (previous && previous.state.kind !== "ready") ||
              (!previous && leases.size >= MAX_CONNECTION_LEASES)
            ) {
              return { status: "denied" } as const;
            }
            // Reserve synchronously before cleanup or filesystem awaits. A second
            // request for this session is denied, not queued behind construction.
            const slot: LeaseSlot = { state: { kind: "preparing" } };
            leases.set(source.canonicalKey, slot);
            admission = { leases, sessionKey: source.canonicalKey, slot };
            if (previous) {
              await retireSlot(leases, source.canonicalKey, previous);
            }
            assertCurrent();
            if (leases.get(source.canonicalKey) !== slot) {
              return { status: "stale" } as const;
            }
            const root = await openWorkspaceRoot(readRootPath);
            assertCurrent();
            if (leases.get(source.canonicalKey) !== slot) {
              return { status: "stale" } as const;
            }
            if (!root || "access" in root) {
              return { status: "unsupported" } as const;
            }
            const lease = await createLocalFileReferenceLease({
              root,
              accountId: opaqueId(account),
              workspaceId: opaqueId(
                `${source.canonicalKey}\0${source.entry.sessionId}\0${source.root}`,
              ),
              rootLabel: path.basename(source.root) || "Workspace",
              authorizationRevision: randomUUID(),
              resolverRevision,
            });
            slot.state = { kind: "preparing", lease };
            assertCurrent();
            admission.bound = {
              lease,
              sessionKey: source.canonicalKey,
              rootPath: source.root,
              readRootPath,
              account,
              context: params.context,
              entry: structuredClone(source.entry),
              assertWorkspace: source.fileWorkspace.assertCurrent.bind(source.fileWorkspace),
            };
            return { status: "ready", capability: lease.capability } as const;
          }
          const slot = leases.get(source.canonicalKey);
          const bound = slot?.state.kind === "ready" ? slot.state.bound : undefined;
          if (
            !slot ||
            !bound ||
            bound.lease.capability.leaseId !== params.leaseId ||
            bound.sessionKey !== source.canonicalKey ||
            bound.account !== account ||
            bound.rootPath !== source.root ||
            bound.readRootPath !== readRootPath ||
            !isDeepStrictEqual(bound.context, params.context) ||
            !sessionFileWorkspaceMatches(bound.entry, source.entry) ||
            hasSessionReadAccessChanged(bound.entry, source.entry)
          ) {
            return { status: "denied" } as const;
          }
          bound.assertWorkspace(context.getRuntimeConfig(), source.entry);
          if (params.action === "release") {
            await retireSlot(leases, source.canonicalKey, slot);
            return { status: "released" } as const;
          }
          return await (params.action === "search"
            ? bound.lease.search(params.query, params.cursor, assertCurrent)
            : bound.lease.revalidate(params.objectId, assertCurrent));
        } finally {
          host.release();
        }
      },
    );
    if (result.status === "ready") {
      if (
        !admission?.bound ||
        admission.leases.get(admission.sessionKey) !== admission.slot ||
        client.invalidated ||
        client.connectionSignal?.aborted
      ) {
        reply({ status: "stale" });
        return;
      }
      // Publish only after withSessionFileRoot's final authority fence succeeds.
      admission.slot.state = { kind: "ready", bound: admission.bound };
    }
    reply(result);
    if (result.status === "ready") {
      admission = undefined;
    }
  } catch {
    // Metadata denials deliberately disclose neither private names nor provider errors.
    reply({ status: "denied" });
  } finally {
    if (admission) {
      await retireSlot(admission.leases, admission.sessionKey, admission.slot);
    }
    read?.release();
  }
}
