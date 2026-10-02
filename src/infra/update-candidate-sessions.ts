import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root } from "@openclaw/fs-safe";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { collectHistoricalArchiveSources } from "../commands/doctor-session-sqlite-discovery.js";
import {
  filterLegacySessionStoreTargets,
  resolveDoctorSessionSqliteTargets,
} from "../commands/doctor-session-sqlite-targets.js";
import {
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import {
  listLegacySessionTranscriptFiles,
  isLegacySessionRecordOwnedByTarget,
  resolveLegacyTranscriptPaths,
  shouldFilterLegacySessionRecordsByTarget,
  type LegacySessionStoreTarget,
} from "../config/sessions/legacy-store-inspection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRetainedAgentDeletionsFromDatabase } from "../state/agent-deletion-journal.read.js";
import { readRegisteredAgentDatabaseRows } from "../state/openclaw-agent-db-registry.read.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  DeferredPluginSessionImportSchema,
  resolveVerifiedSessionSource,
} from "./deferred-plugin-session-sources.js";
import { readDeferredPluginSessionImportReceipt } from "./deferred-plugin-session-verification.js";
import { resolveUserPath } from "./home-dir.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import { assertSafeSessionSqliteMigrationDirectory } from "./session-sqlite-migration-manifest.js";
import { parseSessionStoreJson5 } from "./state-migrations.fs.js";
import { resolveUpdateCandidateStatePath } from "./update-candidate-paths.js";
import type { CapturedSessionReceipt } from "./update-candidate-session-receipts.js";
import { readUpdateRuns } from "./update-run-read.kernel.js";

type Input = { stateDir: string; config: OpenClawConfig; env?: NodeJS.ProcessEnv };
type Source = { identity: MigrationArtifactIdentity; bytes?: Buffer };
type Selection = {
  locator: { sessionId: string; sessionFile: unknown };
  selected?: string;
  candidates: Map<string, MigrationArtifactIdentity | undefined>;
  owners: LegacySessionStoreTarget[];
};

/** Preserve external family ancestry: Doctor derives database ownership from this layout. */
function sessionPath(sourceRoot: string, targetRoot: string, source: string): string {
  return isPathInside(sourceRoot, source)
    ? resolveUpdateCandidateStatePath(sourceRoot, targetRoot, source)
    : path.join(
        targetRoot,
        "candidate-session-inputs",
        sha256Hex(path.parse(source).root),
        path.relative(path.parse(source).root, source),
      );
}

/** Inventory only Doctor's declared live inputs; malformed indexes still reach isolated Doctor. */
export async function prepareUpdateCandidateSessions(input: Input, database?: DatabaseSync) {
  const env = { ...(input.env ?? process.env), OPENCLAW_STATE_DIR: input.stateDir };
  const statePath = resolveOpenClawStateSqlitePath(env);
  const snapshot = database
    ? {
        registeredAgentDatabases: readRegisteredAgentDatabaseRows(database, statePath, true),
        retainedDeletions: readRetainedAgentDeletionsFromDatabase(
          database,
          statePath,
          "maintenance",
        ),
      }
    : undefined;
  const physicalPaths = new Map<LegacySessionStoreTarget, string>();
  const { targets } = withArtifactPreservingStateReads(() =>
    resolveDoctorSessionSqliteTargets({
      cfg: input.config,
      env,
      mode: "import",
      allAgents: true,
      prepared: { snapshot, physicalPaths },
    }),
  );
  const historical = collectHistoricalArchiveSources({
    cfg: input.config,
    env,
    readUpdateRuns: () => (database ? readUpdateRuns(database, { limit: 100 }) : []),
  }).sources;
  const historicalTargets = filterLegacySessionStoreTargets(
    targets,
    "import",
    historical,
    new Set(),
  );
  const sources = new Map<string, Source>();
  const missingSources = new Map<string, { archiveBacked: boolean }>();
  const receipts = new Map<LegacySessionStoreTarget, CapturedSessionReceipt>();
  const indexes = new Map<string, Record<string, unknown>>();
  const selections = new Map<string, Map<string, Selection>>();
  const identityAt = (filename: string) => {
    try {
      return readMigrationArtifactIdentity(filename);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  };
  const add = async (suppliedPath: string, index = false) => {
    const filename = path.resolve(suppliedPath);
    if (sources.has(filename)) {
      return;
    }
    let identity: MigrationArtifactIdentity;
    try {
      identity = readMigrationArtifactIdentity(filename);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    const source: Source = { identity };
    if (index) {
      assertSafeSessionSqliteMigrationDirectory(path.dirname(filename));
      const directory = await root(path.dirname(filename));
      source.bytes = (
        await directory.read(path.basename(filename), {
          hardlinks: "reject",
          symlinks: "reject",
          maxBytes: identity.size,
        })
      ).buffer;
      if (!sameMigrationArtifact(identity, readMigrationArtifactIdentity(filename))) {
        throw new Error(`Legacy session input changed during snapshot inventory: ${filename}`);
      }
      const parsed = parseSessionStoreJson5(source.bytes.toString("utf8"));
      if (parsed.ok) {
        indexes.set(filename, parsed.store);
      }
    }
    sources.set(filename, source);
  };
  const addTranscript = async (filename: string) => {
    for (const source of [
      filename,
      resolveTrajectoryPath(filename),
      resolveTrajectoryPointerPath(filename),
    ]) {
      if (source) {
        await add(source);
      }
    }
  };
  const stores = targets.filter((target) => !target.storePath.endsWith(".sqlite"));
  const physicalTargets = targets.map((target) => ({
    agentId: target.agentId,
    sourceTarget: target,
    storePath: path.resolve(target.storePath),
    sqlitePath: expectDefined(
      physicalPaths.get(target),
      "Session target has no captured physical path",
    ),
  }));
  if (database) {
    for (const target of physicalTargets) {
      const receipt = readDeferredPluginSessionImportReceipt({
        target,
        sqlitePath: target.sqlitePath,
        database,
        env,
      });
      if (receipt) {
        const recorded = DeferredPluginSessionImportSchema.parse(JSON.parse(receipt.reportJson));
        receipts.set(target.sourceTarget, { receipt, recorded });
        for (const source of recorded.sources) {
          await add(source.path, source.path === target.storePath);
          if (!sources.has(source.path)) {
            missingSources.set(source.path, {
              archiveBacked: resolveVerifiedSessionSource(source, target, env) !== undefined,
            });
          }
        }
      }
    }
  }
  for (const storePath of new Set(stores.map((target) => path.resolve(target.storePath)))) {
    await add(storePath, true);
    for (const transcript of listLegacySessionTranscriptFiles(path.dirname(storePath))) {
      await addTranscript(transcript);
    }
    const selected = new Map<string, Selection>();
    for (const [sessionKey, entry] of Object.entries(indexes.get(storePath) ?? {})) {
      if (!isRecord(entry) || typeof entry.sessionId !== "string" || !entry.sessionId.trim()) {
        continue;
      }
      const sessionId = entry.sessionId;
      const owners = stores.filter(
        (target) =>
          path.resolve(target.storePath) === storePath &&
          (!shouldFilterLegacySessionRecordsByTarget(target) ||
            isLegacySessionRecordOwnedByTarget(input.config, target, sessionKey)),
      );
      const locator = { sessionId, sessionFile: entry.sessionFile };
      const records = owners.map((target) =>
        resolveLegacyTranscriptPaths(target, locator, undefined, env),
      );
      if (new Set(records.map((record) => record.transcriptPath)).size > 1) {
        throw new Error(
          `Legacy session ${sessionKey} has conflicting transcript owners in ${storePath}`,
        );
      }
      const record = records[0];
      if (!record) {
        continue;
      }
      const candidates = new Map(
        record.transcriptCandidates.map((candidate) => [candidate, identityAt(candidate)]),
      );
      selected.set(sessionKey, { locator, selected: record.transcriptPath, candidates, owners });
      if (record.transcriptPath) {
        await addTranscript(record.transcriptPath);
      }
    }
    selections.set(storePath, selected);
  }
  for (const [target, captured] of receipts) {
    const storePath = path.resolve(target.storePath);
    const source = sources.get(storePath);
    if (source?.bytes) {
      captured.index = {
        identity: source.identity,
        bytes: source.bytes,
        records: [...(selections.get(storePath)?.values() ?? [])]
          .filter((selection) => selection.owners.includes(target))
          .map((selection) => selection.locator),
      };
    }
  }
  const bytes = [...sources.values()].reduce((sum, source) => sum + source.identity.size, 0);
  return {
    bytes,
    // Doctor can retire a receipt before selecting history; its presence cannot silence omissions.
    warnings: historicalTargets.some((target) => historical.has(path.resolve(target.storePath)))
      ? [
          "Optional archived session recovery was not rehearsed; original archives and migration receipts remain unchanged. Run openclaw doctor --fix on the serving state if history needs recovery.",
        ]
      : [],
    receipts,
    targets: physicalTargets,
    project(targetRoot: string, supportsSessionProjection: boolean) {
      const project = (source: string) => sessionPath(input.stateDir, targetRoot, source);
      const databasePaths = new Map(
        physicalTargets.map((target) => {
          const source = target.sqlitePath;
          return [
            source,
            supportsSessionProjection
              ? project(source)
              : path.join(
                  resolveUpdateCandidateStatePath(input.stateDir, targetRoot, path.dirname(source)),
                  path.basename(source),
                ),
          ];
        }),
      );
      const statePaths = Object.fromEntries(
        [...databasePaths].map(([source, copied]) => [path.dirname(source), path.dirname(copied)]),
      );
      return {
        path: project,
        databasePaths,
        statePaths,
        sessionStore: input.config.session?.store
          ? project(resolveUserPath(input.config.session.store, env))
          : undefined,
      };
    },
    async copy(
      targetRoot: string,
      project: (source: string) => string,
      preservedIndexes: ReadonlySet<string>,
    ) {
      const destination = await root(targetRoot);
      const paths = new Map(
        [...sources.keys(), ...missingSources.keys()].map((source) => [source, project(source)]),
      );
      if (
        [...paths.values()].some(
          (copied) => !path.isAbsolute(copied) || !isPathInside(targetRoot, copied),
        ) ||
        new Set([...paths.values()].map((copied) => path.resolve(copied))).size !== paths.size
      ) {
        throw new Error("Legacy session inputs do not have distinct private snapshot paths");
      }
      for (const [sourcePath, source] of sources) {
        const target = paths.get(sourcePath)!;
        const before = readMigrationArtifactIdentity(sourcePath);
        if (!sameMigrationArtifact(source.identity, before)) {
          throw new Error(`Legacy session input changed before snapshot: ${sourcePath}`);
        }
        const parsed = indexes.get(sourcePath);
        const selected = selections.get(sourcePath);
        for (const record of selected?.values() ?? []) {
          for (const [candidate, admitted] of record.candidates) {
            const current = identityAt(candidate);
            if (admitted ? !current || !sameMigrationArtifact(admitted, current) : current) {
              throw new Error(
                `Legacy session transcript selection changed before snapshot: ${candidate}`,
              );
            }
          }
        }
        let rewritten: Buffer | undefined;
        if (parsed && !preservedIndexes.has(sourcePath)) {
          for (const [key, record] of selected ?? []) {
            const entry = parsed[key];
            if (isRecord(entry) && record.selected) {
              entry.sessionFile = project(record.selected);
            }
          }
          rewritten = Buffer.from(JSON.stringify(parsed));
          await destination.create(path.relative(targetRoot, target), rewritten, {
            mkdir: true,
            mode: 0o600,
          });
        } else {
          await destination.copyIn(
            path.relative(targetRoot, target),
            { root: await root(path.dirname(sourcePath)), relativePath: path.basename(sourcePath) },
            { mkdir: true, mode: 0o600, sourceHardlinks: "reject", maxBytes: source.identity.size },
          );
        }
        if (!sameMigrationArtifact(source.identity, readMigrationArtifactIdentity(sourcePath))) {
          throw new Error(`Legacy session input changed while copying: ${sourcePath}`);
        }
        const copied = readMigrationArtifactIdentity(target);
        const expected = rewritten
          ? { size: rewritten.length, sha256: sha256Hex(rewritten) }
          : source.identity;
        if (copied.size !== expected.size || copied.sha256 !== expected.sha256) {
          throw new Error(`Legacy session copy differs from its admitted source: ${sourcePath}`);
        }
      }
      for (const [sourcePath, missing] of missingSources) {
        if (missing.archiveBacked || statMigrationPath(paths.get(sourcePath)!)) {
          throw new Error(
            "A retained session source requires its migration archive or would become present only in the copy. Preserve the original state and run openclaw doctor --fix against it before retrying the update.",
          );
        }
      }
      // One agent's receipt binds the entire shared index. Unreceipted rows
      // cannot be rewritten either, so admit only their existing private route.
      for (const sourcePath of preservedIndexes) {
        for (const selection of selections.get(sourcePath)?.values() ?? []) {
          for (const owner of selection.owners) {
            if (receipts.has(owner)) {
              continue;
            }
            const actual = resolveLegacyTranscriptPaths(
              { ...owner, storePath: project(sourcePath) },
              selection.locator,
              undefined,
              { ...env, OPENCLAW_STATE_DIR: targetRoot },
            );
            const expected = selection.selected ? project(selection.selected) : undefined;
            const raw =
              typeof selection.locator.sessionFile === "string"
                ? selection.locator.sessionFile.trim()
                : undefined;
            if (
              (raw && path.isAbsolute(raw) && !isPathInside(targetRoot, raw)) ||
              actual.transcriptCandidates.some(
                (candidate) => !isPathInside(targetRoot, candidate),
              ) ||
              actual.transcriptPath !== expected
            ) {
              throw new Error(
                "An unreceipted shared-index entry cannot be routed privately without changing a retained import's index. Preserve the original state and run openclaw doctor --session-sqlite import --session-sqlite-all-agents with the same state and configuration before retrying the update.",
              );
            }
          }
        }
      }
      // Copies are sealed once here. Receipt projection retains the original
      // hashes and per-owner source sets; it must not refresh their authority.
      return paths;
    },
  };
}
