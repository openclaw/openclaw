import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveSqliteAgentId } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import {
  acceptSessionSourceValidation,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { captureSessionStoreWriteCandidates } from "../config/sessions/session-store-target-inventory.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  assertDatabasePathIdentity,
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  assertClientVoiceSessionSettlementCurrent,
  captureClientVoiceSessionSettlementContext,
  type captureClientVoiceSessionSettlement,
} from "./client-voice-session-lifecycle.js";
import type { ClientVoiceRunBinding } from "./client-voice-session-store.js";

/** Voice metadata stays bound to its admitted physical store across provider and queue waits. */
export function captureClientVoiceSessionSourceOptions(agentId: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const path = resolveOpenClawAgentSqlitePath({ agentId, env });
  return { agentId, env, path };
}

/** Retain entry ownership independently of the durable voice metadata store. */
export async function captureClientVoiceEntrySource(
  params: { agentId: string; storePath?: string },
  assertLifetimeCurrent: () => void,
) {
  const original = captureClientVoiceSessionSourceOptions(params.agentId);
  const storePath = params.storePath ?? original.path;
  const captured = captureSessionStoreWriteCandidates(storePath);
  const canonical = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const assertCurrent = () => {
    assertLifetimeCurrent();
    captured.assertCurrent();
  };
  const capture = (target: Awaited<ReturnType<typeof prepareSqliteTargetFromSessionStorePath>>) => {
    assertCurrent();
    const agentId = resolveSqliteAgentId({
      scopedAgentId: params.agentId,
      storeAgentId: target.agentId,
      storeShared: target.shared,
    });
    if (!agentId || !target.agentId) {
      throw new Error("Talk entry target has no physical owner");
    }
    const observed = captured.resolveIdentity(target.path);
    const options = { agentId: target.agentId, path: observed.canonicalPath, env: original.env };
    const execution = captureOpenClawAgentDatabaseExecution(options, {
      ...(observed.key.startsWith("file:")
        ? {
            expectedIdentity: {
              kind: "file" as const,
              physicalIdentity: observed.key.slice("file:".length),
              nativeLocation: observed.canonicalPath,
              birthtime: observed.birthtime,
            },
          }
        : { expectedCreationIdentity: observed }),
      requestedPath: target.path,
    });
    return { options, execution, agentId, storePath, assertCurrent };
  };
  return canonical.agentId
    ? capture(canonical)
    : capture(
        await prepareSqliteTargetFromSessionStorePath(storePath, {
          agentId: params.agentId,
          env: original.env,
        }),
      );
}

export function createClientVoiceSessionSource(
  options: ReturnType<typeof captureClientVoiceSessionSourceOptions>,
  identity: DatabasePathIdentity,
) {
  const settlementContext = captureClientVoiceSessionSettlementContext(options.env);
  return {
    options,
    identity,
    settlementContext,
    assertCurrent() {
      assertClientVoiceSessionSettlementCurrent(settlementContext);
      settlementContext.admission.assertCurrent();
      assertDatabasePathIdentity(options.path, identity);
    },
  };
}

export function captureClientVoiceSessionSource(agentId: string) {
  const options = captureClientVoiceSessionSourceOptions(agentId);
  return createClientVoiceSessionSource(options, readDatabasePathIdentitySync(options.path));
}

export type ClientVoiceSessionSource = ReturnType<typeof captureClientVoiceSessionSource>;

/** An explicit source qualifies the run's store; an omitted source retains replay custody. */
export function matchesClientVoiceRunSource(
  owner: { binding: ClientVoiceRunBinding; source: ClientVoiceSessionSource } | undefined,
  binding: ClientVoiceRunBinding,
  source?: ClientVoiceSessionSource,
): boolean {
  return (
    owner?.binding.agentId === binding.agentId &&
    owner.binding.voiceSessionId === binding.voiceSessionId &&
    owner.binding.sessionKey === binding.sessionKey &&
    (!source ||
      (owner.source.identity.key === source.identity.key &&
        owner.source.identity.birthtime === source.identity.birthtime))
  );
}

/** Foreign source checks retain their own readers; local predicates belong to the voice writer. */
export async function prepareClientVoiceSessionSourceChecks(
  writer: Pick<ClientVoiceSessionSource, "options" | "identity">,
  authorities: readonly PreparedSessionSourceAuthority[],
): Promise<PreparedSessionSourceAuthority> {
  const checks: PreparedSessionSourceAuthority["checks"] = [];
  const foreign = new Map<string | symbol, PreparedSessionSourceAuthority["checks"]>();
  for (const check of authorities.flatMap((authority) => authority.checks)) {
    const source = check.predicate.source;
    if (
      typeof source.databaseIdentity === "string" &&
      `file:${source.databaseIdentity}` === writer.identity.key &&
      source.databaseBirthtime === writer.identity.birthtime
    ) {
      checks.push(check);
    } else {
      const group = foreign.get(source.databaseIdentity) ?? [];
      group.push(check);
      foreign.set(source.databaseIdentity, group);
    }
  }
  const assertAuthoritiesCurrent = () =>
    authorities.forEach((authority) => authority.assertCurrent());
  if (foreign.size === 0) {
    return { checks, assertCurrent: assertAuthoritiesCurrent };
  }
  const [
    { retainOpenClawAgentDatabaseReadOnly },
    { readOpenClawAgentDatabaseIdentity },
    { readSessionSourceValidation },
    { hasSqliteSessionOwnerColumns },
  ] = await Promise.all([
    import("../state/openclaw-agent-db-readonly.js"),
    import("../state/openclaw-agent-db-identity.js"),
    import("../config/sessions/session-source-predicate.worker.js"),
    import("../config/sessions/session-accessor.sqlite-owner-projection.js"),
  ]);
  const resources: Pick<PreparedSessionSourceAuthority, "release">[] = [];
  const release = () => releaseSessionSourceAuthorities(resources);
  const assertions: (() => void)[] = [];
  try {
    assertAuthoritiesCurrent();
    for (const group of foreign.values()) {
      const source = group[0]!.predicate.source;
      const assertPathsCurrent = () => {
        for (const { predicate } of group) {
          if (typeof predicate.source.databaseIdentity === "string") {
            assertExistingDatabaseIdentity(
              predicate.source.path,
              `file:${predicate.source.databaseIdentity}`,
              predicate.source.databaseBirthtime,
            );
          }
        }
      };
      assertPathsCurrent();
      const retained = retainOpenClawAgentDatabaseReadOnly({
        ...writer.options,
        agentId: source.agentId,
        path: source.path,
      });
      if (!retained.found) {
        throw new Error("Voice session source is unavailable");
      }
      resources.push(retained.claim);
      const identity = readOpenClawAgentDatabaseIdentity(retained.database);
      if (
        identity.identity !== source.databaseIdentity ||
        identity.birthtime !== source.databaseBirthtime
      ) {
        throw new Error("Voice session source changed its captured database owner");
      }
      // A first native query can discover owner columns; do that before worker grants.
      hasSqliteSessionOwnerColumns(retained.database.db);
      const predicates = group.map((check) => check.predicate);
      assertions.push(() => {
        assertPathsCurrent();
        retained.claim.assertCurrent();
        acceptSessionSourceValidation(
          { checks: group, assertCurrent: assertAuthoritiesCurrent },
          readSessionSourceValidation(retained.database, predicates),
        );
      });
    }
    return {
      nativeSource: true,
      checks,
      assertCurrent: () => {
        assertAuthoritiesCurrent();
        assertions.forEach((assertCurrent) => assertCurrent());
      },
      release,
    };
  } catch (error) {
    await releaseSessionSourceAuthorities(resources, [error]);
    throw error;
  }
}

export type ClientVoiceRun = {
  binding: ClientVoiceRunBinding;
  source: ClientVoiceSessionSource;
  settlement?: ReturnType<typeof captureClientVoiceSessionSettlement>;
  stopObserving?: () => void;
  retired?: true;
};
