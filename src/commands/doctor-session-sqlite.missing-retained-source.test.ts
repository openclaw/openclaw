import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const message = (id: string, parentId: string | null, content = id) => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content },
});

it.each(["import", "recover"] as const)(
  "%s settles a missing retained primary only when its recorded bytes match canonical history",
  async (mode) => {
    await withOpenClawTestState({ label: "missing-retained-primary" }, async (state) => {
      const { cfg, scope, storePath } = await seedDeferredPluginSessionSource(state, "default");
      const run = (importMode: "import" | "recover") =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: importMode });
      const repairCodes = async () =>
        (await run(mode)).targets.flatMap(({ issues }) => issues.map(({ code }) => code));
      const readTranscript = () => loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      const rows = [
        { type: "session", version: 3, id: "legacy-kept", timestamp: "", cwd: "" },
        ...Array.from({ length: 10 }, (_, i) => message(`m${i}`, i ? `m${i - 1}` : null)),
      ];
      fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const target = (await run("import")).targets[0]!;
      const receiptParams = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
      const canonical = readTranscript();
      expect(canonical).toHaveLength(11);
      fs.unlinkSync(transcript);
      // Match the reported shape: a diagnostic pointer survives without its primary.
      fs.writeFileSync(
        transcript.replace(/\.jsonl$/, ".trajectory-path.json"),
        '{"traceSchema":"openclaw-trajectory-pointer","runtimeFile":"missing.trajectory.jsonl"}',
      );

      // The same row count cannot prove the missing content; leave its receipt active.
      const transcriptScope = { ...scope, sessionKey: "agent:main:kept", sessionId: "legacy-kept" };
      await replaceTranscriptEvents(transcriptScope, [
        canonical[0]!,
        { ...rows[1]!, message: { role: "user", content: "Different history" } },
        ...canonical.slice(2),
      ]);
      expect(await repairCodes()).toContain("retained_plugin_source_conflict");
      expect(() => readDeferredPluginSessionImport(receiptParams)).toThrow(
        "Retained session migration source changed",
      );
      const extended = [...canonical, message("later", "m9", "Newer canonical history")];
      await replaceTranscriptEvents(transcriptScope, extended);

      expect(await repairCodes()).toContain("retained_plugin_source_index_rebuilt");
      const receipt = readDeferredPluginSessionImport(receiptParams)!;
      expect(receipt.sources.some((source) => source.path === transcript)).toBe(false);
      expect(
        receipt.settledSources?.map(({ path: sourcePath, reason }) => [sourcePath, reason]),
      ).toContainEqual([transcript, expect.stringContaining("SHA-256")]);
      expect(readTranscript()).toEqual(extended);

      if (mode === "import") {
        const id = "fixture-plugin";
        const root = state.statePath(id);
        const marker = state.statePath("post-session-completed");
        await state.writeJson(`${id}/package.json`, { openclaw: { extensions: ["./index.cjs"] } });
        await state.writeText(`${id}/index.cjs`, "module.exports = {};\n");
        const action = { id: "session-state", phase: "after-session-repair", doctorOnly: true };
        const manifest = { id, configSchema: {}, doctorContract: { stateMigrations: [action] } };
        await state.writeJson(`${id}/openclaw.plugin.json`, manifest);
        await state.writeText(
          `${id}/doctor-contract-api.cjs`,
          `
const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: "Synthetic session state",
  detectLegacyState: () => fs.existsSync(${JSON.stringify(marker)}) ? null : { preview: ["pending"] },
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(marker)}, "completed");
    return { changes: ["Completed synthetic session state"], warnings: [] };
  },
}] };\n`,
        );
        cfg.plugins = {
          allow: [id],
          load: { paths: [root] },
          entries: { [id]: { enabled: true } },
        };
        await state.writeConfig(cfg);
        await state.writeJson("agent/settings.json", {});
        const migration = await autoMigrateLegacyState({
          cfg,
          env: state.env,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
        });
        const outcome = (stepId: string) =>
          migration.stepReceipts.find((step) => step.id === stepId)?.outcome;
        expect(outcome("acp-session-metadata")).not.toBe("refused");
        expect(outcome("agent-dir")).toBe("completed");
        const steps: [string, string][] = [];
        await noteSessionTranscriptHealth({
          cfg,
          env: state.env,
          shouldRepair: true,
          postSessionPluginMigration: migration.postSessionPluginMigration,
          onStepReceipt: (step) => steps.push([step.id, step.outcome]),
        });
        expect(steps).toContainEqual(["plugin-doctor-post-session-state", "completed"]);
        expect(fs.readFileSync(marker, "utf8")).toBe("completed");
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
      }
    });
  },
);
