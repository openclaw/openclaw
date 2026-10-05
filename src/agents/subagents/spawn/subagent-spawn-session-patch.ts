import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildSessionCreationStamp,
  inheritSessionGitContributorProfileIds,
} from "../../../config/sessions/session-entry-provenance.js";
import type { PreparedSessionSourceAuthority } from "../../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { buildDashboardSessionTitleSource } from "../../../gateway/dashboard-session-title.js";
import type { PreparedGatewaySessionLifecycle } from "../../../gateway/session-create-service.types.js";
import type { GatewaySessionStoreTargetWithStore } from "../../../gateway/session-utils-store.types.js";
import {
  prepareSessionWorktreeCreation,
  resolveSessionProjectRoot,
} from "../../../gateway/session-worktree-preparation.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../../infra/sqlite-worker-identity.js";
import { waitForSessionParticipantRecording } from "../../../sessions/session-participant-recording.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { resolveUserPath } from "../../../utils.js";
import { inheritedToolAllowPatch, inheritedToolDenyPatch } from "../../inherited-tool-deny.js";
import type { resolveSpawnAdmission } from "../../spawn-plan.js";
import type { PreparedSessionPermissionPolicy } from "../../tool-fs-policy.types.js";
import { captureSpawnParentLineage } from "./spawn-parent-lineage.js";
import type { SpawnSubagentParams } from "./subagent-spawn-contract.js";
import { type resolveSubagentModelAndThinkingPlan, splitModelRef } from "./subagent-spawn-plan.js";
import {
  loadSessionEntry,
  emitSessionLifecycleEvent,
  resolveGatewaySessionStoreTargetInWorker,
  upsertSessionEntryCore,
  withSessionEntryReadOnlyInWorker,
} from "./subagent-spawn.runtime.js";

export async function createInitialSubagentSession(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  targetAgentId: string;
  childSessionKey: string;
  label?: string;
  incognito: boolean;
  requesterInternalKey: string;
  senderIsOwner?: boolean;
  expectedParentSessionId?: string;
  assertActive?: () => void;
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
  modelPatch: Partial<
    Extract<
      Awaited<ReturnType<typeof resolveSubagentModelAndThinkingPlan>>,
      { status: "ok" }
    >["initialSessionPatch"]
  >;
  swarmGroupId?: string;
  collect: boolean;
  outputSchema?: Record<string, unknown>;
}): Promise<{ status: "ok"; entry?: SessionEntry } | { status: "error"; error: string }> {
  const { subagentRole, ...admissionPatch } = params.admissionPatch ?? {};
  const {
    model: modelRef,
    modelOverrideSource,
    modelOverrideFallbackOriginProvider,
    modelOverrideFallbackOriginModel,
    ...modelPatch
  } = params.modelPatch;
  const { provider, model } = splitModelRef(modelRef);
  const fallbackOriginProvider = normalizeOptionalString(modelOverrideFallbackOriginProvider);
  const fallbackOriginModel = normalizeOptionalString(modelOverrideFallbackOriginModel);
  const initialChildSessionPatch: Partial<InternalSessionEntry> = {
    ...admissionPatch,
    ...(subagentRole ? { subagentRole } : {}),
    inheritedToolPolicyVersion: 1,
    ...(params.inheritedToolPolicySource
      ? { inheritedToolPolicySource: params.inheritedToolPolicySource }
      : {}),
    ...inheritedToolAllowPatch(params.inheritedToolAllowlist),
    ...inheritedToolDenyPatch(params.inheritedToolDenylist),
    ...modelPatch,
    ...(model
      ? {
          model,
          modelOverride: model,
          modelOverrideSource: modelOverrideSource === "auto" ? "auto" : "user",
          modelOverrideRouteResolution: "resolved",
          ...(provider ? { modelProvider: provider, providerOverride: provider } : {}),
          ...(fallbackOriginProvider && fallbackOriginModel
            ? {
                modelOverrideFallbackOriginProvider: fallbackOriginProvider,
                modelOverrideFallbackOriginModel: fallbackOriginModel,
              }
            : {}),
        }
      : {}),
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
    const parentTarget = await resolveGatewaySessionStoreTargetInWorker({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
      assertActive: params.assertActive,
    });
    const parentStorePath = parentTarget.readSource?.path ?? parentTarget.storePath;
    await waitForSessionParticipantRecording({
      agentId: parentTarget.agentId,
      sessionKey: parentTarget.canonicalKey,
      storePath: parentStorePath,
    });
    params.assertActive?.();
    // Parent rows are read on the session read worker, never on the Gateway thread.
    const readParentEntry = () =>
      withSessionEntryReadOnlyInWorker(
        {
          agentId: parentTarget.agentId,
          storePath: parentStorePath,
          sessionKey: parentTarget.canonicalKey,
        },
        () => params.assertActive?.(),
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          return read.value;
        },
      );
    const parentEntry = await readParentEntry();
    params.assertActive?.();
    const parentLineage = captureSpawnParentLineage({
      parentEntry,
      expectedParentSessionId: params.expectedParentSessionId,
      senderIsOwner: params.senderIsOwner,
      readParentEntry,
    });
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
          storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: params.targetAgentId }),
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
        commitGuard: () => params.assertActive?.(),
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
    const commit = async (assertSourceCurrent?: () => void) => {
      await parentLineage.assertParentUnchanged();
      const fields = ["sessionId", "lifecycleRevision", "skillLibrarySelections"] as const;
      const expected = parentEntry?.skillLibrarySelections
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
        if (!expected) {
          return;
        }
        const latest = loadSessionEntry({
          storePath: parentStorePath,
          sessionKey: parentTarget.canonicalKey,
        });
        if (!latest || fields.some((field) => !isDeepStrictEqual(latest[field], expected[field]))) {
          refuse();
        }
      };
      const source = expected
        ? Object.assign(assertParentSkills, {
            async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
              const identity = readDatabasePathIdentitySync(parentStorePath);
              if (!identity.key.startsWith("file:")) {
                return { nativeSource: true, assertCurrent: assertParentSkills, checks: [] };
              }
              return {
                assertCurrent: () =>
                  assertExistingDatabaseIdentity(parentStorePath, identity.key, identity.birthtime),
                checks: [
                  {
                    predicate: {
                      source: {
                        agentId: parentTarget.readSource?.agentId ?? parentTarget.agentId,
                        path: parentStorePath,
                        databaseIdentity: identity.key.slice("file:".length),
                        databaseBirthtime: identity.birthtime,
                      },
                      sessionKey: parentTarget.canonicalKey,
                      fields: [...fields],
                      expected,
                    },
                    refuse,
                  },
                ],
              };
            },
          })
        : undefined;
      return await upsertSessionEntryCore(
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
                          : (params.spawnedWorkspaceDir ?? params.sessionPermissionPolicy.root),
                      ),
                    }
                  : {}),
              }
            : {}),
          ...childSessionIdentity,
          // Stamp after all request patches so model input cannot create a grant.
          ...parentLineage.receipt,
          ...(parentEntry?.skillLibrarySelections
            ? {
                skillLibrarySelections: parentEntry.skillLibrarySelections.map((selection) => ({
                  ...selection,
                })),
              }
            : {}),
          ...buildSessionCreationStamp({
            via: "spawn",
            conversationLink: parentEntry?.conversationLink,
            ...params.creationPolicy,
            ...(!params.incognito
              ? {
                  inheritedGitContributorProfileIds:
                    inheritSessionGitContributorProfileIds(parentEntry),
                }
              : {}),
          }),
        },
        {
          workerGuard: { assertCurrent: params.assertActive, source },
          // Worktree source checks still own native session/registry reads.
          ...(assertSourceCurrent ? { assertCommitAllowed: assertSourceCurrent } : {}),
        },
      );
    };
    const entry = preparedWorktree?.withCommit
      ? await preparedWorktree.withCommit(commit)
      : await commit();
    return { status: "ok", entry: entry ?? undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return { status: "error", error: `child session patch failed: ${message}` };
  }
}
