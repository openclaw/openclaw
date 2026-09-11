import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

it("continues Doctor after an identical database copy has the wrong agent owner", async () => {
  await withOpenClawTestState({ prefix: "openclaw owner mismatch " }, async (state) => {
    const cfg = { agents: { entries: { main: {}, cleaner: {} } } };
    await state.writeConfig(cfg);
    const source = createLegacyDatabaseFixture({ env: state.env, eventsBySession: {} });
    const target = state.statePath("agents", "cleaner", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const original = fs.readFileSync(source);
    expect(fs.readFileSync(target)).toEqual(original);

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: state.env,
      homedir: () => state.home,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.warnings.join("\n")).toContain("cleaner");
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
    const copies = fs
      .readdirSync(path.dirname(target))
      .filter((file) => file.startsWith("openclaw-agent.sqlite.corrupt-"));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(target), copies[0]!))).toEqual(original);
    expect(result.warnings.join("\n")).toContain(copies[0]);
    const fresh = openOpenClawAgentDatabase({ agentId: "cleaner", env: state.env });
    expect(
      fresh.db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'").get()
        ?.agent_id,
    ).toBe("cleaner");
    expect(fresh.db.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()?.count).toBe(
      0,
    );
    await expect(
      assertOpenClawDatabasesReady({ env: state.env, operation: "gateway-startup", config: cfg }),
    ).resolves.toBeUndefined();
  });
});

it("continues independent Doctor repairs while preserving a divergent wrong-owner database", async () => {
  await withOpenClawTestState({ prefix: "openclaw divergent owner " }, async (state) => {
    const cfg = { agents: { entries: { main: { default: true }, cleaner: {} } } };
    await state.writeConfig(cfg);
    const source = createLegacyDatabaseFixture({
      env: state.env,
      eventsBySession: {
        history: [{ type: "message", id: "shared", timestamp: 1, message: { role: "user" } }],
      },
    });
    const target = state.statePath("agents", "cleaner", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const database = new DatabaseSync(target);
    try {
      database
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = 'history'")
        .run(
          JSON.stringify({
            type: "message",
            id: "shared",
            timestamp: 1,
            message: { role: "user", content: "History present only in the misplaced copy." },
          }),
        );
    } finally {
      database.close();
    }
    const original = fs.readFileSync(target);
    const execPath = state.statePath("exec-approvals.json");
    fs.writeFileSync(
      execPath,
      JSON.stringify({
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      }),
    );

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: state.env,
      homedir: () => state.home,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(fs.existsSync(execPath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "SELECT default_security FROM exec_approvals_config WHERE config_key = 'current'",
        )
        .get()?.default_security,
    ).toBe("allowlist");
    expect(fs.readFileSync(target)).toEqual(original);
    expect(result.stepReceipts.find((receipt) => receipt.id === "media-persistence")).toMatchObject(
      {
        outcome: "refused",
        refusal: { code: "agent-database-ownership-mismatch" },
      },
    );
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "transcript-directives"),
    ).toMatchObject({
      outcome: "refused",
      changes: [],
      refusal: { code: "blocked-by-agent-database-refusal" },
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "plugin-doctor-post-session-state"),
    ).toMatchObject({
      outcome: "refused",
      changes: [],
      refusal: { code: "blocked-by-agent-database-refusal" },
    });
    expect(result.postSessionPluginMigration).toBeUndefined();
    const warning = result.warnings.join("\n");
    expect(warning).toContain(target);
    expect(warning).toContain("belongs to agent main");
    expect(warning).toContain("quarantine move");
    expect(warning).toContain(".corrupt-");
    expect(warning).toContain("openclaw doctor --fix");
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
      "Independent state repairs were run",
    );
  });
});
