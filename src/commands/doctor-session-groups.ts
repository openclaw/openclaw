import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql, type Selectable } from "kysely";
import {
  resolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveConfiguredAgentDatabaseCandidatePaths,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { ensureOpenClawAgentDatabasePermissions } from "../state/openclaw-agent-db-permissions.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import {
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db-schema.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  ensureSessionGroupsSchema,
  parseSessionGroupSectionOrder,
  type SessionGroupsDatabase,
} from "../state/openclaw-agent-session-groups-schema.js";
import {
  assertLegacySessionGroupsSchema,
  withSessionGroupRetirementProof,
} from "../state/openclaw-session-groups-retirement.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { planAgentDatabaseRelativePaths } from "../state/openclaw-state-db-schema-repair.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { repairOpenClawStateDatabaseSchema } from "../state/openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "../state/openclaw-state-db.paths.js";
import { readStateSchemaPublicationBlocker } from "../state/openclaw-state-schema-publication.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import { VERSION } from "../version.js";
import { planDoctorLegacySessionImports } from "./doctor-session-sqlite.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

type Group = Selectable<SessionGroupsDatabase["session_groups"]>;
type Plan = {
  groups: Group[];
  order: string[];
  members: Array<[string, string, string]>;
  legacySources: Array<[string, string]>;
  destinations: Map<string, Group[]>;
};
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function close(db: DatabaseSync) {
  clearNodeSqliteKyselyCacheForDatabase(db);
  db.close();
}
function read<T>(pathname: string, run: (db: DatabaseSync) => T): T {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return run(db);
  } finally {
    close(db);
  }
}
function readOrder(db: DatabaseSync): string[] {
  const row = tableExists(db, "config_machine_state")
    ? db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("sidebar.sectionOrder")
    : undefined; // sqlite-allow-raw -- Reads the legacy singleton without migrating the source.
  if (row) {
    return parseSessionGroupSectionOrder(String(row.value_json));
  }
  // The v12 fold-in preserves an existing row, but imports the old table when that row is absent.
  if (!tableExists(db, "sidebar_sections")) {
    return [];
  }
  return db
    .prepare("SELECT section_id FROM sidebar_sections ORDER BY position, section_id")
    .all()
    .map((entry) => String(entry.section_id)); // sqlite-allow-raw -- Reads the pre-v12 order before historical fold-in.
}

function snapshot(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): Plan {
  const statePath = resolveOpenClawStateSqlitePath(env);
  const { groups, order, version } = read(statePath, (db) => {
    assertOpenClawStateDatabaseOwner(db, { pathname: statePath });
    assertSqliteIntegrity(db, statePath);
    // Snapshot is reread under final retirement proof as well as before any destination write.
    const blocker = readStateSchemaPublicationBlocker(db);
    if (blocker) {
      throw new UpdateSchemaRefusalError(
        [
          {
            kind: "state",
            path: statePath,
            foundVersion: readStateSchemaContentVersion(db),
            supportedVersion: 17,
          },
        ],
        blocker.updaterVersion,
        {
          targetVersion: VERSION,
          cause: new Error(
            `Session-group retirement must publish schema17 immediately. Update run ${blocker.runId} still blocks publication${blocker.publishAfterMs === null ? "; repair its unfinished terminal ledger before retrying" : ` until ${new Date(blocker.publishAfterMs).toISOString()}; wait for its existing publication deadline before retrying Doctor`}.`,
          ),
        },
      );
    }
    if (readStateSchemaContentVersion(db) === 16 && !tableExists(db, "session_groups")) {
      throw new Error(`Required legacy session_groups table is missing at ${statePath}`);
    }
    assertLegacySessionGroupsSchema(db, statePath);
    const legacyGroups: Group[] = tableExists(db, "session_groups")
      ? executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<SessionGroupsDatabase>(db)
            .selectFrom("session_groups")
            .select(["name", "position", "created_at"])
            .select(tableHasColumn(db, "session_groups", "cwd") ? "cwd" : sql<null>`NULL`.as("cwd"))
            .select(
              tableHasColumn(db, "session_groups", "worktree")
                ? "worktree"
                : sql<null>`NULL`.as("worktree"),
            )
            .orderBy("position")
            .orderBy("name"),
        ).rows
      : [];
    if (legacyGroups.some((group) => !group.name || group.name !== group.name.trim())) {
      throw new Error(
        "Legacy session-group names are not canonical; repair the source before migration",
      );
    }
    return {
      groups: legacyGroups,
      order: readOrder(db),
      version: readStateSchemaContentVersion(db),
    };
  });
  let registered = inspectOpenClawRegisteredAgentDatabases({
    env,
    includeIncompatibleSchemaVersions: true,
  });
  // Inventory the exact paths v9 will publish, without changing the shared source before copy verification.
  for (const change of planAgentDatabaseRelativePaths(registered, version, statePath)) {
    registered = registered.flatMap((row) => {
      if (row.agentId !== change.agentId || row.path !== change.from) {
        return [row];
      }
      return change.to === null ? [] : [{ ...row, path: change.to }];
    });
  }
  registered = registered.map((row) => ({
    ...row,
    path: resolveOpenClawRegisteredAgentDatabasePath(statePath, row.path),
  }));
  const configured = listConfiguredSessionStoreAgentIds(cfg).map((agentId) => {
    const resolved = resolveSqliteTargetFromSessionStorePath(
      resolveSessionStorePathCore(cfg.session?.store, { agentId, env }),
      {
        agentId,
        defaultAgentId: tryResolveLegacyCompatibilityAgentId(cfg),
        env,
        registeredDatabases: registered,
      },
    );
    return { agentId: resolved.agentId ?? agentId, path: resolved.path };
  });
  // Legacy fixed-store suffixes may survive after their registry entry disappears.
  for (const pathname of resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env })) {
    if (!fs.existsSync(pathname)) {
      continue;
    }
    const metadata = read(pathname, readExistingAgentSchemaMeta);
    if (!metadata?.agentId) {
      throw new Error(`Missing agent owner at ${pathname}`);
    }
    configured.push({ agentId: metadata.agentId, path: pathname });
  }
  const discovery = discoverAgentDatabaseMigrationTargets({
    configuredAgentDatabaseTargets: configured,
    registeredAgentDatabases: registered,
    env,
  });
  if (
    discovery.failures.length ||
    discovery.externalWarnings.length ||
    discovery.registryRemovals.length
  ) {
    throw new Error(
      [
        ...discovery.failures.map((f) => f.reason),
        ...discovery.externalWarnings,
        ...discovery.registryRemovals.map(
          (row) => `Unavailable registered session store: ${row.path}`,
        ),
      ].join("\n"),
    );
  }
  const sources = discovery.targets
    .map(({ agentId, path: storePath }) => ({ agentId, path: storePath }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const members: Plan["members"] = [];
  const entries = new Map<string, { agentId: string; key: string; category: string }>();
  // Non-category section order belongs to every known agent, even without a custom group.
  const destinations = new Map<string, Group[]>(
    listConfiguredSessionStoreAgentIds(cfg).map((agentId) => [agentId, []]),
  );
  const owners = new Map<string, Set<string>>();
  for (const source of sources) {
    read(source.path, (db) => {
      assertOpenClawAgentDatabaseOwner(db, { agentId: source.agentId, pathname: source.path });
      assertSupportedAgentSchemaVersion(db, source.path);
      assertSqliteIntegrity(db, source.path);
      if (!destinations.has(source.agentId)) {
        destinations.set(source.agentId, []);
      }
      const table = tableExists(db, "session_nodes")
        ? "session_nodes"
        : tableExists(db, "session_entries")
          ? "session_entries"
          : null;
      if (!table) {
        if (readSqliteUserVersion(db) < 19) {
          return;
        }
        throw new Error(
          `Agent session table is missing from ${source.path}; repair the source database before migrating groups.`,
        );
      }
      const rows = db
        .prepare(`SELECT session_key, entry_json FROM ${table} ORDER BY session_key`)
        .all(); // sqlite-allow-raw -- Both named historical canonical entry formats are migration inputs.
      for (const row of rows) {
        const entry: unknown = JSON.parse(String(row.entry_json));
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`Invalid session entry in ${source.path}`);
        }
        const category =
          "category" in entry && typeof entry.category === "string" ? entry.category.trim() : "";
        const key = String(row.session_key);
        const agentId = normalizeAgentId(parseAgentSessionKey(key)?.agentId ?? source.agentId);
        entries.set(`${source.path}\0${key}`, { agentId, key, category });
      }
    });
  }
  const legacy = planDoctorLegacySessionImports(cfg, env, registered);
  for (const record of legacy.records) {
    const agentId = normalizeAgentId(
      parseAgentSessionKey(record.sessionKey)?.agentId ?? record.agentId,
    );
    entries.set(`${record.sqlitePath}\0${record.sessionKey}`, {
      agentId,
      key: record.sessionKey,
      category: record.entry.category?.trim() ?? "",
    });
  }
  for (const { agentId, key, category } of entries.values()) {
    if (!destinations.has(agentId)) {
      destinations.set(agentId, []);
    }
    if (!category) {
      continue;
    }
    members.push([agentId, key, category]);
    const set = owners.get(category) ?? new Set<string>();
    set.add(agentId);
    owners.set(category, set);
  }
  members.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const append = (agentId: string, group: Group) => {
    const rows = destinations.get(agentId) ?? [];
    if (!rows.some((r) => r.name === group.name)) {
      rows.push(group);
    }
    destinations.set(agentId, rows);
  };
  for (const group of groups) {
    for (const agentId of owners.get(group.name) ?? [resolveAmbientOwnerAgentId(cfg)]) {
      append(agentId, group);
    }
  }
  let nextPosition = groups.reduce((max, g) => Math.max(max, g.position), -1) + 1;
  for (const [name, agents] of [...owners].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (groups.some((g) => g.name === name)) {
      continue;
    }
    const group: Group = {
      name,
      position: nextPosition++,
      created_at: 0,
      cwd: null,
      worktree: null,
    };
    for (const agentId of agents) {
      append(agentId, group);
    }
  }
  return { groups, order, members, destinations, legacySources: legacy.sources };
}
function agentOrder(order: string[], groups: Group[]): string[] {
  const names = new Set(groups.map((g) => g.name));
  return [...new Set(order.filter((id) => !id.startsWith("category:") || names.has(id.slice(9))))];
}
function planDigest(plan: Plan): string {
  return digest({
    groups: plan.groups,
    order: plan.order,
    members: plan.members,
    legacySources: plan.legacySources,
    agents: [...plan.destinations.keys()].toSorted(),
  });
}

/** Offline copy precedes any shared-schema writer, including config-health persistence. */
export async function migrateDoctorSessionGroups(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return;
  }
  const version = read(statePath, readStateSchemaContentVersion);
  if (version === 0 || version >= 17) {
    return;
  }
  await withDoctorSqliteMaintenanceLock({
    env,
    operation: "session-group migration",
    run: (authority) => {
      // Reentrant with Doctor's outer owner; standalone invocation must fence new leases too.
      const coordinator = acquireStateDatabaseCoordinator({
        databasePath: statePath,
        busyTimeoutMs: 0,
      });
      try {
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env });
        const plan = snapshot(cfg, env);
        const fingerprint = planDigest(plan);
        const destinations = new Map(plan.destinations);
        // Include interrupted imports whose agent is no longer a member after an old-runtime retry.
        const agentsDir = path.join(resolveStateDir(env), "agents");
        if (fs.existsSync(agentsDir)) {
          for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
              continue;
            }
            const agentId = normalizeAgentId(entry.name);
            const pathname = resolveOpenClawAgentSqlitePath({ agentId, env });
            if (!fs.existsSync(pathname)) {
              continue;
            }
            const staged = read(
              pathname,
              (db) =>
                tableExists(db, "session_group_state") &&
                Boolean(
                  db
                    .prepare(
                      "SELECT import_fingerprint FROM session_group_state WHERE singleton = 1",
                    )
                    .get()?.import_fingerprint,
                ),
            ); // sqlite-allow-raw -- Recognizes only this migration's durable import receipt.
            if (staged && !destinations.has(agentId)) {
              destinations.set(agentId, []);
            }
          }
        }
        const proofs: Array<{ agentId: string; pathname: string; rows: Group[]; order: string[] }> =
          [];
        for (const [agentId, rows] of destinations) {
          authority.assertCurrent();
          const pathname = resolveOpenClawAgentSqlitePath({ agentId, env });
          assertDoctorSqliteMaintenancePathsNotAliased(
            "session-group migration",
            [pathname],
            [resolveStateDir(env)],
          );
          ensureOpenClawAgentDatabasePermissions(pathname, { agentId, env });
          const db = openNodeSqliteDatabase(pathname);
          try {
            if (readSqliteUserVersion(db) === 0) {
              ensureOpenClawAgentDatabaseSchema(db, {
                agentId,
                path: pathname,
                env,
                register: false,
              });
            } else {
              assertOpenClawAgentDatabaseOwner(db, { agentId, pathname });
              assertSupportedAgentSchemaVersion(db, pathname);
              assertSqliteIntegrity(db, pathname);
            }
            const order = agentOrder(plan.order, rows);
            runSqliteImmediateTransactionSync(db, () => {
              authority.assertCurrent();
              assertOpenClawAgentDatabaseOwner(db, { agentId, pathname });
              ensureSessionGroupsSchema(db);
              const k = getNodeSqliteKysely<SessionGroupsDatabase>(db);
              const previous = executeSqliteQuerySync(
                db,
                k.selectFrom("session_group_state").selectAll(),
              ).rows[0];
              const existing = executeSqliteQuerySync(
                db,
                k.selectFrom("session_groups").selectAll(),
              ).rows;
              if (existing.length && !previous?.import_fingerprint) {
                throw new Error(`Unowned destination catalog at ${pathname}`);
              }
              executeSqliteQuerySync(db, k.deleteFrom("session_groups"));
              if (rows.length) {
                executeSqliteQuerySync(db, k.insertInto("session_groups").values(rows));
              }
              executeSqliteQuerySync(
                db,
                k
                  .insertInto("session_group_state")
                  .values({
                    singleton: 1,
                    section_order_json: JSON.stringify(order),
                    import_fingerprint: fingerprint,
                  })
                  .onConflict((c) =>
                    c.column("singleton").doUpdateSet({
                      section_order_json: JSON.stringify(order),
                      import_fingerprint: fingerprint,
                    }),
                  ),
              );
            });
            proofs.push({ agentId, pathname, rows, order });
          } finally {
            close(db);
          }
        }
        // Empty destination databases created during this copy add no membership facts.
        // The digest therefore covers catalog/order/members rather than discovery count.
        const verify = () => {
          authority.assertCurrent();
          if (planDigest(snapshot(cfg, env)) !== fingerprint) {
            throw new Error("Session-group source changed before cutover; rerun Doctor");
          }
          for (const proof of proofs) {
            read(proof.pathname, (db) => {
              assertOpenClawAgentDatabaseOwner(db, {
                agentId: proof.agentId,
                pathname: proof.pathname,
              });
              const k = getNodeSqliteKysely<SessionGroupsDatabase>(db);
              const rows = executeSqliteQuerySync(
                db,
                k.selectFrom("session_groups").selectAll().orderBy("position").orderBy("name"),
              ).rows;
              const state = executeSqliteQuerySync(
                db,
                k.selectFrom("session_group_state").selectAll(),
              ).rows[0];
              const expected = proof.rows.toSorted(
                (a, b) =>
                  a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
              );
              rows.sort(
                (a, b) =>
                  a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
              );
              if (
                rows.length !== expected.length ||
                digest(rows) !== digest(expected) ||
                state?.import_fingerprint !== fingerprint ||
                state.section_order_json !== JSON.stringify(proof.order)
              ) {
                throw new Error(
                  `Session-group destination verification failed at ${proof.pathname}`,
                );
              }
            });
          }
        };
        verify();
        const result = withSessionGroupRetirementProof(statePath, verify, () =>
          repairOpenClawStateDatabaseSchema({ env }),
        );
        if (result.warnings.length) {
          throw new Error(result.warnings.join("\n"));
        }
      } finally {
        coordinator.release();
      }
    },
  });
}
