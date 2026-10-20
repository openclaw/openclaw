import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const message = (id: string, content: string, parentId: string | null = null) => ({
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
      const readTranscript = () => loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" });
      const writeJson = (file: string, value: unknown) =>
        fs.writeFileSync(file, JSON.stringify(value));
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      const rows = [
        { type: "session", version: 3, id: "legacy-kept", timestamp: "", cwd: "" },
        ...Array.from({ length: 10 }, (_, index) =>
          message(
            `message-${index}`,
            `Synthetic message ${index}`,
            index ? `message-${index - 1}` : null,
          ),
        ),
      ];
      fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const target = (await run("import")).targets[0]!;
      const receiptParams = { cfg, env: state.env, target, sqlitePath: target.sqlitePath };
      const canonical = readTranscript();
      expect(canonical).toHaveLength(11);
      fs.unlinkSync(transcript);
      // Match the reported shape: a diagnostic pointer survives without its primary.
      const pointer = transcript.replace(/\.jsonl$/, ".trajectory-path.json");
      writeJson(pointer, {
        traceSchema: "openclaw-trajectory-pointer",
        runtimeFile: "missing.trajectory.jsonl",
      });

      // The same row count cannot prove the missing content; leave its receipt active.
      const transcriptScope = { ...scope, sessionKey: "agent:main:kept", sessionId: "legacy-kept" };
      await replaceTranscriptEvents(transcriptScope, [
        canonical[0]!,
        { ...rows[1]!, message: { role: "user", content: "Different history" } },
        ...canonical.slice(2),
      ]);
      const refused = await run(mode);
      expect(refused.targets.flatMap((entry) => entry.issues)).toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      );
      expect(() => readDeferredPluginSessionImport(receiptParams)).toThrow(
        "Retained session migration source changed",
      );
      const extended = [...canonical, message("later", "Newer canonical history", "message-9")];
      await replaceTranscriptEvents(transcriptScope, extended);

      const recovered = await run(mode);
      expect(recovered.targets.flatMap((entry) => entry.issues)).toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_index_rebuilt" }),
      );
      const receipt = readDeferredPluginSessionImport(receiptParams)!;
      expect(receipt.sources.some((source) => source.path === transcript)).toBe(false);
      expect(receipt.settledSources).toContainEqual(
        expect.objectContaining({
          path: transcript,
          reason: expect.stringContaining("SHA-256"),
        }),
      );
      expect(readTranscript()).toEqual(extended);

      if (mode === "import") {
        const pluginRoot = state.statePath("fixture-plugin");
        const marker = state.statePath("post-session-completed");
        await state.writeJson("fixture-plugin/package.json", {
          name: "@example/fixture-plugin",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        await state.writeText("fixture-plugin/index.cjs", "module.exports = {};\n");
        const action = { id: "session-state", phase: "after-session-repair", doctorOnly: true };
        await state.writeJson("fixture-plugin/openclaw.plugin.json", {
          id: "fixture-plugin",
          configSchema: {},
          doctorContract: { stateMigrations: [action] },
        });
        await state.writeText(
          "fixture-plugin/doctor-contract-api.cjs",
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
          allow: ["fixture-plugin"],
          load: { paths: [pluginRoot] },
          entries: { "fixture-plugin": { enabled: true } },
        };
        await state.writeConfig(cfg);
        await state.writeJson("agent/settings.json", {});
        const migration = await autoMigrateLegacyState({
          cfg,
          env: state.env,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
        });
        expect(
          migration.stepReceipts.find((step) => step.id === "acp-session-metadata")?.outcome,
        ).not.toBe("refused");
        expect(migration.stepReceipts.find((step) => step.id === "agent-dir")).toMatchObject({
          outcome: "completed",
        });
        const postSessionReceipts: LegacyStateMigrationStepReceipt[] = [];
        await noteSessionTranscriptHealth({
          cfg,
          env: state.env,
          shouldRepair: true,
          postSessionPluginMigration: migration.postSessionPluginMigration,
          onStepReceipt: (step) => postSessionReceipts.push(step),
        });
        expect(postSessionReceipts.map(({ id, outcome }) => [id, outcome])).toContainEqual([
          "plugin-doctor-post-session-state",
          "completed",
        ]);
        expect(fs.readFileSync(marker, "utf8")).toBe("completed");
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
      }
    });
  },
);
