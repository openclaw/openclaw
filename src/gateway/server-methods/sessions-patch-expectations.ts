import { expectDefined } from "@openclaw/normalization-core/expect";
import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import { prepareSessionEntryMutationDatabases } from "../../config/sessions/session-accessor.entry-mutation.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { prepareGatewaySessionLifecycleTargets } from "../session-lifecycle-preparation.js";
import { sessionToolOverridesEqual } from "../session-tool-overrides.js";
import {
  sessionChangedError,
  assertSessionPatchCommitAllowed,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import type {
  MutationOutcome,
  MutationTarget,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";

export function resolveSessionPatchExpectationError(
  patch: SessionsPatchParams,
): string | undefined {
  if (patch.expectedSandboxMode !== undefined && patch.sandboxMode === undefined) {
    return "expectedSandboxMode requires a sandboxMode replacement.";
  }
  if (patch.expectedPermissionMode !== undefined && patch.permissionMode === undefined) {
    return "expectedPermissionMode requires a permissionMode replacement.";
  }
  if (
    patch.expectedNativeRuntimeConsent !== undefined &&
    patch.nativeRuntimeConsent === undefined
  ) {
    return "expectedNativeRuntimeConsent requires a nativeRuntimeConsent replacement.";
  }
  if (
    typeof patch.nativeRuntimeConsent === "string" &&
    (!patch.expectedSessionId ||
      patch.expectedPermissionMode === undefined ||
      patch.expectedSandboxMode === undefined ||
      patch.expectedNativeRuntimeConsent === undefined ||
      patch.permissionMode !== "full" ||
      patch.sandboxMode !== "off")
  ) {
    return "Native runtime consent requires the current session and execution settings, Full access, and sandbox off.";
  }
  if (patch.expectedToolOverrides !== undefined && patch.toolOverrides === undefined) {
    return "expectedToolOverrides requires a toolOverrides replacement.";
  }
  return undefined;
}

export function resolveSessionPatchTargetError(
  entry: SessionEntry | undefined,
  target: { key: string; fullPatch: SessionsPatchParams; initialEntry?: SessionEntry },
): ErrorShape | undefined {
  const { fullPatch: patch, initialEntry } = target;
  const changed =
    (patch.expectedSessionId !== undefined && entry?.sessionId !== patch.expectedSessionId) ||
    (patch.expectedLifecycleRevision !== undefined &&
      entry?.lifecycleRevision !== patch.expectedLifecycleRevision) ||
    (initialEntry !== undefined && entry === undefined) ||
    (patch.archived === true &&
      (initialEntry === undefined
        ? entry !== undefined
        : entry !== undefined &&
          (entry.sessionId !== initialEntry.sessionId ||
            entry.lifecycleRevision !== initialEntry.lifecycleRevision))) ||
    (patch.expectedSandboxMode !== undefined &&
      (entry?.sandboxMode ?? null) !== patch.expectedSandboxMode) ||
    (patch.expectedPermissionMode !== undefined &&
      (entry?.permissionMode ?? null) !== patch.expectedPermissionMode) ||
    (patch.expectedNativeRuntimeConsent !== undefined &&
      (entry?.nativeRuntimeConsent ?? null) !== patch.expectedNativeRuntimeConsent) ||
    (patch.expectedToolOverrides !== undefined &&
      !sessionToolOverridesEqual(entry?.toolOverrides, patch.expectedToolOverrides));
  return changed ? sessionChangedError(target.key) : undefined;
}

export function sessionPatchTargetIdentity(patch: SessionsPatchParams) {
  return {
    key: patch.key,
    ...(patch.agentId ? { agentId: patch.agentId } : {}),
    ...(patch.expectedSessionId !== undefined
      ? { expectedSessionId: patch.expectedSessionId }
      : {}),
    ...(patch.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: patch.expectedLifecycleRevision }
      : {}),
    ...(patch.expectedPermissionMode !== undefined
      ? { expectedPermissionMode: patch.expectedPermissionMode }
      : {}),
    ...(patch.expectedSandboxMode !== undefined
      ? { expectedSandboxMode: patch.expectedSandboxMode }
      : {}),
    ...(patch.expectedNativeRuntimeConsent !== undefined
      ? { expectedNativeRuntimeConsent: patch.expectedNativeRuntimeConsent }
      : {}),
    ...(patch.expectedToolOverrides !== undefined
      ? { expectedToolOverrides: patch.expectedToolOverrides }
      : {}),
    expectedMarkedUnreadAt: patch.expectedMarkedUnreadAt,
  };
}

/** The retained source and target keep the existing personal-account error boundary. */
function bindPreparedSessionPatchTarget(params: {
  key: string;
  originalGuard: () => ErrorShape | undefined;
  operatorAuthority: AdmittedRunOperatorAuthority | undefined;
  personalModelSelection: UserModelAccountSelection | undefined;
  preparation: { facts: { matchesCurrent: (cfg: OpenClawConfig) => boolean } } | { error: unknown };
  getCurrentConfig: () => OpenClawConfig;
}): () => ErrorShape | undefined {
  return () => {
    try {
      assertSessionPatchCommitAllowed({
        personalModelSelection: params.personalModelSelection,
        guards: [params.originalGuard],
        archiveTransitions: [],
      });
      params.operatorAuthority?.assertCurrent();
      if ("error" in params.preparation) {
        throw params.preparation.error instanceof Error
          ? params.preparation.error
          : new Error("Session target preparation failed", { cause: params.preparation.error });
      }
      return params.preparation.facts.matchesCurrent(params.getCurrentConfig())
        ? undefined
        : sessionChangedError(params.key);
    } catch (error) {
      return unexpectedPatchError(params.key, error);
    }
  };
}

/** Prepare original writers and bind their facts before patch projection can acquire admission. */
export async function prepareSessionPatchTargets(params: {
  cfg: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  prepared: readonly PreparedPatchTarget[];
  mutationTargets: MutationTarget[];
  outcomes: Array<MutationOutcome | undefined>;
  originalCommitGuards: readonly (() => ErrorShape | undefined)[];
  operatorAuthority?: Promise<{ authority: AdmittedRunOperatorAuthority } | undefined>;
  personalModelSelection: UserModelAccountSelection | undefined;
}) {
  let operatorAuthority: AdmittedRunOperatorAuthority | undefined;
  const ready = params.operatorAuthority
    ? params.operatorAuthority.then((captured) => {
        operatorAuthority = captured?.authority;
        operatorAuthority?.assertCurrent();
      })
    : Promise.resolve();
  const selected = params.operatorAuthority ? params.prepared : [];
  const durableTargets = selected.filter((target) => !isIncognitoSessionKey(target.canonicalKey));
  const databaseCustody = prepareSessionEntryMutationDatabases(
    durableTargets.map((target) => ({
      scope: {
        agentId: target.targetAgentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      assertCurrent: () => {
        assertSessionPatchCommitAllowed({
          personalModelSelection: params.personalModelSelection,
          guards: [params.originalCommitGuards[target.index]!],
          archiveTransitions: [],
        });
        operatorAuthority?.assertCurrent();
      },
    })),
    ready,
  );
  type PreparedStorage = Awaited<(typeof databaseCustody.preparations)[number]>;
  const storage = new Map<number, PreparedStorage>();
  const storagePreparations = new Map(
    durableTargets.map(
      (target, index) =>
        [
          target.index,
          databaseCustody.preparations[index]!.then((prepared) => {
            storage.set(target.index, prepared);
            return prepared;
          }),
        ] as const,
    ),
  );
  let targetCustody: ReturnType<typeof prepareGatewaySessionLifecycleTargets> | undefined;
  const release = async () => {
    const errors: unknown[] = [];
    try {
      await targetCustody?.[Symbol.asyncDispose]();
    } catch (error) {
      errors.push(error);
    }
    try {
      await databaseCustody[Symbol.asyncDispose]();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw createSqliteLifecycleAggregateError(
        errors,
        "Session patch preparation cleanup failed",
        errors[0],
      );
    }
  };
  try {
    targetCustody = prepareGatewaySessionLifecycleTargets({
      cfg: params.cfg,
      getCurrentConfig: params.getCurrentConfig,
      targets: selected.map((target) => {
        const storageReady = storagePreparations.get(target.index);
        return {
          target: {
            agentId: target.targetAgentId,
            canonicalKey: target.canonicalKey,
            storePath: target.storePath,
          },
          entry: target.initialEntry,
          ...(storageReady ? { storageReady } : {}),
        };
      }),
    });
    await ready;
    for (const [index, preparation] of targetCustody.preparations.entries()) {
      const target = selected[index]!;
      const result = await preparation.then(
        (facts) => ({ facts }),
        (error: unknown) => ({ error }),
      );
      const guard = bindPreparedSessionPatchTarget({
        key: target.key,
        originalGuard: params.originalCommitGuards[target.index]!,
        operatorAuthority,
        personalModelSelection: params.personalModelSelection,
        preparation: result,
        getCurrentConfig: params.getCurrentConfig,
      });
      params.mutationTargets[target.index]!.commitGuard = guard;
      if ("error" in result) {
        // Original caller errors retain precedence; failed preparation never reaches a fallback open.
        params.outcomes[target.index] = {
          ok: false,
          error: expectDefined(guard(), "failed session preparation error"),
        };
      }
    }
    return {
      operatorAuthority,
      prepared: params.prepared.filter((target) => params.outcomes[target.index] === undefined),
      storage,
      [Symbol.asyncDispose]: release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Session patch preparation and cleanup failed",
        error,
      );
    }
    throw error;
  }
}
