import { isDeepStrictEqual } from "node:util";
import {
  deleteSessionEntryLifecycle,
  patchSessionEntryCore as patchAccessorSessionEntry,
  rollbackAgentHarnessSessionEntryLifecycle,
  rollbackPluginOwnedSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { sessionInitializationFingerprint } from "../../config/sessions/session-entry-read-revision.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { sessionEntryCommitGuardOptions } from "../../config/sessions/session-source-authority.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import {
  captureSessionInitializationOwner,
  createSessionInitialization,
} from "../../sessions/session-initialization.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

export async function createRuntimeSessionEntry(
  params: Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0],
): Promise<Awaited<ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>>> {
  const source = captureIncognitoSessionSource({ sessionKey: params.key, agentId: params.agentId });
  const creationOwner = captureSessionInitializationOwner(
    "agentHarnessId" in params.initialEntry ? params.initialEntry.agentHarnessId : undefined,
  );
  // Session creation stays behind the canonical Gateway lifecycle boundary while
  // keeping that heavier runtime out of plugin discovery and cold startup.
  const [
    { createGatewaySession },
    { resolveGatewaySessionStoreTargetInWorker },
    { readAcpSessionMetaForEntry },
    { upsertAcpSessionMeta },
    { resolveSandboxedSessionCreation },
  ] = await Promise.all([
    import("../../gateway/session-create-service.js"),
    import("../../gateway/session-utils-store-worker.js"),
    import("../../acp/runtime/session-meta-readonly.js"),
    import("../../acp/runtime/session-meta.js"),
    import("../../gateway/operator-session-run.js"),
  ]);
  creationOwner.assertCurrent();
  const requiredCreation = resolveSandboxedSessionCreation(
    getPluginRuntimeGatewayRequestScope()?.client,
    params.cfg,
  );
  type CreatedContext = Parameters<
    NonNullable<Parameters<typeof createGatewaySession>[0]["afterCreate"]>
  >[0];
  const selectedActor = source && !("kind" in source) ? source.actor : source;
  const target = selectedActor
    ? {
        agentId: selectedActor.agentId,
        canonicalKey: resolveSqliteSessionKey(params.key, selectedActor.agentId),
        storeKeys: [resolveSqliteSessionKey(params.key, selectedActor.agentId)],
        storePath: selectedActor.path,
      }
    : await resolveGatewaySessionStoreTargetInWorker({
        cfg: params.cfg,
        key: params.key,
        assertActive: creationOwner.assertCurrent,
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      });
  const cliInitial = "cliBackendId" in params.initialEntry ? params.initialEntry : undefined;
  const acpInitial = "acpSessionBinding" in params.initialEntry ? params.initialEntry : undefined;
  const harnessInitial = "agentHarnessId" in params.initialEntry ? params.initialEntry : undefined;
  const pluginInitial = cliInitial ?? acpInitial;
  const acpBackendId = acpInitial?.acpBackendId.trim();
  const acpAgentId = acpInitial?.acpSessionBinding.acpAgentId.trim();
  const agentSessionId = acpInitial?.acpSessionBinding.agentSessionId.trim();
  if (acpInitial && (!acpBackendId || !acpAgentId || !agentSessionId)) {
    throw new Error("initial ACP session binding fields must be non-empty");
  }
  const initialAcpMeta = (now: number): SessionAcpMeta | undefined =>
    acpInitial
      ? {
          backend: acpBackendId!,
          agent: acpAgentId!,
          runtimeSessionName: target.canonicalKey,
          identity: {
            state: "resolved",
            agentSessionId: agentSessionId!,
            source: "ensure",
            lastUpdatedAt: now,
          },
          mode: "persistent",
          ...(params.spawnedCwd?.trim() ? { cwd: params.spawnedCwd.trim() } : {}),
          state: "idle",
          lastActivityAt: now,
        }
      : undefined;
  const persistedAcpBinding = acpInitial
    ? { acpBackendId: acpBackendId!, acpAgentId: acpAgentId!, agentSessionId: agentSessionId! }
    : undefined;
  const acpMetaMatches = (meta: SessionAcpMeta | undefined): boolean =>
    Boolean(
      meta &&
      meta.backend === acpBackendId &&
      meta.agent === acpAgentId &&
      meta.runtimeSessionName === target.canonicalKey &&
      meta.identity?.state === "resolved" &&
      meta.identity.agentSessionId === agentSessionId &&
      meta.mode === "persistent" &&
      meta.cwd === (params.spawnedCwd?.trim() || undefined),
    );
  const initializesAfterCreate = Boolean(params.afterCreate || acpInitial);
  const matchesExceptUpdatedAt = (left: SessionEntry, right: SessionEntry): boolean => {
    const { updatedAt: _leftUpdatedAt, ...leftStable } = left;
    const { updatedAt: _rightUpdatedAt, ...rightStable } = right;
    return isDeepStrictEqual(leftStable, rightStable);
  };
  const identities = new Set([target.canonicalKey, ...target.storeKeys]);
  const create = () =>
    runExclusiveSessionLifecycleMutation("plugin-create", {
      scope: target.storePath,
      identities,
      prepare: async () => {
        // Activate the mutation fence before checking admission state. New work
        // then queues, while pre-existing work makes creation fail without interruption.
        if (isSessionWorkAdmissionActive(target.storePath, identities)) {
          throw new Error(
            `Session "${target.canonicalKey}" is still active; retry creation later.`,
          );
        }
      },
      run: async () => {
        creationOwner.assertCurrent();
        const afterCreate = params.afterCreate;
        let initialization: ReturnType<typeof createSessionInitialization> | undefined;
        let callbackContext: CreatedContext | undefined;
        let finalEntryPatch: { pluginExtensions: SessionEntry["pluginExtensions"] } | undefined;
        let rollbackExpectedEntry: SessionEntry | undefined;
        const runAfterCreate = async (context: CreatedContext): Promise<void> => {
          callbackContext = context;
          if (acpInitial) {
            const meta = initialAcpMeta(Date.now());
            const persisted = await upsertAcpSessionMeta({
              cfg: params.cfg,
              sessionKey: context.key,
              agentId: context.agentId,
              mutate: () => meta,
            });
            if (!persisted?.acp) {
              throw new Error(`could not persist initial ACP binding for ${context.key}`);
            }
            const persistedEntry = await readSessionEntryReadOnlyInWorker({
              sessionKey: context.key,
              storePath: context.storePath,
              readConsistency: "latest",
            });
            if (!persistedEntry || !matchesExceptUpdatedAt(persistedEntry, context.entry)) {
              throw new Error(`created ACP session ${context.key} changed during initialization`);
            }
            callbackContext = { ...context, entry: persistedEntry };
          }
          rollbackExpectedEntry = structuredClone(callbackContext.entry);
          const captured = callbackContext;
          const expected = rollbackExpectedEntry;
          initialization = createSessionInitialization(
            {
              storePath: captured.storePath,
              sessionKey: captured.key,
              sessionId: expected.sessionId,
              lifecycleRevision: expected.lifecycleRevision,
            },
            (phase, deleted) => {
              if (phase === "rollback") {
                creationOwner.assertRollbackCurrent();
              } else {
                creationOwner.assertCurrent();
              }
              const selected = captureIncognitoSessionSource({
                sessionKey: captured.key,
                storePath: captured.storePath,
              });
              if (!selected) {
                // Durable creation holds the lifecycle owner; its worker validates the expected row.
                return;
              }
              const current =
                "kind" in selected
                  ? undefined
                  : selected.actor.sessions.readSharing(captured.key)?.entry;
              const matches =
                selected && !("kind" in selected)
                  ? selected.actor.sessions.readInitializationFingerprint(captured.key) ===
                    sessionInitializationFingerprint(expected)
                  : isDeepStrictEqual(current, expected);
              if (
                deleted
                  ? current !== undefined
                  : current?.initializationPending !== true || !matches
              ) {
                throw new Error(`Session initialization owner changed: ${captured.key}`);
              }
            },
            { config: params.cfg, agentId: captured.agentId, entry: expected },
            creationOwner,
          );
          initialization.handle.assertCurrent();
          if (!afterCreate) {
            return;
          }
          const finalPatch = await afterCreate({
            key: callbackContext.key,
            agentId: callbackContext.agentId,
            sessionId: callbackContext.entry.sessionId,
            entry: structuredClone(callbackContext.entry),
            initialization: initialization.handle,
          });
          initialization.handle.assertCurrent();
          if (finalPatch !== undefined) {
            const patchKeys = Object.keys(finalPatch);
            if (patchKeys.length !== 1 || patchKeys[0] !== "pluginExtensions") {
              throw new Error("session creation final patch may only contain pluginExtensions");
            }
            finalEntryPatch = structuredClone(finalPatch);
          }
        };
        try {
          const matchingEntry =
            params.recoverMatchingInitialEntry === true
              ? await readSessionEntryReadOnlyInWorker({
                  sessionKey: target.canonicalKey,
                  storePath: target.storePath,
                  readConsistency: "latest",
                })
              : undefined;
          let recovered = false;
          let created: { key: string; agentId: string; entry: SessionEntry };
          if (matchingEntry) {
            const expectedSpawnedCwd = params.spawnedCwd?.trim() || undefined;
            const expectedSessionRoot = params.sessionRoot?.trim() || undefined;
            const expectedExecNode = params.execNode?.trim() || undefined;
            const expectedExecCwd = params.execCwd?.trim() || undefined;
            const matchingAcpMeta = acpInitial
              ? readAcpSessionMetaForEntry({
                  sessionKey: target.canonicalKey,
                  agentId: target.agentId,
                  entry: matchingEntry,
                })
              : undefined;
            const initialEntryMatches =
              matchingEntry.initializationPending === true &&
              matchingEntry.agentHarnessId === harnessInitial?.agentHarnessId &&
              matchingEntry.pluginOwnerId === pluginInitial?.pluginOwnerId &&
              matchingEntry.modelSelectionLocked === params.initialEntry.modelSelectionLocked &&
              (!cliInitial ||
                (matchingEntry.providerOverride === cliInitial.cliBackendId &&
                  matchingEntry.modelOverride === cliInitial.model &&
                  isDeepStrictEqual(
                    matchingEntry.cliSessionBindings?.[cliInitial.cliBackendId],
                    cliInitial.cliSessionBinding,
                  ))) &&
              (!acpInitial ||
                (isDeepStrictEqual(matchingEntry.acpSessionBinding, persistedAcpBinding) &&
                  (matchingAcpMeta === undefined || acpMetaMatches(matchingAcpMeta)))) &&
              matchingEntry.spawnedCwd === expectedSpawnedCwd &&
              matchingEntry.sessionRoot === expectedSessionRoot &&
              matchingEntry.permissionMode === params.permissionMode &&
              matchingEntry.execNode === expectedExecNode &&
              matchingEntry.execCwd === expectedExecCwd &&
              isDeepStrictEqual(
                matchingEntry.pluginExtensions,
                params.initialEntry.pluginExtensions,
              );
            if (!initialEntryMatches) {
              throw new Error(
                `Session "${target.canonicalKey}" does not match its trusted recovery state.`,
              );
            }
            if (!afterCreate) {
              throw new Error("session creation recovery requires an initializer");
            }
            recovered = true;
            created = {
              key: target.canonicalKey,
              agentId: target.agentId,
              entry: matchingEntry,
            };
            await runAfterCreate({
              ...created,
              storePath: target.storePath,
              isNew: false,
            });
          } else {
            const result = await createGatewaySession({
              cfg: params.cfg,
              operatorRoleActor: requiredCreation ? undefined : { kind: "system" },
              requestingOperatorProfileId: requiredCreation?.actor?.id,
              key: target.canonicalKey,
              ...(source ? { incognito: true } : {}),
              ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
              ...(params.label !== undefined ? { label: params.label } : {}),
              ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
              ...(params.spawnedCwd !== undefined ? { spawnedCwd: params.spawnedCwd } : {}),
              ...(params.sessionRoot !== undefined ? { sessionRoot: params.sessionRoot } : {}),
              ...(params.permissionMode !== undefined
                ? { permissionMode: params.permissionMode }
                : {}),
              ...(params.execNode !== undefined ? { execNode: params.execNode } : {}),
              ...(params.execCwd !== undefined ? { execCwd: params.execCwd } : {}),
              initialEntry: {
                color: params.initialEntry.color,
                ...(harnessInitial ? { agentHarnessId: harnessInitial.agentHarnessId } : {}),
                ...(cliInitial
                  ? {
                      pluginOwnerId: cliInitial.pluginOwnerId,
                      providerOverride: cliInitial.cliBackendId,
                      modelOverride: cliInitial.model,
                      modelOverrideRouteResolution: "resolved",
                      cliSessionBindings: {
                        [cliInitial.cliBackendId]: cliInitial.cliSessionBinding,
                      },
                    }
                  : {}),
                ...(acpInitial
                  ? {
                      pluginOwnerId: acpInitial.pluginOwnerId,
                      acpSessionBinding: persistedAcpBinding,
                    }
                  : {}),
                ...(params.initialEntry.modelSelectionLocked === true
                  ? { modelSelectionLocked: true }
                  : {}),
                ...(params.initialEntry.pluginExtensions
                  ? { pluginExtensions: params.initialEntry.pluginExtensions }
                  : {}),
                ...(initializesAfterCreate ? { initializationPending: true } : {}),
              },
              ...(harnessInitial
                ? { authorizedAgentHarnessId: harnessInitial.agentHarnessId }
                : {}),
              ...(pluginInitial?.pluginOwnerId
                ? { authorizedPluginId: pluginInitial.pluginOwnerId }
                : {}),
              creation: requiredCreation ?? {
                via: "plugin",
                actor: {
                  type: "system",
                  ...(pluginInitial?.pluginOwnerId ? { id: pluginInitial.pluginOwnerId } : {}),
                },
              },
              commandSource: "plugin-runtime",
              ...(initializesAfterCreate ? { afterCreate: runAfterCreate } : {}),
            });
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            if (result.postCommit.status === "failed") {
              // Plugin initialization owns guarded rollback and recovery. Do not
              // finalize an initializationPending row whose callback failed.
              throw result.postCommit.error;
            }
            created = result;
          }
          if (recovered && !finalEntryPatch) {
            throw new Error("session creation recovery requires a final patch");
          }
          let finalEntry = created.entry;
          if (initializesAfterCreate) {
            const patch: Partial<SessionEntry> = {
              ...finalEntryPatch,
              initializationPending: undefined,
              ...(acpInitial ? { acpSessionBinding: undefined } : {}),
            };
            const expectedEntry = rollbackExpectedEntry;
            if (!callbackContext || !expectedEntry) {
              throw new Error("session creation final patch is missing its created entry");
            }
            const createdContext = callbackContext;
            const finalized = await patchAccessorSessionEntry(
              {
                sessionKey: createdContext.key,
                storePath: createdContext.storePath,
              },
              (currentEntry) => {
                if (JSON.stringify(currentEntry) !== JSON.stringify(expectedEntry)) {
                  throw new Error(
                    `created session ${createdContext.key} changed before finalization`,
                  );
                }
                return patch;
              },
              {
                preserveActivity: true,
                requireWriteSuccess: true,
                ...sessionEntryCommitGuardOptions(creationOwner.assertCurrent),
              },
            );
            if (!finalized) {
              throw new Error(
                `created session ${createdContext.key} disappeared before finalization`,
              );
            }
            finalEntry = finalized;
            // Readiness COMMIT seals creation authority, even if its publication throws.
            initialization?.close();
          }
          return {
            key: created.key,
            agentId: created.agentId,
            sessionId: finalEntry.sessionId,
            entry: finalEntry,
          };
        } catch (error) {
          if (!callbackContext) {
            throw error;
          }
          const current = await readSessionEntryReadOnlyInWorker({
            sessionKey: callbackContext.key,
            storePath: callbackContext.storePath,
            readConsistency: "latest",
          });
          if (
            current?.sessionId === callbackContext.entry.sessionId &&
            current.lifecycleRevision === callbackContext.entry.lifecycleRevision &&
            current.initializationPending !== true
          ) {
            throw error;
          }
          try {
            // Delete only the untouched row created for this callback. A concurrent
            // claimant changes the snapshot and must survive failed initialization.
            let expectedEntry = rollbackExpectedEntry ?? callbackContext.entry;
            if (acpInitial && !rollbackExpectedEntry) {
              const currentEntry = await readSessionEntryReadOnlyInWorker({
                sessionKey: callbackContext.key,
                storePath: callbackContext.storePath,
                readConsistency: "latest",
              });
              if (currentEntry && matchesExceptUpdatedAt(currentEntry, callbackContext.entry)) {
                expectedEntry = currentEntry;
              }
            }
            const rollbackParams = {
              agentId: callbackContext.agentId,
              archiveTranscript: true,
              expectedEntry,
              expectedSessionId: callbackContext.entry.sessionId,
              expectedUpdatedAt: expectedEntry.updatedAt,
              storePath: callbackContext.storePath,
              target: {
                canonicalKey: callbackContext.key,
                storeKeys: [callbackContext.key],
              },
            };
            // Locked rows require owner-specific rollback capabilities. Unlocked
            // initializers stay on the ordinary guarded lifecycle deletion path.
            const rollback = async () =>
              expectedEntry.modelSelectionLocked === true
                ? expectedEntry.agentHarnessId
                  ? await rollbackAgentHarnessSessionEntryLifecycle(rollbackParams)
                  : await rollbackPluginOwnedSessionEntryLifecycle({
                      ...rollbackParams,
                      expectedPluginOwnerId: pluginInitial?.pluginOwnerId ?? "",
                    })
                : await deleteSessionEntryLifecycle(rollbackParams);
            const rolledBack = initialization
              ? await initialization.rollback(rollback)
              : await rollback();
            if (!rolledBack.deleted) {
              throw new Error(`created session ${callbackContext.key} changed before rollback`, {
                cause: error,
              });
            }
            if (acpInitial) {
              await upsertAcpSessionMeta({
                cfg: params.cfg,
                sessionKey: callbackContext.key,
                agentId: callbackContext.agentId,
                mutate: () => null,
              });
            }
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `Session initialization failed and guarded rollback did not complete for ${callbackContext.key}.`,
              { cause: rollbackError },
            );
          }
          throw error;
        } finally {
          initialization?.close();
        }
      },
    });
  return source && !("kind" in source)
    ? source.actor.sessions.withSharedState(create)
    : await create();
}
