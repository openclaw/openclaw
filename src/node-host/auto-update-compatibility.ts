import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { tryReadJson } from "../infra/json-files.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  resolveSqliteInspectionBudget,
  runSqliteReadOnlyWorker,
} from "../infra/sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { checkGitCandidateNodeRuntime } from "../infra/update-runner-git-node-preflight.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { readAgentDatabasePreflightTargets } from "../state/openclaw-agent-db-registry.read.js";
import { preflightOpenClawDatabaseSchemas } from "../state/openclaw-database-preflight.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const MANUAL_UPDATE_GUIDANCE =
  "Update OpenClaw manually with openclaw update, then restart the node.";

export function assertNodeRuntimeSchemaVersions(
  schemaVersions: OpenClawSchemaVersions | undefined,
): asserts schemaVersions is OpenClawSchemaVersions {
  // Binary rollback cannot undo a schema migration shared with another process.
  // The normal updater owns the backup and exclusion needed to cross this boundary.
  if (
    schemaVersions?.state !== OPENCLAW_STATE_SCHEMA_VERSION ||
    schemaVersions.agent !== OPENCLAW_AGENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Node auto-update deferred: the release changes database schemas. ${MANUAL_UPDATE_GUIDANCE}`,
    );
  }
}

/** Read the candidate's real startup contract without loading its execution graph. */
export async function readNodeRuntimeUpdateManifest(packageRoot: string): Promise<{
  version: string;
  schemaVersions: OpenClawSchemaVersions;
}> {
  const manifest = asNullableRecord(
    await tryReadJson<unknown>(path.join(packageRoot, "package.json"), { maxBytes: 1024 * 1024 }),
  );
  const version = normalizeNullableString(manifest?.version);
  if (manifest?.name !== "openclaw" || !version) {
    throw new Error("Node auto-update candidate has no valid OpenClaw package manifest.");
  }
  const schemaVersions = parsePackageOpenClawSchemaVersions(manifest);
  assertNodeRuntimeSchemaVersions(schemaVersions);
  for (const relativePath of [
    "openclaw.mjs",
    "node-host-launcher.mjs",
    "dist/node-host-launcher-bootstrap.js",
  ]) {
    if (!(await fs.stat(path.join(packageRoot, relativePath))).isFile()) {
      throw new Error(`Node auto-update candidate is missing ${relativePath}.`);
    }
  }
  const entrypoints = await Promise.all(
    ["dist/entry.js", "dist/entry.mjs"].map(async (relativePath) => {
      try {
        return (await fs.stat(path.join(packageRoot, relativePath))).isFile();
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      }
    }),
  );
  if (!entrypoints.some(Boolean)) {
    throw new Error("Node auto-update candidate is missing its built CLI entrypoint.");
  }
  return { version, schemaVersions };
}

/** Recheck after waiting for idle; these observations do not authorize state migration. */
export async function assertNodeRuntimeUpdateCompatible(params: {
  packageRoot: string;
  stateDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  const { version, schemaVersions } = await readNodeRuntimeUpdateManifest(params.packageRoot);
  const nodeRuntimeFailure = await checkGitCandidateNodeRuntime(params.packageRoot, version);
  if (nodeRuntimeFailure) {
    throw new Error(
      nodeRuntimeFailure.stderrTail ?? "Node runtime is incompatible with the update.",
    );
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const current = await preflightOpenClawDatabaseSchemas({
    env,
    signal: params.signal,
    supportedVersions: schemaVersions,
    verifyCurrentSchemaShape: true,
  });
  if (
    current.incompatible.length ||
    current.indeterminate.length ||
    current.pendingMigrations?.length
  ) {
    throw new Error(
      `Node auto-update deferred: existing databases require migration or repair. ${MANUAL_UPDATE_GUIDANCE}`,
    );
  }
  const statePath = resolveOpenClawStateSqlitePath(env);
  try {
    await fs.stat(statePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  const preflightCopy = async (sourcePath: string, agentId?: string) => {
    const copy = await prepareSqliteReadOnlyLocation(await fs.realpath(sourcePath), {
      preserveSourceArtifacts: true,
      signal: params.signal,
    });
    let outcome:
      | { agents: ReturnType<typeof readAgentDatabasePreflightTargets> }
      | { error: unknown };
    try {
      const consolidated = await runSqliteReadOnlyWorker(copy.location, {
        mode: "consolidated",
        stagingRoot: path.dirname(copy.location),
        signal: params.signal,
      });
      const { timeoutMs } = resolveSqliteInspectionBudget(
        "node update compatibility",
        sourcePath,
        (await fs.stat(consolidated)).size,
      );
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          path.join(params.packageRoot, "openclaw.mjs"),
          "database",
          agentId === undefined ? "preflight" : "preflight-agent",
          consolidated,
          ...(agentId === undefined ? [] : ["--agent-id", agentId]),
          "--json",
        ],
        { timeoutMs, signal: params.signal, killProcessTree: true, env },
      );
      let report: Record<string, unknown> | null = null;
      try {
        report = asNullableRecord(JSON.parse(result.stdout));
      } catch {
        // Command failures may provide only stderr rather than a JSON report.
      }
      const expectedSchema =
        agentId === undefined
          ? "openclaw.state-schema-preflight.v1"
          : "openclaw.agent-schema-preflight.v1";
      if (result.code !== 0 || report?.schema !== expectedSchema || report.status !== "exact") {
        const detail = normalizeNullableString(report?.reason) ?? result.stderr.trim();
        throw new Error(
          `Node auto-update candidate rejected the copied database${detail ? `: ${detail}` : "."} ${MANUAL_UPDATE_GUIDANCE}`,
        );
      }
      if (agentId !== undefined) {
        outcome = { agents: [] };
      } else {
        const database = openNodeSqliteDatabase(consolidated, { readOnly: true });
        try {
          outcome = { agents: readAgentDatabasePreflightTargets(database, statePath) };
        } finally {
          database.close();
        }
      }
    } catch (error) {
      outcome = { error };
    }
    try {
      if (!(await copy.cleanupAsync())) {
        throw new Error(
          `Node auto-update database snapshot cleanup failed: ${copy.cleanupRoot ?? copy.location}`,
        );
      }
    } catch (error) {
      throw "error" in outcome
        ? new AggregateError(
            [outcome.error, error],
            "Node auto-update compatibility and cleanup failed",
          )
        : error;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.agents;
  };
  const agents = await preflightCopy(statePath);
  for (const agent of agents) {
    try {
      await fs.stat(agent.path);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    await preflightCopy(agent.path, agent.agentId);
  }
  params.signal?.throwIfAborted();
}
