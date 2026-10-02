import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  editAndDeleteImportedSessions,
  seedDeferredPluginSessionSource,
} from "../commands/doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

it.each([
  { layout: "default", changed: false },
  { layout: "external", changed: false },
  { layout: "legacy-root", changed: false },
  { layout: "default", changed: true },
] as const)(
  "rehearses retained $layout history without replay (changed=$changed)",
  async ({ layout, changed }) => {
    await withOpenClawTestState({ label: "rehearsal-retained-history" }, async (state) => {
      const { cfg, storePath, originals, scope } = await seedDeferredPluginSessionSource(
        state,
        layout,
      );
      if (layout === "legacy-root") {
        cfg.session = { store: storePath };
        scope.storePath = storePath;
      }
      const originalImport = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        mode: "import",
        allAgents: true,
      });
      expect(originalImport.totals.importedEntries).toBe(2);
      await editAndDeleteImportedSessions(scope, "kept canonical edit");
      if (changed) {
        const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
        await fs.appendFile(
          transcript,
          '\n{"type":"message","id":"changed","message":{"role":"user","content":"unverified source change"}}\n',
        );
        originals.set(transcript, await fs.readFile(transcript));
      }
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseByPathAsync(state.statePath("state", "openclaw.sqlite"));
      const candidateRoot = state.path("candidate");
      await materializeUpdateCandidateStateWorker(candidateRoot);
      const rehearsal = await prepareUpdateCandidateRehearsal({
        config: cfg,
        stateDir: state.stateDir,
        candidateRoot,
        env: state.env,
      });
      try {
        const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
        const result = await runDoctorSessionSqlite({
          cfg: copied,
          env: rehearsal.env,
          mode: "import",
          allAgents: true,
        });
        expect(result.totals.importedEntries).toBe(0);
        if (changed) {
          expect(result.targets.flatMap((target) => target.issues)).toContainEqual(
            expect.objectContaining({ code: "retained_plugin_source_conflict" }),
          );
        } else {
          expect(result.targets.flatMap((target) => target.issues)).not.toContainEqual(
            expect.objectContaining({ code: "retained_plugin_source_conflict" }),
          );
          expect(() =>
            assertSessionStoreMigrationComplete({
              cfg: copied,
              env: rehearsal.env,
              operation: "doctor",
            }),
          ).not.toThrow();
        }
        const target = result.targets.find((entry) => entry.agentId === "main");
        expect(target).toBeDefined();
        const copiedScope = { agentId: "main", storePath: target!.storePath, env: rehearsal.env };
        expect(
          loadExactSessionEntry({ ...copiedScope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("kept canonical edit");
        expect(
          loadExactSessionEntry({ ...copiedScope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        for (const [file, bytes] of originals) {
          expect(await fs.readFile(file)).toEqual(bytes);
        }
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("kept canonical edit");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
      } finally {
        await closeOpenClawAgentDatabasesAsync(rehearsal.stateDir);
        await rehearsal.cleanup();
      }
    });
  },
);

it.each(["local", "foreign", "absent-foreign"] as const)(
  "keeps an unreceipted shared-index row private (%s)",
  async (location) => {
    await withOpenClawTestState({ label: "rehearsal-mixed-receipt" }, async (state) => {
      const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "external");
      expect(
        (await runDoctorSessionSqlite({ cfg, env: state.env, mode: "import", allAgents: true }))
          .totals.importedEntries,
      ).toBe(2);
      cfg.agents!.entries!.ops = {};
      const foreignPath = state.path("foreign-root", "agents", "ops", "sessions", "pending.jsonl");
      const transcript =
        location === "foreign" ? foreignPath : path.join(path.dirname(storePath), "pending.jsonl");
      await fs.mkdir(path.dirname(transcript), { recursive: true });
      const history =
        '{"type":"session","version":3,"id":"pending"}\n{"type":"message","id":"one","message":{"role":"user","content":"new agent history"}}\n';
      await fs.writeFile(transcript, history);
      const entries = JSON.parse(await fs.readFile(storePath, "utf8"));
      entries["agent:ops:new"] = {
        sessionId: "pending",
        sessionFile: location === "local" ? "pending.jsonl" : foreignPath,
        updatedAt: 30,
      };
      const registry = JSON.stringify(entries);
      await fs.writeFile(storePath, registry);
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseByPathAsync(state.statePath("state", "openclaw.sqlite"));
      const candidateRoot = state.path("candidate");
      await materializeUpdateCandidateStateWorker(candidateRoot);
      let rehearsal: Awaited<ReturnType<typeof prepareUpdateCandidateRehearsal>> | undefined;
      try {
        const prepare = prepareUpdateCandidateRehearsal({
          config: cfg,
          stateDir: state.stateDir,
          candidateRoot,
          env: state.env,
        }).then((prepared) => {
          rehearsal = prepared;
          return prepared;
        });
        if (location !== "local") {
          await expect(prepare).rejects.toThrow(
            "unreceipted shared-index entry cannot be routed privately",
          );
        } else {
          const prepared = await prepare;
          const copied: OpenClawConfig = JSON.parse(await fs.readFile(prepared.configPath, "utf8"));
          const result = await runDoctorSessionSqlite({
            cfg: copied,
            env: prepared.env,
            mode: "import",
            allAgents: true,
          });
          expect(result.totals.importedEntries).toBe(1);
          expect(
            loadExactSessionEntry({
              agentId: "ops",
              sessionKey: "agent:ops:new",
              storePath: copied.session!.store!,
              env: prepared.env,
            })?.entry.sessionId,
          ).toBe("pending");
        }
        expect(await fs.readFile(storePath, "utf8")).toBe(registry);
        expect(await fs.readFile(transcript, "utf8")).toBe(history);
      } finally {
        if (rehearsal) {
          await closeOpenClawAgentDatabasesAsync(rehearsal.stateDir);
          await rehearsal.cleanup();
        }
      }
    });
  },
);
