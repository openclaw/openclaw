import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertConfiguredWorkspaceStateReady } from "../agents/workspace-state-dirs.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
} from "../agents/workspace-state-store.js";
import { createAppliedLegacyProposal } from "../commands/doctor-skill-workshop-sqlite.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { importLegacySkillProposal } from "../skills/workshop/store.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

async function fileHashes(root: string): Promise<Record<string, string>> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [
            path.relative(root, file),
            createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex"),
          ];
        }),
    ),
  );
}

describe("workspace state during an update rehearsal", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "workspace-rehearsal" });
  });
  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it.each([
    { name: "older", completed: "2026-04-23T11:31:35.154Z", claim: false },
    { name: "identical", completed: "2026-08-01T02:32:01.596Z", claim: false },
    { name: "newer", completed: "2026-09-01T02:32:01.596Z", claim: false },
    {
      name: "interrupted claim",
      completed: "2026-04-23T11:31:35.154Z",
      claim: true,
    },
  ])("preserves live $name files until the real Doctor runs", async ({ completed, claim }) => {
    const historical = state.path("historical-workspace");
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(config);
    const canonical = {
      bootstrapSeededAt: "2026-02-21T23:37:10.373Z",
      setupCompletedAt: "2026-08-01T02:32:01.596Z",
    };
    await fs.mkdir(historical, { recursive: true });
    await mergeWorkspaceSetupState(historical, canonical, Date.now(), { env: state.env });
    const setupText = JSON.stringify({ version: 1, ...canonical, setupCompletedAt: completed });
    const sourcePaths = ["openclaw-workspace-state.json", ".openclaw/workspace-state.json"].map(
      (relative) => path.join(historical, relative),
    );
    for (const source of sourcePaths) {
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(`${source}${claim ? ".doctor-importing" : ""}`, setupText);
    }
    const content = "---\nname: procedure\ndescription: Retained procedure\n---\n\n# Procedure\n";
    const record = {
      ...createAppliedLegacyProposal({
        id: "procedure-20260901-1234567890",
        title: "Procedure",
        description: "Retained procedure",
        content,
        target: { skillKey: "procedure", skillDir: path.join(historical, "skills", "procedure") },
      }),
      origin: { agentId: "main" },
    };
    await fs.mkdir(record.target.skillDir, { recursive: true });
    await fs.writeFile(record.target.skillFile, content);
    importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: state.env } });
    const before = await fileHashes(historical);
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir: state.stateDir,
      candidateRoot: process.cwd(),
      env: state.env,
    });
    try {
      const env = { ...rehearsal.env };
      const cfg: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const result = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => rehearsal.stateDir,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(await fileHashes(historical)).toEqual(before);
      expect(
        () => throwIfDoctorStateMigrationRefused(result.stepReceipts),
        result.warnings.join("\n"),
      ).not.toThrow();
      expect(
        result.stepReceipts.find((entry) => entry.id === "workspace-state")?.notices,
      ).toContain("rehearsal: 2 legacy files outside the rehearsal root left untouched");
      expect(
        result.stepReceipts.find((entry) => entry.id === "workspace-state")?.rehearsal,
      ).toEqual({ outsideRootLegacyFileCount: 2 });
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT status FROM skill_workshop_proposals WHERE proposal_id = ?")
          .get(record.id),
      ).toEqual({ status: "applied" });
    } finally {
      closeOpenClawStateDatabaseForTest();
      await rehearsal.cleanup();
    }
    expect(await fileHashes(historical)).toEqual(before);
    const real = await autoMigrateLegacyState({
      cfg: config,
      env: {
        ...state.env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.4",
      },
      homedir: () => state.home,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(
      () => throwIfDoctorStateMigrationRefused(real.stepReceipts),
      real.warnings.join("\n"),
    ).not.toThrow();
    expect((await readWorkspaceStateSnapshot(historical, { env: state.env })).setup).toEqual({
      version: 1,
      ...canonical,
    });
    const rows = openOpenClawStateDatabase({ env: state.env })
      .db.prepare(
        "SELECT status, removed_source, report_json FROM migration_sources WHERE migration_kind = 'legacy-workspace-setup-files'",
      )
      .all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "completed", removed_source: 1 });
    }
    for (const source of sourcePaths) {
      await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${source}.doctor-importing`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const archives = (await fs.readdir(path.dirname(source))).filter((entry) =>
        entry.startsWith(`${path.basename(source)}.migrated.`),
      );
      expect(archives).toHaveLength(1);
      await expect(
        fs.readFile(path.join(path.dirname(source), archives[0]!), "utf8"),
      ).resolves.toBe(setupText);
    }
    await expect(
      fs.readFile(path.join(state.agentDir(), "workshop-skills", "procedure", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      assertConfiguredWorkspaceStateReady({ cfg: config, env: state.env }),
    ).resolves.toBeUndefined();
  });
});
