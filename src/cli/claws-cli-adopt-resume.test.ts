// Resume coverage for a workspace-adopting Claw add that fails after files were written.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  upsertClawWorkspaceFile,
} from "../claws/workspace.js";
import * as openClawStateDb from "../state/openclaw-state-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const mocks = vi.hoisted(() => ({
  logs: [] as string[],
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn((value: unknown) => mocks.logs.push(JSON.stringify(value))),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  },
  loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
  listConfiguredMcpServers: vi.fn(),
  applyClawAddPlan: vi.fn(),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown) => runtime.writeJson(value),
}));
vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.loadConfig,
}));
vi.mock("../config/mcp-config.js", () => ({
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));
vi.mock("../claws/add.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js")),
  applyClawAddPlan: mocks.applyClawAddPlan,
}));

const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Spies in place (not a full vi.mock replacement) so the real implementation still runs; only
// the call count is observed to prove the dry-run resume preview never opens the DB writably.
const openOpenClawStateDatabaseSpy = vi.spyOn(openClawStateDb, "openOpenClawStateDatabase");

beforeEach(() => {
  vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
  mocks.logs.length = 0;
  mocks.loadConfig.mockReset();
  mocks.loadConfig.mockReturnValue({});
  mocks.listConfiguredMcpServers.mockReset();
  mocks.listConfiguredMcpServers.mockResolvedValue({ ok: true, path: "config", mcpServers: {} });
  mocks.applyClawAddPlan.mockReset();
  mocks.applyClawAddPlan.mockResolvedValue({
    schemaVersion: "openclaw.clawAddResult.v1",
    stability: "experimental",
    status: "complete",
    agent: { finalId: "demo-agent", workspace: "" },
  });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("claws add adopted-workspace resume", () => {
  it("rebuilds the identical plan when resuming after files were written", async () => {
    const dir = tempDirs.make("openclaw-claws-cli-adopt-");
    await writeFile(join(dir, "SOUL.md"), "# Soul\n", "utf8");
    await writeFile(join(dir, "HEARTBEAT.md"), "# Heartbeat\n", "utf8");
    const manifestPath = join(dir, "openclaw.claw.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        workspace: {
          bootstrapFiles: {
            "SOUL.md": { source: "SOUL.md" },
            "HEARTBEAT.md": { source: "HEARTBEAT.md" },
          },
        },
      }),
      "utf8",
    );
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "existing-workspace");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(tempDirs.make("openclaw-claws-state-"), "state"));
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "# Soul\n", "utf8");

    await runClawsAddCommand(manifestPath, {
      dryRun: true,
      workspace,
      adoptExistingWorkspace: true,
      json: true,
    });
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "HEARTBEAT.md", action: "write" }),
    );

    // A prior attempt wrote the previously-missing declared file and left the row at
    // workspace_ready after a later-phase failure; the origin marker records SOUL.md adopted.
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    await writeFile(join(workspace, "HEARTBEAT.md"), "# Heartbeat\n", "utf8");
    upsertClawWorkspaceFile({
      schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
      agentId: "demo-agent",
      workspace,
      path: "HEARTBEAT.md",
      sourcePath: "HEARTBEAT.md",
      contentDigest: `sha256:${createHash("sha256").update("# Heartbeat\n").digest("hex")}`,
      status: "complete",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    mocks.logs.length = 0;

    // A dry-run preview of this resumable install must never open the state database writably:
    // fresh-open runs schema checks/repair, which would mutate a compatible migration-pending
    // state DB before the operator ever consents. A byte-hash of the DB file is not discriminating
    // here — a writable open of an already-current schema writes no bytes either way — so this
    // asserts the mechanism directly. openOpenClawStateDatabase(options) also serves a safe
    // passthrough when `options.database` already carries an open (here, read-only) handle — that
    // call never opens or repairs anything, so only a call WITHOUT options.database is a fresh
    // open and the thing this proof cares about.
    // Close the cached writable handle from the setup writes above first, so the read-only open
    // below opens the file fresh rather than reusing state left by this test's own bootstrap.
    closeOpenClawStateDatabaseForTest();
    openOpenClawStateDatabaseSpy.mockClear();
    await runClawsAddCommand(manifestPath, {
      dryRun: true,
      workspace,
      adoptExistingWorkspace: true,
      json: true,
    });
    const freshOpens = openOpenClawStateDatabaseSpy.mock.calls.filter(([opts]) => !opts?.database);
    expect(freshOpens).toEqual([]);

    mocks.logs.length = 0;

    // Without the resume-ownership fix, HEARTBEAT.md flips to "adopt" on disk presence alone, the
    // rebuilt planIntegrity stops matching the stored record, and the resume never reaches
    // applyClawAddPlan.
    await runClawsAddCommand(manifestPath, {
      yes: true,
      planIntegrity: plan.planIntegrity,
      workspace,
      adoptExistingWorkspace: true,
      json: true,
    });

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });
});
