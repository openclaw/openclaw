import { expectDefined } from "@openclaw/normalization-core/expect";
import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import type { SqliteLifecycleTargetSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import type { SessionEntryCanonicalReplacement } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { recordSessionStatusModelPatchOutcome } from "../session-model-patch-origin.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import * as sessionUnreadAck from "./session-unread-ack.js";
import {
  prepareSessionPatchArchive,
  prepareSessionPatchArchiveTransition,
  releaseSessionPatchArchive,
  validateSessionPatchArchiveProjection,
} from "./sessions-patch-archive.js";
import {
  createSessionPatchCatalogPreparation,
  type SessionPatchCatalogResult,
} from "./sessions-patch-catalog-preparation.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import * as patchEffects from "./sessions-patch-effects.js";
import {
  assertSessionPatchCommitAllowed,
  invalidSessionPatchOutcome,
  sessionChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import * as sessionPatchExpectations from "./sessions-patch-expectations.js";
import * as modelSelection from "./sessions-patch-model-selection.js";
import {
  prepareSessionPatchReplacement,
  createSessionPatchGroupWriter,
} from "./sessions-patch-replacement.js";
import type {
  GroupMutationOperation,
  MutationCoreResult,
  MutationOutcome,
  MutationTarget,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { preparePersonalModelSelection } from "./users-model-account-access.js";

type PatchTargetIdentity = sessionUnreadAck.SessionPatchTargetIdentity;
const { resolveSessionUnreadAck, validateSessionUnreadAck } = sessionUnreadAck;

type ArchiveTransition = Awaited<ReturnType<typeof prepareSessionPatchArchiveTransition>>;

export async function executeSessionPatchMutations(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  diagnostics?: SessionPatchDiagnostics;
  operatorAuthority?: Promise<{ authority: AdmittedRunOperatorAuthority } | undefined>;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  targets: readonly MutationTarget[];
}): Promise<MutationCoreResult> {
  const { client } = params;
  const timing = params.diagnostics?.scope("preflight");
  let personalModelSelection: UserModelAccountSelection | undefined;
  try {
    personalModelSelection = preparePersonalModelSelection(params, params.patch.model);
  } catch (error) {
    return { ok: false, error: unexpectedPatchError(params.targets[0]?.key ?? "", error) };
  }
  const getCurrentConfig = params.context.getRuntimeConfig;
  const cfg = getCurrentConfig();
  const operatorCreation = resolveOperatorSessionCreation(client);
  const sandbox = resolveCreatorSandbox(cfg, operatorCreation);
  const creation = { ...operatorCreation, ...(sandbox ? { sandbox } : {}) };
  const archiveActor = gatewayClientSessionCreator(client);
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const callerIsAdmin = client === null || callerScopes.includes(ADMIN_SCOPE);
  const pluginOwnerId = client?.internal?.pluginRuntimeOwnerId;
  const targetDiscoveryCache = new Map();
  const preflightTargets = params.targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });
  const logicalTargets = new Set<string>();
  for (const { key, resolved } of preflightTargets) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return invalidSessionPatchOutcome("Duplicate target.");
    }
    logicalTargets.add(logicalId);
  }

  const outcomes = Array.from<MutationOutcome | undefined>({ length: params.targets.length });
  const permissionErrors = new Map<number, ErrorShape>();
  const prepared: PreparedPatchTarget[] = [];
  const preparedByIndex = Array.from<PreparedPatchTarget | undefined>({
    length: params.targets.length,
  });
  for (const [index, { input, key, requestedAgent, resolved }] of preflightTargets.entries()) {
    const unreadAckError = validateSessionUnreadAck(params.patch, input);
    if (unreadAckError) {
      outcomes[index] = invalidSessionPatchOutcome(unreadAckError);
      continue;
    }
    if (!requestedAgent.ok) {
      outcomes[index] = requestedAgent;
      continue;
    }
    if (!resolved) {
      outcomes[index] = invalidSessionPatchOutcome("Session target could not be resolved.");
      continue;
    }
    const requestedAgentId = requestedAgent.agentId;
    const canonicalKey = resolved.canonicalKey ?? key;
    const candidateKeys = resolved.storeKeys;
    let initialEntry: SessionEntry | undefined;
    try {
      initialEntry = resolveCanonicalSessionEntryFromStoreKeys(resolved.store, [...candidateKeys]);
    } catch (error) {
      outcomes[index] = { ok: false, error: unexpectedPatchError(key, error) };
      continue;
    }
    const creationError =
      !initialEntry && authorizeGatewaySessionCreation({ cfg, client, agentId: resolved.agentId });
    if (creationError) {
      outcomes[index] = { ok: false, error: creationError };
      continue;
    }
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: initialEntry,
      key: canonicalKey,
      pluginOwnerId,
    });
    if (ownershipError) {
      outcomes[index] = { ok: false, error: ownershipError };
      continue;
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      canonicalKey,
      initialEntry,
    );
    if (missingHarnessSessionError) {
      outcomes[index] = invalidSessionPatchOutcome(missingHarnessSessionError);
      continue;
    }
    // Commit guards are core control state; construct the protocol patch from
    // its public identity fields so closures can never reach hooks or entries.
    const { commitGuard: _commitGuard, ...identity } = input;
    const fullPatch: SessionsPatchParams = { ...params.patch, ...identity };
    const expectationError =
      sessionPatchExpectations.resolveSessionPatchExpectationError(fullPatch);
    if (expectationError) {
      outcomes[index] = invalidSessionPatchOutcome(expectationError);
      continue;
    }
    let initialPlacementPatchError: string | undefined;
    try {
      initialPlacementPatchError = resolveSessionWorkerPlacementPatchError({
        agentId: resolved.agentId,
        cfg,
        context: params.context,
        entry: initialEntry,
        key,
        patch: fullPatch,
        sessionKey: canonicalKey,
        validateModelRuntime: false,
      });
    } catch (error) {
      outcomes[index] = { ok: false, error: unexpectedPatchError(key, error) };
      continue;
    }
    if (initialPlacementPatchError) {
      outcomes[index] = invalidSessionPatchOutcome(initialPlacementPatchError);
      continue;
    }
    const lifecycleIdentities = Array.from(
      new Set([key, canonicalKey, ...candidateKeys, initialEntry?.sessionId]),
    );
    const preparedTarget: PreparedPatchTarget = {
      archiveActor,
      canonicalKey,
      fullPatch,
      index,
      ...(initialEntry ? { initialEntry } : {}),
      initialStoreKeys: [...candidateKeys],
      key,
      lifecycleIdentities,
      ...(requestedAgentId ? { requestedAgentId } : {}),
      storePath: resolved.storePath,
      targetAgentId: resolved.agentId,
    };
    prepared.push(preparedTarget);
    preparedByIndex[index] = preparedTarget;
  }

  const mutationTargets = params.targets.map((target) => ({ ...target }));
  const originalCommitGuards = mutationTargets.map((target) => target.commitGuard);
  await using preparation = await sessionPatchExpectations.prepareSessionPatchTargets({
    cfg,
    getCurrentConfig,
    prepared,
    mutationTargets,
    originalCommitGuards,
    outcomes,
    operatorAuthority: params.operatorAuthority,
    personalModelSelection,
  });
  const { operatorAuthority, prepared: activePrepared } = preparation;
  const permissionRuntime =
    "permissionMode" in params.patch
      ? await import("./sessions-patch-permissions.runtime.js")
      : undefined;
  const sandboxRuntime =
    "sandboxMode" in params.patch || "nativeRuntimeConsent" in params.patch
      ? await import("./sessions-patch-sandbox.runtime.js")
      : undefined;

  const catalogs = createSessionPatchCatalogPreparation(
    (agentId) => params.context.loadGatewayModelCatalogSnapshot({ agentId }),
    params.diagnostics,
  );

  if (activePrepared.length > 0) {
    const releaseArchiveDrains = async () =>
      activePrepared.forEach((target) => releaseSessionPatchArchive(target.archivePreparation));
    try {
      // Cloud reclaim precedes every mutation mutex; an earlier Move may need one.
      timing?.mark("archive");
      await Promise.all(
        activePrepared
          .filter((target) => target.fullPatch.archived === true)
          .map(async (target) => {
            try {
              const result = await prepareSessionPatchArchive({
                cfg,
                commitGuard: mutationTargets[target.index]!.commitGuard,
                context: params.context,
                loadGatewayModelCatalogSnapshot: () => catalogs.load(target.targetAgentId),
                personalModelSelection,
                ...(pluginOwnerId ? { pluginOwnerId } : {}),
                target,
              });
              if (result.ok) {
                target.archivePreparation = result.value;
              } else {
                outcomes[target.index] = result;
              }
            } catch (error) {
              outcomes[target.index] = {
                ok: false,
                error: unexpectedPatchError(target.key, error),
              };
            }
          }),
      );
      timing?.mark("lifecycleAdmission");
      await runExclusiveSessionLifecycleMutation({
        targets: activePrepared.map((target) => ({
          scope: target.storePath,
          identities: target.lifecycleIdentities,
        })),
        prepare: async () => {
          for (const target of activePrepared) {
            target.archivePreparation?.drain.handoffToMutation();
          }
        },
        finalize: releaseArchiveDrains,
        run: async () => {
          timing?.mark();
          try {
            const groups = new Map<string, PreparedPatchTarget[]>();
            for (const target of activePrepared) {
              if (target.fullPatch.archived === true && !target.archivePreparation) {
                continue;
              }
              const groupKey = `${target.storePath}\0${target.targetAgentId}`;
              const group = groups.get(groupKey) ?? [];
              group.push(target);
              groups.set(groupKey, group);
            }
            await Promise.all(
              [...groups.values()].map(async (group) => {
                const first = group[0]!;
                const storage = preparation.storage.get(first.index);
                const groupTiming = params.diagnostics?.scope("snapshot");
                try {
                  // Keep every resolver candidate for queued alias revalidation. Label
                  // uniqueness needs only the requested label's owners, not the full store.
                  const selectedSessionKeys = group.flatMap((target) => [
                    target.key,
                    target.canonicalKey,
                    ...target.initialStoreKeys,
                  ]);
                  const archiveTransitions = new Map<number, ArchiveTransition>();
                  const commitGuards = new Set<() => ErrorShape | undefined>();
                  const originalGuards = group.map(({ index }) =>
                    expectDefined(originalCommitGuards[index], "original patch guard"),
                  );
                  const assertCommitAllowed = () => {
                    operatorAuthority?.assertCurrent();
                    assertSessionPatchCommitAllowed({
                      personalModelSelection,
                      guards: commitGuards.size ? commitGuards : originalGuards,
                      archiveTransitions: archiveTransitions.values(),
                    });
                    storage?.assertCurrent();
                  };
                  const projectGroup = async (
                    entries: SqliteLifecycleTargetSnapshot,
                    admission: "admitted" | "detached",
                    catalogPreparation?: SessionPatchCatalogResult,
                  ): Promise<GroupMutationOperation> => {
                    const workingStore = Object.fromEntries(
                      entries.flatMap(({ entry, sessionKey }) =>
                        isInternalSessionEffectsKey(sessionKey)
                          ? []
                          : [[sessionKey, entry] as const],
                      ),
                    );
                    const labelOwners = new SessionLabelOwnerIndex(workingStore);
                    const replacements: SessionEntryCanonicalReplacement[] = [];
                    const projectedOutcomes: MutationOutcome[] = [];
                    for (const target of group) {
                      try {
                        if (params.operatorAuthority) {
                          assertSessionPatchCommitAllowed({
                            personalModelSelection,
                            guards: [
                              expectDefined(
                                originalCommitGuards[target.index],
                                "original patch guard",
                              ),
                            ],
                            archiveTransitions: [],
                          });
                          operatorAuthority?.assertCurrent();
                        }
                        // Preflight facts can stale behind the writer queue; resolve this snapshot
                        // again so a new legacy alias is rejected rather than promoted or deleted.
                        const {
                          entry: existingEntry,
                          primaryKey,
                          target: currentTarget,
                        } = resolveCanonicalGatewaySessionStoreKey({
                          cfg,
                          key: target.key,
                          store: workingStore,
                          ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
                        });
                        const creationError =
                          !existingEntry &&
                          authorizeGatewaySessionCreation({
                            cfg,
                            client,
                            agentId: target.targetAgentId,
                          });
                        if (creationError) {
                          projectedOutcomes.push({ ok: false, error: creationError });
                          continue;
                        }
                        const candidateKeys = currentTarget.storeKeys;
                        const ownershipError = resolvePluginSessionOwnershipError({
                          action: "patch",
                          entry: existingEntry,
                          key: primaryKey,
                          pluginOwnerId,
                        });
                        if (ownershipError) {
                          projectedOutcomes.push({ ok: false, error: ownershipError });
                          continue;
                        }
                        // Compare tool policy against the captured snapshot; the final
                        // commit rejects a selection changed during preparation.
                        const expectationError =
                          sessionPatchExpectations.resolveSessionPatchTargetError(
                            existingEntry,
                            target,
                          );
                        if (expectationError) {
                          projectedOutcomes.push({ ok: false, error: expectationError });
                          continue;
                        }
                        if (params.operatorAuthority) {
                          const authorizationError = mutationTargets[target.index]!.commitGuard();
                          if (authorizationError) {
                            projectedOutcomes.push({ ok: false, error: authorizationError });
                            continue;
                          }
                        }
                        if (target.fullPatch.archived === true) {
                          const archiveError = validateSessionPatchArchiveProjection({
                            cfg,
                            existingEntry,
                            fullPatch: target.fullPatch,
                            key: target.key,
                            ...(pluginOwnerId ? { pluginOwnerId } : {}),
                            preparation: target.archivePreparation!,
                            primaryKey,
                          });
                          if (archiveError) {
                            projectedOutcomes.push({ ok: false, error: archiveError });
                            continue;
                          }
                        }
                        const unreadAck = resolveSessionUnreadAck(existingEntry, target.fullPatch);
                        if (unreadAck.kind === "missing") {
                          projectedOutcomes.push({
                            ok: false,
                            error: sessionChangedError(target.key),
                          });
                          continue;
                        }
                        if (unreadAck.kind === "stale") {
                          const authorizationFailure = mutationTargets[target.index]!.commitGuard();
                          if (authorizationFailure) {
                            projectedOutcomes.push({ ok: false, error: authorizationFailure });
                            continue;
                          }
                          // A newer explicit marker owns the session until a later activation.
                          projectedOutcomes.push({
                            ok: true,
                            applied: false,
                            accessChanged: false,
                            entry: unreadAck.entry,
                          });
                          continue;
                        }
                        const projection = await catalogs.project({
                          agentId: target.targetAgentId,
                          // Detached preparation must not replay earlier restoration or
                          // permission owners when a later target needs the catalog.
                          mode:
                            admission === "admitted" || group.length === 1 ? "prepare" : "ordered",
                          catalog: catalogPreparation,
                          projection: {
                            cfg,
                            creation,
                            existingEntry,
                            isLabelInUse: (label) => labelOwners.isLabelInUse(label, candidateKeys),
                            storeKey: primaryKey,
                            agentId: target.requestedAgentId,
                            patch: target.fullPatch,
                            archivedBy: archiveActor,
                            personalModelSelection,
                            operatorAuthority,
                          },
                        });
                        if (projection.kind === "model-catalog") {
                          // Nothing has committed. Release provisional permission handles
                          // with this writer snapshot, then project again from fresh rows.
                          return { result: projection };
                        }
                        const projected = projection.result;
                        if (!projected.ok) {
                          projectedOutcomes.push(projected);
                          continue;
                        }
                        const validateSandbox = sandboxRuntime
                          ? () =>
                              sandboxRuntime.validateSessionPatchSandboxChange({
                                client,
                                context: params.context,
                                patch: target.fullPatch,
                                existingEntry,
                                entry: projected.entry,
                                sessionKey: primaryKey,
                                storePath: target.storePath,
                                lifecycleIdentities: target.lifecycleIdentities,
                              })
                          : undefined;
                        const sandboxError = validateSandbox?.();
                        if (sandboxError) {
                          projectedOutcomes.push({ ok: false, error: sandboxError });
                          continue;
                        }
                        const runtimeSelection =
                          await modelSelection.prepareSessionPatchRuntimeSelection({
                            cfg,
                            agentId: target.targetAgentId,
                            patch: target.fullPatch,
                            entry: projected.entry,
                            expectedEntry: existingEntry,
                            callerCanConsent: callerIsAdmin,
                            catalog: (await catalogs.available(target.targetAgentId))?.entries,
                            validateModelSelection: projected.validateModelSelection,
                            placement: { context: params.context, sessionKey: primaryKey },
                          });
                        if (!runtimeSelection.ok) {
                          projectedOutcomes.push(runtimeSelection);
                          continue;
                        }
                        const authorizationFailure = mutationTargets[target.index]!.commitGuard();
                        if (authorizationFailure) {
                          projectedOutcomes.push({ ok: false, error: authorizationFailure });
                          continue;
                        }
                        if (
                          existingEntry &&
                          typeof target.fullPatch.archived === "boolean" &&
                          (existingEntry.worktree ||
                            existingEntry.archivedAt !== undefined ||
                            target.fullPatch.archived)
                        ) {
                          const worktreeTiming = params.diagnostics?.scope("worktree");
                          let transition: ArchiveTransition;
                          try {
                            transition = await prepareSessionPatchArchiveTransition({
                              archived: target.fullPatch.archived,
                              entry: existingEntry,
                              context: params.context,
                              scope: {
                                agentId: target.targetAgentId,
                                sessionKey: primaryKey,
                                storePath: target.storePath,
                              },
                              authorize: mutationTargets[target.index]!.commitGuard,
                              preparation: target.archivePreparation,
                            });
                          } finally {
                            worktreeTiming?.finish();
                          }
                          archiveTransitions.set(target.index, transition);
                        }
                        if (permissionRuntime && existingEntry?.sessionId) {
                          const permission = permissionRuntime.prepareSessionPatchPermissionChange({
                            context: params.context,
                            sessionId: existingEntry.sessionId,
                            sessionKey: target.canonicalKey,
                            agentId: target.targetAgentId,
                            assertCurrent: mutationTargets[target.index]!.commitGuard,
                          });
                          if (!permission.ok) {
                            projectedOutcomes.push(permission);
                            continue;
                          }
                          target.permissionChange = permission.change;
                        }
                        commitGuards.add(mutationTargets[target.index]!.commitGuard);
                        if (validateSandbox) {
                          commitGuards.add(validateSandbox);
                        }
                        if (runtimeSelection.validate) {
                          commitGuards.add(runtimeSelection.validate);
                        }
                        const replacement = prepareSessionPatchReplacement({
                          existingEntry,
                          projectedEntry: projected.entry,
                          primaryKey,
                          canonicalKey: target.canonicalKey,
                          candidateKeys,
                          workingStore,
                          labelOwners,
                          assertCurrent: assertCommitAllowed,
                        });
                        if (replacement.replacement) {
                          replacements.push(replacement.replacement);
                        }
                        projectedOutcomes.push(replacement.outcome);
                      } catch (error) {
                        projectedOutcomes.push({
                          ok: false,
                          error: unexpectedPatchError(target.key, error),
                        });
                      }
                    }
                    return {
                      replacements,
                      result: { kind: "complete", outcomes: projectedOutcomes },
                    };
                  };
                  const groupStore = {
                    ...(storage ? { env: storage.env, retainedExecution: storage.execution } : {}),
                    afterCommitted: patchEffects.createSessionPatchCategoryRegistration(params),
                    assertCommitAllowed,
                    agentId: first.targetAgentId,
                    sessionKeys: selectedSessionKeys,
                    storePath: first.storePath,
                    skipMaintenance: true,
                  };
                  const applyGroup = createSessionPatchGroupWriter({
                    store: groupStore,
                    patch: first.fullPatch,
                    project: projectGroup,
                    timing: groupTiming,
                  });
                  let result = await applyGroup();
                  if (result.kind === "model-catalog") {
                    for (const target of group) {
                      target.permissionChange?.finish();
                      target.permissionChange = undefined;
                    }
                    commitGuards.clear();
                    archiveTransitions.clear();
                    groupTiming?.mark();
                    const catalog = await catalogs.prepare(first.targetAgentId);
                    result = await applyGroup(catalog);
                  }
                  if (result.kind !== "complete") {
                    throw new Error("Session patch catalog preparation did not complete");
                  }
                  const groupOutcomes = result.outcomes;
                  for (const [groupIndex, target] of group.entries()) {
                    const outcome = groupOutcomes[groupIndex]!;
                    outcomes[target.index] = outcome;
                    if (outcome.ok) {
                      recordSessionStatusModelPatchOutcome(outcome.applied);
                    }
                    if (outcome.ok && outcome.applied) {
                      modelSelection.refreshSessionPatchQueuedSelection({
                        cfg,
                        entry: outcome.entry,
                        patch: target.fullPatch,
                        sessionKey: target.canonicalKey,
                        agentId: target.targetAgentId,
                        catalog: (await catalogs.available(target.targetAgentId))?.entries,
                      });
                    }
                    const afterCommit = archiveTransitions.get(target.index)?.afterCommit;
                    if (outcome.ok && outcome.applied && afterCommit) {
                      groupTiming?.mark("worktreeCleanup");
                      await afterCommit(outcome.entry);
                    }
                  }
                } catch (error) {
                  for (const target of group) {
                    outcomes[target.index] = {
                      ok: false,
                      error: unexpectedPatchError(target.key, error),
                    };
                  }
                } finally {
                  groupTiming?.finish();
                }
              }),
            );
            // Keep runtime acknowledgement in the mutation lane. A second browser
            // must not persist a newer mode and then have this older update win.
            timing?.mark("permissions");
            for (const target of activePrepared) {
              const outcome = outcomes[target.index];
              if (!target.permissionChange || !outcome?.ok || !outcome.applied) {
                continue;
              }
              const error = await target.permissionChange.apply(
                outcome.entry.permissionMode ?? null,
              );
              if (error) {
                permissionErrors.set(target.index, error);
              }
            }
          } finally {
            timing?.mark("lifecycleFinalize");
          }
        },
      });
    } finally {
      timing?.mark("cleanup");
      for (const target of activePrepared) {
        target.permissionChange?.finish();
      }
      await releaseArchiveDrains();
    }
  }

  timing?.mark("effects");
  await patchEffects.publishSessionPatchEffects({
    cfg,
    context: params.context,
    callerScopes,
    callerCanManageCron: callerIsAdmin,
    targets: activePrepared.flatMap((target) => {
      const outcome = outcomes[target.index];
      return outcome?.ok && outcome.applied
        ? [{ target, entry: outcome.entry, accessChanged: outcome.accessChanged }]
        : [];
    }),
  });
  timing?.finish();

  // Runtime application can fail after commit. Publish every saved field's
  // normal effects before returning the application error to the caller.
  for (const [index, error] of permissionErrors) {
    outcomes[index] = { ok: false, error };
  }
  return {
    ok: true,
    cfg,
    outcomes: outcomes as MutationOutcome[],
    preparedByIndex,
    catalogs,
  };
}
