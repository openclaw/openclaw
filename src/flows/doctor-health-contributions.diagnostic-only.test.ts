import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeDatabases,
  databaseFixture,
} from "../state/database-preflight-fixtures.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

// A contribution declared "diagnostic-only" tells a later conditional Gateway stop that it
// never has work. Each one runs here as `doctor --fix --non-interactive --yes` would run it
// under maintenance, on an install with a state database, an agent database, a config and a
// workspace, and must leave every one of them byte-identical. A declared contribution that
// starts writing fails here instead of silently losing its repair.

const diagnosticOnly = resolveDoctorHealthContributions().filter(
  (contribution) => contribution.pending === "diagnostic-only",
);

/**
 * Every file under root with its bytes and modification time. SQLite -shm is read state, and
 * opening a WAL database can leave an empty -wal; any write leaves frames in it or changes the
 * database itself.
 */
function snapshotInstall(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(pathname).toSorted()) {
        visit(path.join(pathname, name));
      }
      return;
    }
    if (pathname.endsWith("-shm") || (pathname.endsWith("-wal") && stat.size === 0n)) {
      return;
    }
    const bytes = stat.isFile() ? fs.readFileSync(pathname).toString("base64") : "";
    entries[path.relative(root, pathname)] =
      `${stat.mtimeNs}:${stat.mode}:${bytes.length}:${bytes}`;
  };
  visit(root);
  return entries;
}

describe("diagnostic-only Doctor contributions", () => {
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;

  beforeAll(async () => {
    state = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-doctor-diagnostic-only-",
    });
    cfg = {
      gateway: { mode: "local", auth: { mode: "token", token: "diagnostic-only-test-token" } },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    fs.mkdirSync(state.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(state.workspaceDir, "AGENTS.md"), "# Agent\n");
    const databases = databaseFixture(state.stateDir, state.env);
    databases.state();
    databases.agent("main");
    closeDatabases();
  });

  afterAll(async () => {
    closeDatabases();
    await state.cleanup();
  });

  it("covers the declared contributions", () => {
    expect(diagnosticOnly.length).toBeGreaterThan(0);
  });

  it.each(diagnosticOnly.map((contribution) => [contribution.id, contribution] as const))(
    "%s changes no store under --fix",
    async (_id, contribution) => {
      const ctx = createDoctorHealthFlowContext({
        cfg,
        configPath: state.configPath,
        env: state.env,
        options: { repair: true, yes: true, nonInteractive: true },
        prompter: createDoctorPrompterFixture(true),
        gatewayMaintenanceActive: true,
      });
      const before = snapshotInstall(state.root);

      await contribution.run(ctx);
      closeDatabases();

      const after = snapshotInstall(state.root);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (file) => before[file] !== after[file],
      );
      expect(changed).toEqual([]);
      expect(ctx.cfg).toEqual(cfg);
      expect(ctx.configResult.pendingChangePanels).toBeUndefined();
    },
  );
});
