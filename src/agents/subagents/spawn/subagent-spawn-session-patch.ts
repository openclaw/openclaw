import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { preserveSqliteSameKeySessionRolloverLineage } from "../../../config/sessions/session-entry-lineage.js";
import {
  buildSessionCreationStamp,
  inheritSessionGitContributorProfileIds,
} from "../../../config/sessions/session-entry-provenance.js";
import { mergeSessionEntry, type SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../../../gateway/session-sharing-preparation.js";
import { waitForSessionParticipantRecording } from "../../../sessions/session-participant-recording.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { resolveUserPath } from "../../../utils.js";
import {
  parseInheritedToolPolicyV2,
  type InheritedToolPolicyV2,
} from "../../inherited-tool-policy.schema.js";
import type { PreparedSessionPermissionPolicy } from "../../tool-fs-policy.types.js";
import { resolvePersistedSubagentToolPolicyEnvelope } from "./subagent-capabilities.js";
import { splitModelRef } from "./subagent-spawn-plan.js";
import {
  applySessionEntryCanonicalReplacements,
  withSessionEntryReadOnlyInWorker,
  resolveGatewaySessionStoreTarget,
} from "./subagent-spawn.runtime.js";

function buildDirectChildSessionPatch(patch: Record<string, unknown>): Partial<SessionEntry> {
  const entry: Partial<SessionEntry> = {
    inheritedToolPolicyVersion: 2,
    inheritedToolPolicy: parseInheritedToolPolicyV2(patch.inheritedToolPolicy),
  };
  const spawnDepth = patch.spawnDepth;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth) && spawnDepth >= 0) {
    entry.spawnDepth = Math.floor(spawnDepth);
  }
  if (patch.subagentRole === "orchestrator" || patch.subagentRole === "leaf") {
    entry.subagentRole = patch.subagentRole;
  }
  if (patch.subagentControlScope === "children" || patch.subagentControlScope === "none") {
    entry.subagentControlScope = patch.subagentControlScope;
  }
  if (patch.incognito === true) {
    entry.incognito = true;
  }
  for (const key of [
    "spawnedBy",
    "completionOwnerSessionKey",
    "parentSessionKey",
    "spawnedWorkspaceDir",
    "spawnedCwd",
  ] as const) {
    const value = normalizeOptionalString(patch[key]);
    if (value) {
      entry[key] = value;
    }
  }
  if (typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()) {
    entry.thinkingLevel = patch.thinkingLevel.trim();
  }
  const authProfileOverride = normalizeOptionalString(patch.authProfileOverride);
  if (authProfileOverride) {
    entry.authProfileOverride = authProfileOverride;
    entry.authProfileOverrideSource = patch.authProfileOverrideSource === "auto" ? "auto" : "user";
  }
  if (patch.fastMode === true || patch.fastMode === false || patch.fastMode === "auto") {
    entry.fastMode = patch.fastMode;
  }
  if (typeof patch.swarmGroupId === "string" && patch.swarmGroupId.trim()) {
    entry.swarmGroupId = patch.swarmGroupId.trim();
  }
  if (patch.swarmCollector === true) {
    entry.swarmCollector = true;
  }
  if (patch.swarmOutputSchema && typeof patch.swarmOutputSchema === "object") {
    entry.swarmOutputSchema = patch.swarmOutputSchema as Record<string, unknown>;
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    const { provider, model } = splitModelRef(patch.model.trim());
    if (model) {
      entry.model = model;
      entry.modelOverride = model;
      entry.modelOverrideSource = patch.modelOverrideSource === "auto" ? "auto" : "user";
      entry.modelOverrideRouteResolution = "resolved";
      const fallbackOriginProvider = normalizeOptionalString(
        patch.modelOverrideFallbackOriginProvider,
      );
      const fallbackOriginModel = normalizeOptionalString(patch.modelOverrideFallbackOriginModel);
      if (fallbackOriginProvider && fallbackOriginModel) {
        entry.modelOverrideFallbackOriginProvider = fallbackOriginProvider;
        entry.modelOverrideFallbackOriginModel = fallbackOriginModel;
      }
      if (provider) {
        entry.modelProvider = provider;
        entry.providerOverride = provider;
      }
    }
  }
  return entry;
}

export async function createInitialSubagentSession(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  label?: string;
  incognito: boolean;
  requesterInternalKey: string;
  requesterAgentId: string;
  assertActive?: () => void;
  creationPolicy: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
  completionOwnerSessionKey: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  admissionPatch?: Record<string, unknown>;
  inheritedToolPolicy: InheritedToolPolicyV2;
  modelPatch: Record<string, unknown>;
  swarmGroupId?: string;
  collect: boolean;
  outputSchema?: Record<string, unknown>;
}): Promise<{ status: "ok"; entry?: SessionEntry } | { status: "error"; error: string }> {
  const initialChildSessionPatch: Record<string, unknown> = {
    spawnedBy: params.requesterInternalKey,
    completionOwnerSessionKey: params.completionOwnerSessionKey,
    // Navigation and control lineage commit with the creation stamp so a
    // launch failure cannot leave a durable but parentless child row.
    parentSessionKey: params.requesterInternalKey,
    ...(params.spawnedWorkspaceDir ? { spawnedWorkspaceDir: params.spawnedWorkspaceDir } : {}),
    ...(params.spawnedCwd ? { spawnedCwd: params.spawnedCwd } : {}),
    ...params.admissionPatch,
    ...params.modelPatch,
    inheritedToolPolicyVersion: 2,
    inheritedToolPolicy: params.inheritedToolPolicy,
    ...(params.swarmGroupId ? { swarmGroupId: params.swarmGroupId } : {}),
    ...(params.collect ? { swarmCollector: true } : {}),
    ...(params.outputSchema ? { swarmOutputSchema: params.outputSchema } : {}),
    ...(params.incognito ? { incognito: true } : {}),
  };
  try {
    const childSessionPatch = buildDirectChildSessionPatch(initialChildSessionPatch);
    resolvePersistedSubagentToolPolicyEnvelope(params.childSessionKey, {
      store: { [params.childSessionKey]: childSessionPatch },
      requiredVersion: 2,
    });
    const parentTarget = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
    });
    await waitForSessionParticipantRecording({
      agentId: parentTarget.agentId,
      sessionKey: parentTarget.canonicalKey,
      storePath: parentTarget.storePath,
    });
    params.assertActive?.();
    const parentScope = {
      agentId: parentTarget.agentId,
      storePath: parentTarget.storePath,
      sessionKey: parentTarget.canonicalKey,
    };
    return await withSessionEntryReadOnlyInWorker(
      parentScope,
      () => params.assertActive?.(),
      async (read, assertParentSourceCurrent) => {
        if (!read.ok) {
          throw read.error;
        }
        const parentEntry = read.value;
        const parentFacts = parentEntry?.skillLibrarySelections
          ? await prepareSessionMutationFacts({
              cfg: params.cfg,
              sessionKey: parentTarget.canonicalKey,
              agentId: parentTarget.agentId,
            })
          : undefined;
        const assertParentEntry = (
          latest:
            | Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "skillLibrarySelections">
            | undefined,
        ) => {
          if (
            parentEntry?.skillLibrarySelections &&
            (latest?.sessionId !== parentEntry.sessionId ||
              latest.lifecycleRevision !== parentEntry.lifecycleRevision ||
              JSON.stringify(latest.skillLibrarySelections) !==
                JSON.stringify(parentEntry.skillLibrarySelections))
          ) {
            throw new Error(
              "Parent skill selection changed before spawn; retry from the current turn.",
            );
          }
        };
        const assertCurrent = () => {
          params.assertActive?.();
          assertParentSourceCurrent();
          if (parentFacts) {
            assertParentEntry(parentFacts.readCurrent(params.cfg).target?.entry);
          }
        };
        try {
          assertCurrent();
          // Spawn owns a fresh child lifecycle. Cleanup freezes both fields before
          // launch so it cannot delete a reset successor that reuses the session id.
          const childSessionIdentity = {
            sessionId: randomUUID(),
            lifecycleRevision: randomUUID(),
          };
          const target = params.incognito
            ? {
                agentId: params.targetAgentId,
                canonicalKey: params.childSessionKey,
                storeKeys: [params.childSessionKey],
                storePath: resolveIncognitoOpenClawAgentSqlitePath({
                  agentId: params.targetAgentId,
                }),
              }
            : resolveGatewaySessionStoreTarget({
                cfg: params.cfg,
                key: params.childSessionKey,
              });
          const patch: Partial<SessionEntry> = {
            ...childSessionPatch,
            // Native spawn keeps agent RPC label semantics, not sessions.patch's uniqueness policy.
            ...(params.label ? { label: params.label } : {}),
            ...(params.sessionPermissionPolicy
              ? {
                  permissionMode: params.sessionPermissionPolicy.mode,
                  sessionRoot: resolveUserPath(
                    params.spawnedWorkspaceDir ?? params.sessionPermissionPolicy.root,
                  ),
                }
              : {}),
            ...childSessionIdentity,
            ...(parentEntry?.skillLibrarySelections
              ? {
                  skillLibrarySelections: parentEntry.skillLibrarySelections.map((selection) => ({
                    ...selection,
                  })),
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
          };
          const preparedParent = parentFacts?.readCurrent(params.cfg);
          const entry = await applySessionEntryCanonicalReplacements({
            agentId: target.agentId,
            storePath: target.storePath,
            activeSessionKey: target.canonicalKey,
            sessionKeys: [target.canonicalKey],
            skipMaintenance: false,
            deferMaintenance: true,
            maintainHistoryBudget: true,
            assertCommitAllowed: assertCurrent,
            ...(preparedParent?.databaseIdentity && preparedParent.target
              ? {
                  sameDatabasePreconditions: [
                    {
                      databaseIdentity: preparedParent.databaseIdentity,
                      sessionKey: preparedParent.target.storeKey,
                      expected: {
                        sessionId: preparedParent.target.entry.sessionId,
                        lifecycleRevision: preparedParent.target.entry.lifecycleRevision,
                        skillLibrarySelections: preparedParent.target.entry.skillLibrarySelections,
                      },
                    },
                  ],
                }
              : {}),
            // Refresh cross-store pins after planning. The final grants retain source
            // publication custody; only a shared physical database adds an atomic SQL check.
            withCommit: parentFacts
              ? (run) =>
                  withSessionEntryReadOnlyInWorker(
                    parentScope,
                    assertCurrent,
                    async (latest, assertReadCurrent) => {
                      if (!latest.ok) {
                        throw latest.error;
                      }
                      assertParentEntry(latest.value);
                      return await run(() => {
                        assertReadCurrent();
                        assertCurrent();
                      });
                    },
                  )
              : undefined,
            update: (entries) => {
              const previous = entries.find((row) => row.sessionKey === target.canonicalKey)?.entry;
              const merged = mergeSessionEntry(previous, patch);
              const next = previous
                ? preserveSqliteSameKeySessionRolloverLineage({
                    next: merged,
                    previous,
                    sessionKey: target.canonicalKey,
                  })
                : merged;
              return {
                result: next,
                replacements: [
                  { sessionKey: target.canonicalKey, previousSessionKeys: [], entry: next },
                ],
              };
            },
          });
          return { status: "ok" as const, entry };
        } finally {
          parentFacts?.release();
        }
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return { status: "error", error: `child session patch failed: ${message}` };
  }
}
