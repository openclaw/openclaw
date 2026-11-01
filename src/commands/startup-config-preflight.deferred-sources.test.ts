import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readDeferredPluginSessionImport,
  recordDeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import * as fileDescriptor from "../infra/file-descriptor.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(() => vi.restoreAllMocks());

it("recovers config without hashing deferred sources and Doctor settles missing trajectory targets", async () => {
  await withSqliteReadOnlyWorkerScope(() =>
    withOpenClawTestState({ label: "startup-deferred-trajectories" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      const storePath = path.join(state.sessionsDir("main"), "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, "{}");
      openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
      const imported = await runDoctorSessionSqlite(options);
      await closeOpenClawAgentDatabasesAsync();
      const target = imported.targets[0]!;
      const params = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
      // Older completed imports retained diagnostic pointers without companion transcripts.
      // Use the receipt writer after real core validation, with the unchanged empty index.
      fs.writeFileSync(storePath, "{}");
      const pointers = new Map<string, Buffer>();
      const runtimes: string[] = [];
      const sources = [{ path: storePath, identity: readMigrationArtifactIdentity(storePath) }];
      for (let index = 0; index < 4; index++) {
        const runtimeFile = path.join(path.dirname(storePath), `gone-${index}.trajectory.jsonl`);
        const pointer = path.join(path.dirname(storePath), `gone-${index}.trajectory-path.json`);
        const bytes = Buffer.from(
          JSON.stringify({ traceSchema: "openclaw-trajectory-pointer", runtimeFile }),
        );
        fs.writeFileSync(runtimeFile, '{"traceSchema":"openclaw-trajectory"}\n');
        fs.writeFileSync(pointer, bytes);
        for (const file of [pointer, runtimeFile]) {
          sources.push({ path: file, identity: readMigrationArtifactIdentity(file) });
        }
        runtimes.push(runtimeFile);
        pointers.set(pointer, bytes);
      }
      recordDeferredPluginSessionImport({ ...params, pluginIds: [], sources, recordCount: 0 });
      for (const runtimeFile of runtimes) {
        fs.unlinkSync(runtimeFile);
      }
      const backup = {
        ...cfg,
        gateway: { mode: "local" },
        plugins: { enabled: false },
        meta: { migrations: { webhookListeners: true } },
      };
      fs.writeFileSync(state.configPath, '{"update":{"channel":"stable"}}\n');
      fs.writeFileSync(`${state.configPath}.bak`, JSON.stringify(backup));
      const hash = vi.spyOn(fileDescriptor, "hashFileDescriptorSync");

      const ready = await runStartupConfigPreflight({ gateway: true });
      expect(ready.snapshot.valid).toBe(true);
      expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toEqual(backup);
      expect(hash).not.toHaveBeenCalled();
      hash.mockRestore();

      const repaired = await runDoctorSessionSqlite(options);
      expect(repaired.targets.flatMap((entry) => entry.issues).map((issue) => issue.code)).toEqual([
        "retained_plugin_source_index_rebuilt",
      ]);
      expect(readDeferredPluginSessionImport(params)).toBeUndefined();
      const moves = listSessionSqliteMigrationManifestPaths(state.env)
        .flatMap((file) => readSessionSqliteMigrationManifest(file)?.targets ?? [])
        .flatMap((entry) => entry.completedMoves);
      for (const [pointer, bytes] of pointers) {
        expect(fs.existsSync(pointer)).toBe(false);
        const move = moves.find((entry) => entry.sourcePath === pointer)!;
        expect(fs.readFileSync(move.archivePath)).toEqual(bytes);
      }
      expect((await runDoctorSessionSqlite(options)).totals.issues).toBe(0);
    }),
  );
});
