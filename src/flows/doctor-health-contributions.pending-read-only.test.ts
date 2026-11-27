import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { databaseFixture } from "../state/database-preflight-fixtures.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  changedStoreFiles,
  listSqliteSidecars,
  snapshotStoreFiles,
} from "../test-utils/store-snapshot.test-support.js";
import { decideDoctorContributionPending } from "./doctor-health-context.test-support.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

// A contribution's pending check runs before its repair and must only read
// (`DoctorMaintenancePendingCheck`). Every registered check runs here under --fix on its own
// healthy install, once with no connection holding the stores, as a stopped Gateway leaves
// them (no WAL sidecars), and once beside connections that hold them, as a serving Gateway
// does. A check that creates or changes any file, including the sidecars a read-only SQLite
// open of an unheld store leaves behind, fails here.

const checked = resolveDoctorHealthContributions()
  .filter((contribution) => typeof contribution.pending === "function")
  .map((contribution) => [contribution.id, contribution] as const);

async function closeStores() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}

describe("Doctor contribution pending checks", () => {
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  let databases: ReturnType<typeof databaseFixture>;

  const context = () =>
    createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configPath: state.configPath,
      env: state.env,
      options: { repair: true, yes: true, nonInteractive: true },
      prompter: createDoctorPrompterFixture(true),
      gatewayMaintenanceActive: true,
      // Preflight migrated this exact config, so legacy-state goes on to read its stores.
      configResult: { preflightLegacyStateConfig: structuredClone(cfg) },
    });

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-doctor-pending-read-only-",
    });
    cfg = {
      gateway: { mode: "local", auth: { mode: "token", token: "pending-read-only-test-token" } },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    fs.mkdirSync(state.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(state.workspaceDir, "AGENTS.md"), "# Agent\n");
    databases = databaseFixture(state.stateDir, state.env);
    databases.state();
    databases.agent("main");
  });

  afterEach(async () => {
    await closeStores();
    await state.cleanup();
  });

  it("covers the checks that read the state and agent databases", () => {
    expect(checked.map(([id]) => id)).toEqual(
      expect.arrayContaining([
        "doctor:legacy-state",
        "doctor:agent-memory-schema",
        "doctor:project-clone-shape",
        "doctor:telegram-general-topic-conversations",
        "doctor:config-audit-scrub",
        "doctor:write-config",
      ]),
    );
  });

  it.each(checked)(
    "%s creates no file when no connection holds the stores",
    async (_id, contribution) => {
      await closeStores();
      expect(fs.existsSync(databases.statePath)).toBe(true);
      expect(fs.existsSync(databases.agentPath("main"))).toBe(true);
      expect(listSqliteSidecars(state.root)).toEqual([]);
      const before = snapshotStoreFiles(state.root);

      await decideDoctorContributionPending(contribution, context());

      // Before any close: a connection the check left open still shows its sidecars.
      expect(changedStoreFiles(before, snapshotStoreFiles(state.root))).toEqual([]);
    },
  );

  it.each(checked)(
    "%s decides beside connections that hold the stores",
    async (_id, contribution) => {
      expect(listSqliteSidecars(state.root)).toEqual(
        expect.arrayContaining([`${path.relative(state.root, databases.statePath)}-shm`]),
      );
      const before = snapshotStoreFiles(state.root);

      await expect(decideDoctorContributionPending(contribution, context())).resolves.toMatch(
        /^(?:none|work)$/u,
      );

      expect(changedStoreFiles(before, snapshotStoreFiles(state.root))).toEqual([]);
    },
  );
});
