import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";

it.each(["database", "-wal", "-shm", "-journal", "archive"])(
  "preserves a misplaced database with divergent %s bytes",
  async (kind) => {
    await withOpenClawTestState({ label: "owner-recovery-refusal" }, async (state) => {
      const source = createLegacyDatabaseFixture({ env: state.env, eventsBySession: {} });
      const target = state.statePath("agents", "cleaner", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      let evidencePath = target;
      if (kind === "database") {
        const database = new DatabaseSync(target);
        try {
          database.prepare("UPDATE schema_meta SET app_version = ?").run("divergent-fixture");
        } finally {
          database.close();
        }
      } else {
        evidencePath =
          kind === "archive"
            ? state.statePath(
                "agents",
                "cleaner",
                "sessions",
                "history.jsonl.deleted.2026-09-10T00-00-00.000Z",
              )
            : `${target}${kind}`;
        fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
        fs.writeFileSync(evidencePath, "Unverified fixture bytes must survive refusal.");
      }
      const before = fs.readFileSync(evidencePath);

      const result = await migrateLegacyMediaPersistence({ env: state.env });

      expect(result.warningDisposition).toBeUndefined();
      expect(result.refusedAgentDatabasePaths).toContain(target);
      expect(result.warnings.join("\n")).toContain("quarantine move");
      expect(fs.readFileSync(evidencePath)).toEqual(before);
      expect(fs.readdirSync(path.dirname(target)).some((name) => name.includes(".corrupt-"))).toBe(
        false,
      );
    });
  },
);

it.each(["symlink", "hardlink"])(
  "does not quarantine a %s alias as a copied database",
  async (kind) => {
    await withOpenClawTestState({ label: "owner-recovery-alias" }, async (state) => {
      const source = createLegacyDatabaseFixture({ env: state.env, eventsBySession: {} });
      const target = state.statePath("agents", "cleaner", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (kind === "symlink") {
        fs.symlinkSync(source, target);
      } else {
        fs.linkSync(source, target);
      }
      const before = fs.lstatSync(target);

      const result = await migrateLegacyMediaPersistence({
        env: state.env,
        configuredAgentDatabaseTargets: [
          { agentId: "cleaner", path: target },
          { agentId: "main", path: source },
        ],
      });

      expect(result.warnings.join("\n")).toContain("duplicate recovery could not be verified");
      expect(fs.lstatSync(target).ino).toBe(before.ino);
      expect(fs.readdirSync(path.dirname(target)).some((name) => name.includes(".corrupt-"))).toBe(
        false,
      );
    });
  },
);
