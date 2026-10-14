import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../../config/sessions/session-actor-storage-binding.js";
import {
  buildSessionCreationStamp,
  inheritSessionGitContributorProfileIds,
} from "../../../config/sessions/session-entry-provenance.js";
import { captureSessionEntrySourceAssertion } from "../../../config/sessions/session-entry-source-authority.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { buildDashboardSessionTitleSource } from "../../../gateway/dashboard-session-title.js";
import type { FreshChildSession } from "../../../gateway/in-process-session-run.js";
import {
  normalizeTrustedGroupMetadata,
  resolveAgentSessionGroup,
  type TrustedGroupMetadata,
} from "../../../gateway/server-methods/agent-subagent-registration.js";
import type { PreparedGatewaySessionLifecycle } from "../../../gateway/session-create-service.types.js";
import type { GatewaySessionStoreTargetWithStore } from "../../../gateway/session-utils-store.types.js";
import {
  prepareSessionWorktreeCreation,
  resolveSessionProjectRoot,
} from "../../../gateway/session-worktree-preparation.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { resolveUserPath } from "../../../utils.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import { captureDelegatedToolPolicyAssertion } from "../../delegated-tool-policy.js";
import { inheritedToolAllowPatch, inheritedToolDenyPatch } from "../../inherited-tool-deny.js";
import type { resolveSpawnAdmission } from "../../spawn-plan.js";
import type { PreparedSessionPermissionPolicy } from "../../tool-fs-policy.types.js";
import { captureSpawnParentLineage } from "./spawn-parent-lineage.js";
import { withSubagentSessionSource } from "./subagent-session-source.js";
import type { SpawnSubagentParams } from "./subagent-spawn-contract.js";
import type { resolveSubagentModelAndThinkingPlan } from "./subagent-spawn-plan.js";
import {
  emitSessionLifecycleEvent,
  resolveGatewaySessionStoreTargetInWorker,
  upsertSessionEntryCore,
} from "./subagent-spawn.runtime.js";

export async function createInitialSubagentSession(input: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  targetAgentId: string;
  childSessionKey: string;
  label?: string;
  incognito: boolean;
  requesterInternalKey: string;
  parentTarget: GatewaySessionStoreTargetWithStore;
  senderIsOwner?: boolean;
  expectedParentSessionId?: string;
  assertActive?: SessionSourceAssertion;
  creationPolicy: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
  completionOwnerSessionKey: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  worktree?: Pick<SpawnSubagentParams, "projectId" | "worktreeName" | "worktreeBaseRef" | "task">;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  admissionPatch?: Extract<
    ReturnType<typeof resolveSpawnAdmission>,
    { ok: true }
  >["childSessionPatch"];
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  inheritedToolPolicySource?: "sender";
  delegatedToolPolicy?: SessionEntry["delegatedToolPolicy"];
  modelPatch: Partial<
    Extract<
      Awaited<ReturnType<typeof resolveSubagentModelAndThinkingPlan>>,
      { status: "ok" }
    >["initialSessionPatch"]
  >;
  swarmGroupId?: string;
  collect: boolean;
  outputSchema?: Record<string, unknown>;
  firstAdmission?: { delivery?: DeliveryContext; group: TrustedGroupMetadata };
}): Promise<
  | { status: "ok"; entry?: SessionEntry; freshChild?: FreshChildSession }
  | { status: "error"; error: string }
> {
  const params = {
    ...input,
    assertActive: composeSessionSourceAssertion([
      input.assertActive,
      captureDelegatedToolPolicyAssertion(input.cfg, input.delegatedToolPolicy),
    ]),
  };
  const { subagentRole, ...admissionPatch } = params.admissionPatch ?? {};
  const initialChildSessionPatch: Partial<InternalSessionEntry> = {
    ...admissionPatch,
    ...(subagentRole ? { subagentRole } : {}),
    inheritedToolPolicyVersion: 1,
    ...(params.delegatedToolPolicy ? { delegatedToolPolicy: params.delegatedToolPolicy } : {}),
    ...(params.inheritedToolPolicySource
      ? { inheritedToolPolicySource: params.inheritedToolPolicySource }
      : {}),
    ...inheritedToolAllowPatch(params.inheritedToolAllowlist),
    ...inheritedToolDenyPatch(params.inheritedToolDenylist),
    ...params.modelPatch,
    ...(params.collect ? { swarmCollector: true } : {}),
    ...(params.outputSchema ? { swarmOutputSchema: params.outputSchema } : {}),
    ...(params.incognito ? { incognito: true } : {}),
  };
  // Navigation and control lineage commit with the creation stamp so a
  // launch failure cannot leave a durable but parentless child row.
  for (const [key, raw] of [
    ["spawnedBy", params.requesterInternalKey],
    ["completionOwnerSessionKey", params.completionOwnerSessionKey],
    ["parentSessionKey", params.requesterInternalKey],
    ["spawnedWorkspaceDir", params.worktree ? undefined : params.spawnedWorkspaceDir],
    ["spawnedCwd", params.worktree ? undefined : params.spawnedCwd],
    ["swarmGroupId", params.swarmGroupId],
  ] as const) {
    const value = normalizeOptionalString(raw);
    if (value) {
      initialChildSessionPatch[key] = value;
    }
  }
  try {
    return await withSubagentSessionSource(
      {
        agentId: params.requesterAgentId,
        sessionKey: params.requesterInternalKey,
        assertCurrent: params.assertActive,
      },
      async (parentMemory) => {
        let childMemory: SessionActorStorageBinding | undefined;
        try {
          const parentTarget = params.parentTarget;
          const parentStorePath = parentTarget.readSource?.path ?? parentTarget.storePath;
          // Request preparation joined participant writes and captured this complete row.
          const parentEntry = parentTarget.store[parentTarget.canonicalKey];
          if (params.firstAdmission) {
            const group = resolveAgentSessionGroup({
              sessionKey: params.childSessionKey,
              spawnedBy: params.requesterInternalKey,
              stored: {},
              inherited: normalizeTrustedGroupMetadata(parentEntry),
              requested: params.firstAdmission.group,
            });
            const now = Date.now();
            Object.assign(initialChildSessionPatch, {
              sessionStartedAt: now,
              lastInteractionAt: now,
              delivery: normalizeSessionDeliveryState({ context: params.firstAdmission.delivery }),
              groupId: group.groupId,
              groupChannel: group.groupChannel,
              space: group.groupSpace,
            });
          }
          const parentLineage = captureSpawnParentLineage({
            parentEntry,
            expectedParentSessionId: params.expectedParentSessionId,
            senderIsOwner: params.senderIsOwner,
          });
          if (params.incognito) {
            const assertCurrent = () => {
              params.assertActive?.();
              parentMemory?.actor.assertReadable();
              parentMemory?.authority.assertCurrent();
            };
            childMemory = await acquireSessionActorStorage(
              {
                agentId: params.targetAgentId,
                sessionKey: params.childSessionKey,
                sessionActor: parentMemory,
              },
              {
                create: true,
                lifetime: { assertCurrent, assertReadable: assertCurrent },
                authority: { assertCurrent, authorize() {} },
              },
            );
            if (!childMemory) {
              throw new Error("Incognito child actor is unavailable");
            }
          }
          // Spawn owns a fresh child lifecycle. Cleanup freezes both fields before
          // launch so it cannot delete a reset successor that reuses the session id.
          const childSessionIdentity = {
            sessionId: randomUUID(),
            lifecycleRevision: randomUUID(),
          };
          const target: Omit<GatewaySessionStoreTargetWithStore, "store"> = params.incognito
            ? {
                agentId: params.targetAgentId,
                canonicalKey: params.childSessionKey,
                storeKeys: [params.childSessionKey],
                storePath:
                  childMemory?.path ??
                  resolveIncognitoOpenClawAgentSqlitePath({
                    agentId: params.targetAgentId,
                  }),
              }
            : await resolveGatewaySessionStoreTargetInWorker({
                cfg: params.cfg,
                key: params.childSessionKey,
                assertActive: params.assertActive,
              });
          params.assertActive?.();
          let preparedWorktree: PreparedGatewaySessionLifecycle | undefined;
          if (params.worktree) {
            const projectId = params.worktree.projectId;
            if (projectId && params.spawnedCwd) {
              throw new Error("projectId cannot be combined with cwd");
            }
            const project = projectId
              ? await resolveSessionProjectRoot(params.cfg, projectId, true)
              : undefined;
            params.assertActive?.();
            if (project && !project.ok) {
              throw new Error(project.error.message);
            }
            const prepared = await prepareSessionWorktreeCreation({
              cfg: params.cfg,
              target: {
                agentId: target.agentId,
                key: target.canonicalKey,
                storePath: target.readSource?.path ?? target.storePath,
                projectId,
                sandboxRequired: params.creationPolicy.sandbox === "required",
              },
              workspace: project?.value ?? params.spawnedCwd,
              inheritParentKey:
                !projectId && !params.spawnedCwd && parentTarget.agentId === params.targetAgentId
                  ? params.requesterInternalKey
                  : undefined,
              name: params.worktree.worktreeName,
              baseRef: params.worktree.worktreeBaseRef,
              deferWorktree: true,
              label: params.label,
              titleSource: buildDashboardSessionTitleSource({ message: params.worktree.task }),
              useRequestedTitleSelection: false,
              runSetupScript: false,
              commitGuard: composeSessionSourceAssertion([params.assertActive]),
              onTitleError: (error) => console.warn("subagent worktree title failed", error),
              onTitlePersisted: () =>
                emitSessionLifecycleEvent({
                  sessionKey: params.childSessionKey,
                  reason: "title",
                }),
            });
            if (!prepared.ok) {
              throw new Error(prepared.error.message);
            }
            preparedWorktree = prepared.value;
            initialChildSessionPatch.projectId = projectId;
            initialChildSessionPatch.pendingWorktree = preparedWorktree.pendingWorktree;
          }
          const commit = async (assertSourceCurrent?: SessionSourceAssertion) => {
            const fields = ["sessionId", "lifecycleRevision", "skillLibrarySelections"] as const;
            const expected =
              parentEntry && (parentMemory || parentEntry.skillLibrarySelections)
                ? {
                    sessionId: parentEntry.sessionId,
                    lifecycleRevision: parentEntry.lifecycleRevision,
                    skillLibrarySelections: parentEntry.skillLibrarySelections,
                  }
                : undefined;
            const refuse = (): never => {
              throw new Error(
                "Parent skill selection changed before spawn; retry from the current turn.",
              );
            };
            const assertParentSkills = () => {
              if (!parentMemory) {
                return;
              }
              const latest = parentMemory
                ? parentMemory.actor.snapshot(parentMemory.authority)?.entry
                : undefined;
              if (
                (latest === undefined) !== (expected === undefined) ||
                fields.some((field) => !isDeepStrictEqual(latest?.[field], expected?.[field]))
              ) {
                refuse();
              }
            };
            const source: SessionSourceAssertion | undefined = parentMemory
              ? assertParentSkills
              : expected
                ? captureSessionEntrySourceAssertion({
                    scope: {
                      agentId: parentTarget.agentId,
                      storePath: parentStorePath,
                      sessionKey: parentTarget.canonicalKey,
                    },
                    readSource: parentTarget.capturedReadSource,
                    expected,
                    fields,
                    assertCurrent: assertParentSkills,
                    refuse,
                  })
                : undefined;
            const write = () =>
              upsertSessionEntryCore(
                {
                  storePath: target.readSource?.path ?? target.storePath,
                  sessionKey: target.canonicalKey,
                },
                {
                  ...initialChildSessionPatch,
                  // Native spawn keeps agent RPC label semantics, not sessions.patch's uniqueness policy.
                  ...(params.label ? { label: params.label } : {}),
                  ...(params.sessionPermissionPolicy
                    ? {
                        permissionMode: params.sessionPermissionPolicy.mode,
                        ...(!params.worktree
                          ? {
                              sessionRoot: resolveUserPath(
                                params.inheritedToolPolicySource === "sender"
                                  ? params.sessionPermissionPolicy.root
                                  : (params.spawnedWorkspaceDir ??
                                      params.sessionPermissionPolicy.root),
                              ),
                            }
                          : {}),
                      }
                    : {}),
                  ...childSessionIdentity,
                  // Stamp after all request patches so model input cannot create a grant.
                  ...parentLineage,
                  ...(parentEntry?.skillLibrarySelections
                    ? {
                        skillLibrarySelections: parentEntry.skillLibrarySelections.map(
                          (selection) => ({
                            ...selection,
                          }),
                        ),
                      }
                    : {}),
                  ...buildSessionCreationStamp({
                    via: "spawn",
                    ...params.creationPolicy,
                    ...(!params.incognito
                      ? {
                          inheritedGitContributorProfileIds:
                            inheritSessionGitContributorProfileIds(parentEntry),
                        }
                      : {}),
                  }),
                },
                sessionEntryCommitGuardOptions(
                  composeSessionSourceAssertion([params.assertActive, source, assertSourceCurrent]),
                ),
              );
            return childMemory
              ? await runWithSessionActorStorage(childMemory, write)
              : await write();
          };
          const entry = preparedWorktree?.withCommit
            ? await preparedWorktree.withCommit(commit)
            : await commit();
          return {
            status: "ok" as const,
            entry: entry ?? undefined,
            ...(params.firstAdmission && entry
              ? {
                  freshChild: {
                    agentId: target.agentId,
                    // Lifecycle admission uses the store selector, not the physical database path.
                    storePath: target.storePath,
                    entry,
                  },
                }
              : {}),
          };
        } finally {
          await childMemory?.actor.release();
        }
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return { status: "error", error: `child session patch failed: ${message}` };
  }
}
