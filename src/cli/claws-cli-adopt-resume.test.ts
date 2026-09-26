// Resume coverage for a workspace-adopting Claw add that fails after files were written.
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import * as workspaceStateStore from "../agents/workspace-state-store.js";
import { resolveWorkspaceBootstrapStatus } from "../agents/workspace.js";
import { quiescentClawMonitorGateway } from "../claws/lifecycle-remove.test-support.js";
import {
  applyClawRemovePlan,
  buildClawRemovePlan,
  readClawStatus,
} from "../claws/lifecycle-state.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  readClawInstallRecord,
} from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import { readClawWorkspaceAdoption } from "../claws/workspace-origin.js";
import * as workspaceOrigin from "../claws/workspace-origin.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  upsertClawWorkspaceFile,
  createClawWorkspaceFiles,
} from "../claws/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as openClawStateDb from "../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";

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
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});
// Spies in place (not a full vi.mock replacement) so the real implementation still runs; only
// the call count is observed to prove the dry-run resume preview never opens the DB writably.
const openOpenClawStateDatabaseSpy = vi.spyOn(openClawStateDb, "openOpenClawStateDatabase");

beforeEach(() => {
  vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
  mocks.logs.length = 0;
  mocks.runtime.exit.mockClear();
  mocks.loadConfig.mockReset();
  mocks.loadConfig.mockReturnValue({});
  mocks.listConfiguredMcpServers.mockReset();
  mocks.listConfiguredMcpServers.mockResolvedValue({
    ok: true,
    path: "config",
    mcpServers: {},
  });
  mocks.applyClawAddPlan.mockReset();
  mocks.applyClawAddPlan.mockResolvedValue({
    schemaVersion: "openclaw.clawAddResult.v1",
    stability: "experimental",
    status: "complete",
    agent: { finalId: "demo-agent", workspace: "" },
  });
});

describe("claws add adopted-workspace resume", () => {
  it.each([
    { name: "create with adoption requested", existing: false, adoptionRequested: true },
    { name: "ordinary create", existing: false, adoptionRequested: false },
    { name: "existing workspace adoption", existing: true, adoptionRequested: true },
  ])(
    "preserves original CLI consent after config failure: $name",
    async ({ existing, adoptionRequested }) => {
      const source = syncFs.realpathSync(tempDirs.make("openclaw-claws-origin-source-"));
      const host = syncFs.realpathSync(tempDirs.make("openclaw-claws-origin-host-"));
      const workspace = join(host, "workspace");
      const configPath = join(host, "openclaw.json");
      const manifestPath = join(source, "openclaw.claw.json");
      await writeFile(join(source, "SOUL.md"), "# Soul\n");
      await writeFile(join(source, "HEARTBEAT.md"), "# Heartbeat\n");
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          agent: { id: "origin-worker" },
          workspace: {
            bootstrapFiles: {
              "SOUL.md": { source: "SOUL.md" },
              "HEARTBEAT.md": { source: "HEARTBEAT.md" },
            },
          },
        }),
      );
      if (existing) {
        await mkdir(workspace);
        await writeFile(join(workspace, "SOUL.md"), "# Soul\n");
        await writeFile(join(workspace, "operator-notes.md"), "Keep my notes.\n");
      }
      await writeFile(configPath, "{}\n");
      vi.stubEnv("OPENCLAW_STATE_DIR", join(host, "state"));
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      let config: OpenClawConfig = {};
      mocks.loadConfig.mockImplementation(() => config);
      const opts = { workspace, adoptExistingWorkspace: adoptionRequested, json: true };
      await runClawsAddCommand(manifestPath, { ...opts, dryRun: true });
      const plan = JSON.parse(mocks.logs.at(-1) ?? "{}") as ClawAddPlan;
      expect(plan.blockers).toEqual([]);
      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          kind: "workspace",
          action: existing ? "adopt" : "create",
        }),
      );
      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          kind: "workspaceFile",
          id: "SOUL.md",
          action: existing ? "adopt" : "write",
        }),
      );
      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          kind: "workspaceFile",
          id: "HEARTBEAT.md",
          action: "write",
        }),
      );
      const { applyClawAddPlan } =
        await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js");
      let failCommit = true;
      // Run the real CLI, planner, apply and SQLite owners. Inject only a config-persistence
      // failure after the real transform, so managed files and their provenance already exist.
      mocks.applyClawAddPlan.mockImplementation((nextPlan, options) =>
        applyClawAddPlan(nextPlan, {
          ...options,
          commitConfig: async (transform) => {
            const nextConfig = transform(config);
            if (failCommit) {
              failCommit = false;
              throw new Error("config persistence unavailable");
            }
            await writeFile(configPath, JSON.stringify(nextConfig));
            config = nextConfig;
          },
        }),
      );
      mocks.logs.length = 0;
      await expect(
        runClawsAddCommand(manifestPath, {
          ...opts,
          yes: true,
          planIntegrity: plan.planIntegrity,
        }),
      ).rejects.toThrow("__exit__:1");
      expect(JSON.parse(mocks.logs.at(-1) ?? "{}")).toMatchObject({
        status: "partial",
        configCommitted: false,
        error: { code: "config_commit_failed" },
      });
      expect(config).toEqual({});
      expect(readClawInstallRecord("origin-worker")).toMatchObject({
        status: "workspace_ready",
        planIntegrity: plan.planIntegrity,
      });
      expect(readClawWorkspaceAdoption("origin-worker", workspace).adopted).toBe(existing);
      await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("# Soul\n");
      await expect(readFile(join(workspace, "HEARTBEAT.md"), "utf8")).resolves.toBe(
        "# Heartbeat\n",
      );
      const filesBeforeResume = await Promise.all(
        ["SOUL.md", "HEARTBEAT.md"].map((name) => stat(join(workspace, name))),
      );
      closeOpenClawStateDatabaseForTest();
      mocks.logs.length = 0;
      mocks.runtime.exit.mockClear();
      // Retry the original command and consent, not a reconstructed plan passed straight to apply.
      await expect(
        runClawsAddCommand(manifestPath, {
          ...opts,
          yes: true,
          planIntegrity: plan.planIntegrity,
        }),
        "original CLI consent must survive workspace creation",
      ).resolves.toBeUndefined();
      expect(mocks.applyClawAddPlan).toHaveBeenCalledTimes(2);
      const resumedPlan = mocks.applyClawAddPlan.mock.calls[1]?.[0] as ClawAddPlan;
      expect(resumedPlan.planIntegrity).toBe(plan.planIntegrity);
      expect(resumedPlan.actions).toEqual(plan.actions);
      expect(resumedPlan.capabilityChanges).toEqual(plan.capabilityChanges);
      expect(JSON.parse(mocks.logs.at(-1) ?? "{}")).toMatchObject({
        status: "complete",
        configCommitted: true,
        planIntegrity: plan.planIntegrity,
      });
      expect(readClawInstallRecord("origin-worker")?.status).toBe("complete");
      expect(readClawWorkspaceAdoption("origin-worker", workspace).adopted).toBe(existing);
      for (const [index, name] of ["SOUL.md", "HEARTBEAT.md"].entries()) {
        const after = await stat(join(workspace, name));
        expect(after.ino).toBe(filesBeforeResume[index]?.ino);
        expect(after.mtimeMs).toBe(filesBeforeResume[index]?.mtimeMs);
      }
      if (existing) {
        await expect(readFile(join(workspace, "operator-notes.md"), "utf8")).resolves.toBe(
          "Keep my notes.\n",
        );
      }
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    },
  );

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
    const heartbeatPublisher = workspaceOrigin.prepareClawWorkspaceFilePublication(
      plan,
      "HEARTBEAT.md",
    );
    if (!heartbeatPublisher) {
      throw new Error("expected adopted workspace file publisher");
    }
    const heartbeatDirectoryPath = syncFs.realpathSync(workspace);
    const heartbeat = syncFs.lstatSync(join(workspace, "HEARTBEAT.md"), { bigint: true });
    const heartbeatDirectory = syncFs.lstatSync(heartbeatDirectoryPath, { bigint: true });
    const heartbeatPublication = {
      directoryPath: heartbeatDirectoryPath,
      directoryDev: heartbeatDirectory.dev.toString(),
      directoryIno: heartbeatDirectory.ino.toString(),
      dev: heartbeat.dev.toString(),
      ino: heartbeat.ino.toString(),
      birthtimeNs: heartbeat.birthtimeNs.toString(),
    };
    heartbeatPublisher.beforePublish(heartbeatPublication);
    heartbeatPublisher.afterPublish(heartbeatPublication);
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

  it.each([
    "receipt",
    "postpublication",
    "native timestamp",
    "prepublication",
    "unpublished substitute",
    "identical substitute",
    "changed workspace",
    "old install",
  ] as const)("recovers or refuses the same CLI consent after %s failure", async (fault) => {
    const source = tempDirs.make("openclaw-claws-cli-seed-source-");
    const host = tempDirs.make("openclaw-claws-cli-seed-host-");
    const workspace = join(host, "existing-workspace");
    const configPath = join(host, "openclaw.json");
    const bootstrapContent = "# First run\n\nAsk which repositories matter.\n";
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "@acme/receipt-worker",
        version: "1.0.0",
        openclaw: { claw: "openclaw.claw.json" },
      }),
    );
    await writeFile(
      join(source, "openclaw.claw.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "receipt-worker" } }),
    );
    await writeFile(join(source, "BOOTSTRAP.md"), bootstrapContent);
    await mkdir(workspace);
    await writeFile(join(workspace, "operator-notes.md"), "Keep my notes.\n");
    await writeFile(configPath, "{}\n");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(host, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const env = { OPENCLAW_STATE_DIR: join(host, "state") };
    let config: OpenClawConfig = {};
    mocks.loadConfig.mockImplementation(() => config);
    const opts = { workspace, adoptExistingWorkspace: true, json: true };
    await runClawsAddCommand(source, { ...opts, dryRun: true });
    const plan = JSON.parse(mocks.logs.at(-1) ?? "{}") as ClawAddPlan;
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", action: "write", blocked: false }),
    );

    const { applyClawAddPlan } =
      await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js");
    const createFiles = vi.fn(createClawWorkspaceFiles);
    const interruptedPublication = ["prepublication", "unpublished substitute"].includes(fault);
    const postPublicationFailure =
      fault !== "receipt" && fault !== "native timestamp" && !interruptedPublication;
    const published = fault !== "receipt" && !interruptedPublication;
    if (postPublicationFailure) {
      createFiles.mockRejectedValueOnce(new Error("workspace ownership unavailable"));
    }
    const realPrepare = workspaceOrigin.prepareClawBootstrapPublication;
    const realLink = syncFs.linkSync.bind(syncFs);
    const restoreFault =
      fault === "receipt"
        ? vi
            .spyOn(workspaceOrigin, "prepareClawBootstrapPublication")
            .mockImplementation((...args) => {
              const publication = realPrepare(...args);
              return (
                publication && {
                  ...publication,
                  beforePublish: () => {
                    throw new Error("receipt unavailable");
                  },
                }
              );
            })
        : fault === "native timestamp"
          ? vi
              .spyOn(workspaceStateStore, "mergeWorkspaceSetupState")
              .mockRejectedValueOnce(new Error("native timestamp unavailable"))
          : interruptedPublication
            ? vi.spyOn(syncFs, "linkSync").mockImplementation((stagedSource, target) => {
                if (String(target) === join(syncFs.realpathSync(workspace), "BOOTSTRAP.md")) {
                  throw Object.assign(new Error("publication unavailable"), { code: "EIO" });
                }
                return realLink(stagedSource, target);
              })
            : undefined;
    let nowMs = 1_000;
    // Exercise actual apply, root-bound staging, publication, SQLite and CLI re-planning.
    // Fail one effect boundary; the config adapter writes actual transforms to test-owned disk.
    mocks.applyClawAddPlan.mockImplementation((nextPlan, options) =>
      applyClawAddPlan(nextPlan, {
        ...options,
        nowMs,
        createWorkspaceFiles: createFiles,
        commitConfig: async (transform) => {
          config = transform(config);
          await writeFile(configPath, JSON.stringify(config));
        },
      }),
    );
    mocks.logs.length = 0;
    try {
      await expect(
        runClawsAddCommand(source, { ...opts, yes: true, planIntegrity: plan.planIntegrity }),
      ).rejects.toThrow("__exit__:1");
    } finally {
      restoreFault?.mockRestore();
    }
    expect(JSON.parse(mocks.logs.at(-1) ?? "{}")).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: {
        code: postPublicationFailure ? "workspace_files_failed" : "bootstrap_write_failed",
      },
    });
    expect(createFiles).toHaveBeenCalledTimes(postPublicationFailure ? 1 : 0);
    expect(config).toEqual({});
    expect(readClawInstallRecord("receipt-worker", { env })).toMatchObject({
      status: "workspace_ready",
      planIntegrity: plan.planIntegrity,
    });
    if (interruptedPublication) {
      // Intent must survive this failure, but must not claim a final entry that never appeared.
      expect(readClawWorkspaceAdoption("receipt-worker", workspace, { env })).toMatchObject({
        adopted: true,
        bootstrapSeeded: false,
        bootstrapPublication: expect.objectContaining({
          dev: expect.any(String),
          ino: expect.any(String),
        }),
      });
    }
    const bootstrapPath = join(workspace, "BOOTSTRAP.md");
    const seededFile = published ? await stat(bootstrapPath) : undefined;
    if (seededFile) {
      await expect(readFile(bootstrapPath, "utf8")).resolves.toBe(bootstrapContent);
      expect(seededFile.nlink).toBe(1);
      await expect(resolveWorkspaceBootstrapStatus(workspace, { env })).resolves.toBe("pending");
    } else {
      await expect(readFile(bootstrapPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const seededState = await readWorkspaceStateSnapshot(workspace, { env });
    expect(seededState.setup.bootstrapSeededAt).toBe(
      postPublicationFailure ? new Date(1_000).toISOString() : undefined,
    );
    expect(seededState.setup.setupCompletedAt).toBeUndefined();

    if (fault === "unpublished substitute") {
      await writeFile(bootstrapPath, bootstrapContent);
    } else if (fault === "identical substitute") {
      // Keep the original inode alive: the replacement has identical bytes, never our identity.
      await rename(bootstrapPath, join(host, "original-bootstrap"));
      await writeFile(bootstrapPath, bootstrapContent);
    } else if (fault === "changed workspace") {
      await rename(workspace, join(host, "original-workspace"));
      await mkdir(workspace);
      await writeFile(bootstrapPath, bootstrapContent);
    } else if (fault === "old install") {
      deleteClawInstallRecord("receipt-worker", { env });
      persistClawInstallRecord(plan, { env, status: "workspace_ready", nowMs: 2_000 });
    }
    if (
      [
        "unpublished substitute",
        "identical substitute",
        "changed workspace",
        "old install",
      ].includes(fault)
    ) {
      closeOpenClawStateDatabaseForTest();
      mocks.logs.length = 0;
      await expect(runClawsAddCommand(source, { ...opts, dryRun: true })).rejects.toThrow(
        "__exit__:1",
      );
      const refused = JSON.parse(mocks.logs.at(-1) ?? "{}");
      expect(refused.blockers).toContainEqual(
        expect.objectContaining({ code: "workspace_file_conflict" }),
      );
      const removal = await buildClawRemovePlan("receipt-worker", { env, config });
      expect(removal.actions).toContainEqual(
        expect.objectContaining({ kind: "bootstrap", action: "retain" }),
      );
      await expect(readFile(bootstrapPath, "utf8")).resolves.toBe(bootstrapContent);
      return;
    }

    // Reopen persisted state, then use the actual CLI resume planner rather than replaying plan.
    closeOpenClawStateDatabaseForTest();
    nowMs = 2_000;
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    await expect(runClawsAddCommand(source, { ...opts, dryRun: true })).resolves.toBeUndefined();
    const resumedPlan = JSON.parse(mocks.logs.at(-1) ?? "{}") as ClawAddPlan;
    expect(resumedPlan.blockers).toEqual([]);
    expect(resumedPlan.planIntegrity).toBe(plan.planIntegrity);
    expect(resumedPlan.capabilityChanges).toEqual(plan.capabilityChanges);
    await expect(
      runClawsAddCommand(source, { ...opts, yes: true, planIntegrity: plan.planIntegrity }),
    ).resolves.toBeUndefined();
    expect(mocks.applyClawAddPlan).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.logs.at(-1) ?? "{}")).toMatchObject({
      status: "complete",
      configCommitted: true,
      planIntegrity: plan.planIntegrity,
    });
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(readClawWorkspaceAdoption("receipt-worker", workspace, { env })).toMatchObject({
      adopted: true,
      bootstrapSeeded: true,
    });
    await expect(readFile(bootstrapPath, "utf8")).resolves.toBe(bootstrapContent);
    if (seededFile) {
      expect((await stat(bootstrapPath)).mtimeMs).toBe(seededFile.mtimeMs);
    }
    expect((await readWorkspaceStateSnapshot(workspace, { env })).setup).toMatchObject({
      bootstrapSeededAt: new Date(postPublicationFailure ? 1_000 : 2_000).toISOString(),
    });
    await expect(resolveWorkspaceBootstrapStatus(workspace, { env })).resolves.toBe("pending");
    await expect(readClawStatus("receipt-worker", { env, config })).resolves.toMatchObject({
      summary: { pendingBootstrap: 1 },
      records: [{ bootstrapState: "pending", agentState: "present" }],
    });

    const removePlan = await buildClawRemovePlan("receipt-worker", { env, config });
    expect(removePlan.blockers).toEqual([]);
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", action: "delete", blocked: false }),
    );
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "retain" }),
    );
    const removed = await applyClawRemovePlan(removePlan, {
      env,
      config,
      consentPlanIntegrity: removePlan.planIntegrity,
      monitorGateway: quiescentClawMonitorGateway,
      purgeSessions: async () => undefined,
      trashPath: async (target) => {
        await rm(target, { recursive: true, force: true });
        return true;
      },
    });
    expect(removed).toMatchObject({
      status: "complete",
      bootstrap: { path: "BOOTSTRAP.md", action: "deleted" },
    });
    await expect(readFile(bootstrapPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(workspace, "operator-notes.md"), "utf8")).resolves.toBe(
      "Keep my notes.\n",
    );
    expect((await stat(workspace)).isDirectory()).toBe(true);
    expect(readClawInstallRecord("receipt-worker", { env })).toBeUndefined();
    expect(readClawWorkspaceAdoption("receipt-worker", workspace, { env })).toEqual({
      adopted: false,
    });
  });
});
