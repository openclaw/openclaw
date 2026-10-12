import fs from "node:fs";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, tryResolveSoleAgentId } from "../../agents/agent-scope-config.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeAgentId, normalizeMainKey } from "../../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  inspectSessionStorePath,
  readClaimsFromStores,
  prepareComparisonClaimsFromStores,
  storesHaveLegacyAgentSessionKey,
} from "./legacy-main-session-key-scan.js";
import { claimsMatch, restoreColdSessionClaims } from "./legacy-main-session-migration-claims.js";
import {
  processIdenticalClaims,
  describeIdenticalClaims,
  repairDivergentClaims,
  samePhysicalStore,
  warningForDivergence,
} from "./legacy-main-session-migration-operations.js";
import type {
  LegacyMainSessionMigrationMode,
  LegacyMainSessionMigrationOutcome,
  LegacyMainSessionMigrationResult,
  PhysicalStore,
  SessionComparisonClaim,
} from "./legacy-main-session-migration.contract.js";
import { resolveSessionArtifactDirectory, resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAgentSessionStoreTargetsSync,
  resolveSessionStoreCompatibilityAgentId,
} from "./targets.js";

const SOURCE_KEY = "legacy-main-session-keys";
const MIGRATION_KIND = "legacy-main-session-keys-v1";
const REPORT_VERSION = 1;

type LedgerDatabase = Pick<OpenClawStateKyselyDatabase, "migration_runs" | "migration_sources">;

type ArmingDecision =
  | { armed: false; reason: "legacy-agent-present" | "owner-unresolved" }
  | { armed: true; ownerAgentId: string };

type LedgerReport = {
  version: 1;
  legacyAgentId: string;
  mainKey: string;
  ownerAgentId: string;
  outcomes: LegacyMainSessionMigrationOutcome[];
  sourceLayout: string[];
  status: "complete";
};

function resolveArmingDecision(cfg: OpenClawConfig, legacyAgentId: string): ArmingDecision {
  const roster = new Set(listAgentIds(cfg).map(normalizeAgentId));
  if (roster.has(legacyAgentId)) {
    return { armed: false, reason: "legacy-agent-present" };
  }
  const sole = tryResolveSoleAgentId(cfg);
  if (sole && roster.has(normalizeAgentId(sole))) {
    return { armed: true, ownerAgentId: normalizeAgentId(sole) };
  }
  const sessionStoreOwner = cfg.agents?.defaults?.sessionStore?.agentId?.trim();
  if (sessionStoreOwner) {
    const normalized = normalizeAgentId(sessionStoreOwner);
    if (roster.has(normalized)) {
      return { armed: true, ownerAgentId: normalized };
    }
  }
  return { armed: false, reason: "owner-unresolved" };
}

function addPhysicalStore(stores: PhysicalStore[], candidate: PhysicalStore): void {
  if (!stores.some((store) => samePhysicalStore(store, candidate))) {
    stores.push(candidate);
  }
}

function resolveMissingPhysicalPath(pathname: string): string {
  const prefix = resolvePathPrefixSync(path.resolve(pathname));
  return path.join(prefix.existingPath, ...prefix.unresolvedSegments);
}

function resolvePhysicalPathIdentity(pathname: string): string {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      throw new Error(`session store is not a regular file: ${pathname}`);
    }
    return `file:${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return `missing:${resolveMissingPhysicalPath(pathname)}`;
  }
}

type ResolvedPhysicalStores = {
  jsonPaths: string[];
  stores: PhysicalStore[];
  unreadable: LegacyMainSessionMigrationOutcome[];
};

function resolvePhysicalStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  legacyAgentId: string;
  mode: LegacyMainSessionMigrationMode;
  ownerAgentId?: string;
}): ResolvedPhysicalStores {
  const logicalTargets = [
    ...resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env }),
    ...resolveAgentSessionStoreTargetsSync(params.cfg, params.legacyAgentId, { env: params.env }),
    {
      agentId: params.legacyAgentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.legacyAgentId,
        env: params.env,
      }),
    },
  ];
  if (params.ownerAgentId) {
    logicalTargets.push({
      agentId: params.ownerAgentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.ownerAgentId,
        env: params.env,
      }),
    });
  }
  const defaultAgentId = params.ownerAgentId ?? resolveSessionStoreCompatibilityAgentId(params.cfg);
  const stores: PhysicalStore[] = [];
  const jsonPaths = new Set<string>();
  const unreadable: LegacyMainSessionMigrationOutcome[] = [];
  for (const target of logicalTargets) {
    try {
      if (
        !target.storePath.endsWith(".sqlite") &&
        inspectSessionStorePath(target.storePath) === "present"
      ) {
        jsonPaths.add(path.resolve(target.storePath));
      }
      const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        defaultAgentId,
        env: params.env,
      });
      const physical: PhysicalStore = {
        databaseAgentId: normalizeAgentId(resolved.agentId ?? target.agentId),
        ownerStorePath: target.storePath,
        path: resolved.path,
      };
      resolvePhysicalPathIdentity(physical.path);
      addPhysicalStore(stores, physical);
    } catch (error) {
      if (params.mode === "doctor-fix") {
        throw new Error(
          `cannot inspect legacy session store ${target.storePath}: ${String(error)}`,
          {
            cause: error,
          },
        );
      }
      unreadable.push({
        kind: "store-unreadable",
        detail: String(error),
        paths: [target.storePath],
      });
    }
  }
  return { jsonPaths: [...jsonPaths], stores, unreadable };
}

function resolveSourceLayout(resolved: ResolvedPhysicalStores): string[] {
  return [
    ...new Set([
      ...resolved.stores.map(
        (store) => `sqlite:${store.databaseAgentId}:${resolvePhysicalPathIdentity(store.path)}`,
      ),
      ...resolved.jsonPaths.map((pathname) => `json:${resolvePhysicalPathIdentity(pathname)}`),
    ]),
  ].toSorted();
}

async function readLedger(
  env: NodeJS.ProcessEnv,
): Promise<{ report: LedgerReport; status: string } | undefined> {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "legacySessionMigration.readLedger", input: undefined },
    { current: true },
  );
  if (reply && (!reply.ok || reply.type !== "legacySessionMigration.readLedger")) {
    throw new Error("Unexpected legacy session migration ledger result");
  }
  const row = reply?.row;
  if (!row) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(row.report_json) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== REPORT_VERSION ||
      typeof parsed.legacyAgentId !== "string" ||
      typeof parsed.mainKey !== "string" ||
      typeof parsed.ownerAgentId !== "string" ||
      !Array.isArray(parsed.outcomes) ||
      !Array.isArray(parsed.sourceLayout) ||
      parsed.sourceLayout.some((entry) => typeof entry !== "string") ||
      parsed.status !== "complete"
    ) {
      return undefined;
    }
    return { report: parsed as LedgerReport, status: row.status };
  } catch {
    return undefined;
  }
}

function ledgerMatches(
  ledger: { report: LedgerReport; status: string } | undefined,
  identity: Omit<LedgerReport, "outcomes" | "status" | "version">,
): ledger is { report: LedgerReport; status: "completed" } {
  return (
    ledger?.status === "completed" &&
    ledger.report.version === REPORT_VERSION &&
    ledger.report.status === "complete" &&
    ledger.report.legacyAgentId === identity.legacyAgentId &&
    ledger.report.ownerAgentId === identity.ownerAgentId &&
    ledger.report.mainKey === identity.mainKey &&
    ledger.report.sourceLayout.length === identity.sourceLayout.length &&
    ledger.report.sourceLayout.every((entry, index) => entry === identity.sourceLayout[index])
  );
}

function writeLedger(params: {
  beforePersistentApply?: () => void;
  env: NodeJS.ProcessEnv;
  identity: Omit<LedgerReport, "outcomes" | "status" | "version">;
  now: number;
  outcomes: LegacyMainSessionMigrationOutcome[];
  stateDir: string;
}): void {
  const report: LedgerReport = {
    version: REPORT_VERSION,
    ...params.identity,
    outcomes: params.outcomes,
    status: "complete",
  };
  const reportJson = JSON.stringify(report);
  const identityHash = sha256Hex(JSON.stringify(params.identity));
  const runId = `${SOURCE_KEY}:${identityHash.slice(0, 24)}`;
  params.beforePersistentApply?.();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      const completion = {
        finished_at: params.now,
        status: "completed",
        report_json: reportJson,
      };
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("migration_runs")
          .values({
            id: runId,
            started_at: params.now,
            ...completion,
          })
          .onConflict((conflict) => conflict.column("id").doUpdateSet(completion)),
      );
      const sourceCompletion = {
        source_path: params.stateDir,
        source_sha256: identityHash,
        source_record_count: params.outcomes.length,
        last_run_id: runId,
        status: "completed",
        imported_at: params.now,
        removed_source: 1,
        report_json: reportJson,
      };
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("migration_sources")
          .values({
            source_key: SOURCE_KEY,
            migration_kind: MIGRATION_KIND,
            target_table: "session_nodes",
            source_size_bytes: null,
            ...sourceCompletion,
          })
          .onConflict((conflict) => conflict.column("source_key").doUpdateSet(sourceCompletion)),
      );
    },
    { env: params.env },
    { operationLabel: "session-migration.legacy-main-ledger" },
  );
}

function groupLegacyClaims<Claim extends SessionComparisonClaim>(claims: Claim[]) {
  const grouped = new Map<string, Claim[]>();
  for (const claim of claims) {
    const group = grouped.get(claim.canonicalKey) ?? [];
    group.push(claim);
    grouped.set(claim.canonicalKey, group);
  }
  return grouped;
}

function compareClaimGroup<Claim extends SessionComparisonClaim>(
  aliases: Claim[],
  canonicalClaims: Claim[],
  destination: PhysicalStore,
) {
  const destinationCanonical = canonicalClaims.find((claim) =>
    samePhysicalStore(claim.store, destination),
  );
  const foreignCanonical = canonicalClaims.some(
    (claim) => !samePhysicalStore(claim.store, destination),
  );
  const aliasesIdentical = aliases.every((claim) => claimsMatch(claim, aliases[0]!));
  const canonicalMatches = destinationCanonical
    ? aliases.every((claim) => claimsMatch(claim, destinationCanonical))
    : false;
  const divergence =
    foreignCanonical || (destinationCanonical && !canonicalMatches)
      ? ("divergent-canonical" as const)
      : !aliasesIdentical
        ? ("divergent-aliases" as const)
        : undefined;
  return {
    destinationCanonical,
    divergence,
    divergentClaims:
      divergence === "divergent-canonical" ? [...canonicalClaims, ...aliases] : aliases,
  };
}

function describeDivergentClaims(
  kind: "divergent-aliases" | "divergent-canonical",
  canonicalKey: string,
  claims: readonly SessionComparisonClaim[],
): LegacyMainSessionMigrationOutcome {
  return {
    kind,
    canonicalKey,
    paths: [...new Set(claims.map((claim) => claim.store.path))],
    sourceKeys: claims.map((claim) => claim.key),
  };
}

function isBlockingOutcome(outcome: LegacyMainSessionMigrationOutcome): boolean {
  return (
    outcome.kind === "legacy-json-store" ||
    outcome.kind === "store-unreadable" ||
    ((outcome.kind === "divergent-aliases" || outcome.kind === "divergent-canonical") &&
      outcome.resolved !== true)
  );
}

/** Migrates retired agent-owned session keys without adding runtime read aliases. */
async function migrateLegacyMainSessionKeysInternal(
  params: Parameters<typeof migrateLegacyMainSessionKeys>[0],
): Promise<LegacyMainSessionMigrationResult> {
  const env = params.env ?? process.env;
  const legacyAgentId = normalizeAgentId(params.legacyAgentId ?? "main");
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const arming = resolveArmingDecision(params.cfg, legacyAgentId);
  const base = {
    changes: [] as string[],
    legacyAgentId,
    mainKey,
    warnings: [] as string[],
  };
  if (!arming.armed) {
    if (arming.reason === "owner-unresolved") {
      // Owner guidance is useful only when legacy rows may exist; unreadable or JSON
      // candidates fail open because they cannot prove the fleet is clean.
      let rowsMayExist: boolean;
      try {
        const resolved = resolvePhysicalStores({
          cfg: params.cfg,
          env,
          legacyAgentId,
          mode: params.mode,
        });
        rowsMayExist =
          resolved.unreadable.length > 0 ||
          resolved.jsonPaths.length > 0 ||
          (await storesHaveLegacyAgentSessionKey({ env, legacyAgentId, stores: resolved.stores }));
      } catch {
        rowsMayExist = true;
      }
      if (!rowsMayExist) {
        return {
          ...base,
          armed: false,
          complete: true,
          ledgerComplete: false,
          outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
        };
      }
    }
    const unresolved = arming.reason === "owner-unresolved";
    return {
      ...base,
      armed: false,
      complete: false,
      ledgerComplete: false,
      outcomes: [{ kind: "not-armed", detail: arming.reason }],
      warnings: unresolved
        ? [
            `session: legacy ${legacyAgentId} rows have no unambiguous configured owner; preserve them and run openclaw doctor --fix after assigning agents.defaults.sessionStore.agentId`,
          ]
        : [],
    };
  }
  const ownerAgentId = arming.ownerAgentId;
  const resolved = resolvePhysicalStores({
    cfg: params.cfg,
    env,
    legacyAgentId,
    mode: params.mode,
    ownerAgentId,
  });
  const outcomes: LegacyMainSessionMigrationOutcome[] = [
    ...resolved.jsonPaths.map((pathname) => ({
      kind: "legacy-json-store" as const,
      paths: [pathname],
      detail: "Doctor must migrate JSON sessions to SQLite before legacy-main key migration",
    })),
    ...resolved.unreadable,
  ];
  const warnings = [...base.warnings];
  for (const unreadable of resolved.unreadable) {
    warnings.push(
      `session: could not inspect ${unreadable.paths?.[0] ?? "session store"}: ${unreadable.detail ?? "unknown error"}; run openclaw doctor --fix`,
    );
  }
  for (const pathname of resolved.jsonPaths) {
    warnings.push(
      `session: deferred legacy-main session migration for JSON store ${pathname}; run openclaw doctor --fix`,
    );
  }
  const scanParams = {
    env,
    legacyAgentId,
    ownerAgentId,
    stores: resolved.stores,
    onUnreadable: (store: PhysicalStore, error: unknown) => {
      if (params.mode === "doctor-fix") {
        throw new Error(`cannot read legacy session store ${store.path}: ${String(error)}`, {
          cause: error,
        });
      }
      outcomes.push({ kind: "store-unreadable", detail: String(error), paths: [store.path] });
      warnings.push(
        `session: could not inspect ${store.path}: ${String(error)}; run openclaw doctor --fix`,
      );
    },
  };
  const comparisonScan =
    params.mode === "detect" ? prepareComparisonClaimsFromStores(scanParams) : undefined;
  const identityBase = { legacyAgentId, mainKey, ownerAgentId };
  const identity = { ...identityBase, sourceLayout: resolveSourceLayout(resolved) };
  let matchingCompletedLedger = false;
  if (params.mode !== "doctor-fix" && outcomes.length === 0) {
    try {
      const ledger = await readLedger(env);
      comparisonScan?.assertCurrent();
      if (ledgerMatches(ledger, identity)) {
        matchingCompletedLedger = true;
        if (!params.forceScan) {
          return {
            ...base,
            armed: true,
            complete: true,
            ledgerComplete: true,
            ownerAgentId,
            outcomes: [{ kind: "no-legacy-rows", detail: "matching completed ledger" }],
          };
        }
      }
    } catch (error) {
      return {
        ...base,
        armed: true,
        complete: false,
        ledgerComplete: false,
        ownerAgentId,
        outcomes: [{ kind: "store-unreadable", detail: String(error) }],
        warnings: [
          `session: could not read the legacy-main migration ledger: ${String(error)}; run openclaw doctor --fix`,
        ],
      };
    }
  }

  const destinationLogical = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: ownerAgentId,
    env,
  });
  const destinationResolved = resolveSqliteTargetFromSessionStorePath(destinationLogical, {
    agentId: ownerAgentId,
    defaultAgentId: ownerAgentId,
    env,
  });
  const destination: PhysicalStore = resolved.stores.find((store) =>
    isSameOpenClawAgentDatabasePath(store.path, destinationResolved.path),
  ) ?? {
    databaseAgentId: normalizeAgentId(destinationResolved.agentId ?? ownerAgentId),
    ownerStorePath: destinationLogical,
    path: destinationResolved.path,
  };
  if (comparisonScan) {
    const { legacy, canonical } = await comparisonScan.read();
    comparisonScan.assertCurrent();
    if (legacy.length > 0) {
      warnings.push(
        `session: ${legacy.length} retained legacy ${legacyAgentId} session claim(s) require Doctor repair; run openclaw doctor --fix`,
      );
    }
    for (const [canonicalKey, aliases] of groupLegacyClaims(legacy)) {
      const compared = compareClaimGroup(
        aliases,
        canonical.filter((claim) => claim.key === canonicalKey),
        destination,
      );
      if (compared.divergence) {
        outcomes.push(
          describeDivergentClaims(compared.divergence, canonicalKey, compared.divergentClaims),
        );
        warnings.push(
          warningForDivergence(compared.divergence, canonicalKey, compared.divergentClaims),
        );
      } else {
        outcomes.push(
          describeIdenticalClaims({
            aliases,
            canonical: compared.destinationCanonical,
            canonicalKey,
            destination,
          }),
        );
      }
    }
    if (legacy.length === 0 && outcomes.length === 0) {
      outcomes.push({ kind: "no-legacy-rows" });
    }
    const complete = !outcomes.some(isBlockingOutcome);
    return {
      ...base,
      armed: true,
      complete,
      ledgerComplete: complete && matchingCompletedLedger && legacy.length === 0,
      outcomes,
      ownerAgentId,
      warnings,
    };
  }
  const { legacy: allLegacy, canonical: allCanonical } = readClaimsFromStores(scanParams);
  const destinationArchiveDirectory =
    params.mode !== "doctor-fix"
      ? undefined
      : resolveMissingPhysicalPath(
          path.join(resolveSessionArtifactDirectory(destinationResolved.path), "cold"),
        );

  for (const [canonicalKey, aliases] of groupLegacyClaims(allLegacy)) {
    const canonicalClaims = allCanonical.filter((claim) => claim.key === canonicalKey);
    if (
      params.mode === "doctor-fix" &&
      [...aliases, ...canonicalClaims].some(
        (claim) =>
          !samePhysicalStore(claim.store, destination) ||
          resolveMissingPhysicalPath(
            path.join(resolveSessionArtifactDirectory(claim.store.path), "cold"),
          ) !== destinationArchiveDirectory,
      )
    ) {
      await restoreColdSessionClaims(aliases, env, params.beforePersistentApply);
      await restoreColdSessionClaims(canonicalClaims, env, params.beforePersistentApply);
    }
    const { destinationCanonical, divergence, divergentClaims } = compareClaimGroup(
      aliases,
      canonicalClaims,
      destination,
    );
    if (divergence) {
      const outcome = describeDivergentClaims(divergence, canonicalKey, divergentClaims);
      if (params.mode === "doctor-fix") {
        const repaired = await repairDivergentClaims({
          beforePersistentApply: params.beforePersistentApply,
          canonicalKey,
          claims: divergentClaims,
          destination,
          ...(divergence === "divergent-canonical" && destinationCanonical
            ? { destinationCanonical }
            : {}),
          env,
          ownerAgentId,
        });
        outcome.quarantinedKeys = repaired.quarantinedKeys;
        if (repaired.resolved) {
          outcome.resolved = true;
        }
      }
      if (!outcome.resolved) {
        warnings.push(warningForDivergence(divergence, canonicalKey, divergentClaims));
      }
      outcomes.push(outcome);
      continue;
    }

    const outcome = await processIdenticalClaims({
      beforePersistentApply: params.beforePersistentApply,
      aliases,
      ...(destinationCanonical ? { canonical: destinationCanonical } : {}),
      canonicalKey,
      destination,
      env,
      mode: params.mode,
    });
    outcomes.push(outcome);
    if (outcome.kind === "divergent-aliases" || outcome.kind === "divergent-canonical") {
      warnings.push(warningForDivergence(outcome.kind, canonicalKey, aliases));
    }
  }

  if (allLegacy.length === 0 && outcomes.length === 0) {
    outcomes.push({ kind: "no-legacy-rows" });
  }
  const blocking = outcomes.some(isBlockingOutcome);
  const complete = !blocking;
  const changes =
    params.mode !== "doctor-fix"
      ? []
      : outcomes.flatMap((outcome) =>
          outcome.kind === "migrated-in-place" ||
          outcome.kind === "migrated-cross-store" ||
          outcome.kind === "canonical-exists-identical"
            ? [`Migrated legacy ${legacyAgentId} session claim ${outcome.canonicalKey}.`]
            : outcome.quarantinedKeys?.length
              ? [
                  `Quarantined ${outcome.quarantinedKeys.length} legacy ${legacyAgentId} session conflict(s).`,
                ]
              : [],
        );
  if (complete && params.mode === "doctor-fix") {
    writeLedger({
      beforePersistentApply: params.beforePersistentApply,
      env,
      identity: { ...identityBase, sourceLayout: resolveSourceLayout(resolved) },
      now: params.now?.() ?? Date.now(),
      outcomes,
      stateDir: resolveStateDir(env),
    });
  }
  return {
    armed: true,
    changes,
    complete,
    ledgerComplete:
      complete &&
      (params.mode === "doctor-fix" || (matchingCompletedLedger && allLegacy.length === 0)),
    legacyAgentId,
    mainKey,
    outcomes,
    ownerAgentId,
    warnings,
  };
}

export async function migrateLegacyMainSessionKeys(params: {
  beforePersistentApply?: () => void;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Bypass the startup ledger shortcut and verify the physical legacy stores. */
  forceScan?: boolean;
  legacyAgentId?: string;
  mode: LegacyMainSessionMigrationMode;
  now?: () => number;
}): Promise<LegacyMainSessionMigrationResult> {
  try {
    return await migrateLegacyMainSessionKeysInternal(params);
  } catch (error) {
    // Lost caller authority must abort setup, not become a retryable store warning.
    params.beforePersistentApply?.();
    if (params.mode === "doctor-fix") {
      throw error;
    }
    const legacyAgentId = normalizeAgentId(params.legacyAgentId ?? "main");
    const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
    const arming = resolveArmingDecision(params.cfg, legacyAgentId);
    return {
      armed: arming.armed,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId,
      mainKey,
      outcomes: [{ kind: "store-unreadable", detail: String(error) }],
      ...(arming.armed ? { ownerAgentId: arming.ownerAgentId } : {}),
      warnings: [
        `session: legacy-main session migration deferred: ${String(error)}; run openclaw doctor --fix`,
      ],
    };
  }
}
