// Apply-time compare-and-swap coverage for adopting a configured agent.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { seedClawPackageBootstrap } from "./bootstrap.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { ClawPackageInstallError } from "./packages.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawAddPlan, ClawSourceIdentity } from "./types.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  readClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
  upsertClawWorkspaceFile,
} from "./workspace.js";

function managedWorkspaceFile(plan: ClawAddPlan, content: string): PersistedClawWorkspaceFile {
  return {
    schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    path: "SKILL.md",
    sourcePath: "SKILL.md",
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    status: "complete",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

async function fixture(
  options: {
    createWorkspace?: boolean;
    plugin?: boolean;
    bootstrap?: boolean;
    managedFile?: boolean;
  } = {},
): Promise<{
  root: string;
  plan: ClawAddPlan;
  config: OpenClawConfig;
}> {
  const root = tempDirs.make("openclaw-claw-agent-adopt-apply-");
  const workspace = join(root, "workspace");
  if (options.createWorkspace !== false) {
    await mkdir(workspace);
  }
  if (options.managedFile) {
    await mkdir(join(root, "content"));
    await writeFile(join(root, "content", "SKILL.md"), "managed by claw");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    ...(options.managedFile
      ? { workspace: { files: [{ source: "content/SKILL.md", path: "SKILL.md" }] } }
      : {}),
    ...(options.plugin
      ? {
          packages: [
            {
              kind: "plugin" as const,
              source: "clawhub" as const,
              ref: "@acme/audit",
              version: "1.0.0",
            },
          ],
        }
      : {}),
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 1,
  };
  const existing = { id: "worker", name: "Worker", workspace, default: true };
  const bootstrapContent = "# First run\n";
  const bootstrapPath = join(root, "BOOTSTRAP.md");
  if (options.bootstrap) {
    await writeFile(bootstrapPath, bootstrapContent);
  }
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    ...(options.bootstrap
      ? {
          packageBootstrap: {
            sourcePath: "BOOTSTRAP.md",
            realPath: bootstrapPath,
            byteLength: Buffer.byteLength(bootstrapContent),
            digest: `sha256:${createHash("sha256").update(bootstrapContent).digest("hex")}`,
          },
        }
      : {}),
    context: {
      workspace,
      adoptExistingAgent: true,
      existingAgents: [existing],
      ...(options.plugin
        ? {
            packagePreflight: async () => ({
              ok: true as const,
              action: "install" as const,
              integrity: `sha256:${"a".repeat(64)}`,
              installId: "audit",
            }),
          }
        : {}),
    },
  });
  return {
    root,
    plan,
    config: { agents: { entries: { worker: { name: "Worker", workspace, default: true } } } },
  };
}

describe("applyClawAddPlan agent adoption", () => {
  it("asserts exact config without rewriting the adopted entry", async () => {
    const { root, plan, config } = await fixture();
    const commitConfig = vi.fn(async (transform) => {
      expect(transform(config)).toBe(config);
    });

    const result = await applyClawAddPlan(plan, {
      env: { OPENCLAW_STATE_DIR: join(root, "state") },
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig,
    });

    expect(result).toMatchObject({ status: "complete", configCommitted: true });
    expect(commitConfig).toHaveBeenCalledOnce();
  });

  it("accepts a canonical plan for a non-canonical configured roster key", async () => {
    const { root, plan, config } = await fixture();
    const worker = config.agents?.entries?.worker;
    if (!worker) {
      throw new Error("fixture agent missing");
    }
    const nonCanonicalConfig: OpenClawConfig = {
      agents: { entries: { WORKER: worker } },
    };
    const commitConfig = vi.fn(async (transform) => {
      expect(transform(nonCanonicalConfig)).toBe(nonCanonicalConfig);
    });

    const result = await applyClawAddPlan(plan, {
      env: { OPENCLAW_STATE_DIR: join(root, "state") },
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => nonCanonicalConfig,
      commitConfig,
    });

    expect(result).toMatchObject({ status: "complete", configCommitted: true });
    expect(commitConfig).toHaveBeenCalledOnce();
  });

  it("preserves a claimed adoption when a resumed plugin install fails", async () => {
    const { root, plan, config } = await fixture({ plugin: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    persistClawInstallRecord(plan, { env, status: "config_committed", nowMs: 1 });
    const commitConfig = vi.fn();

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      installPackages: async () => {
        throw new ClawPackageInstallError("package_install_failed", "install failed", []);
      },
      commitConfig,
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      installRecord: { status: "config_committed", agentClaimed: true },
      error: { code: "package_install_failed" },
    });
    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      status: "config_committed",
      agentClaimed: true,
    });
  });

  it("rolls back a published bootstrap before releasing a resumed unclaimed adoption", async () => {
    const { root, plan, config } = await fixture({ plugin: true, bootstrap: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    persistClawInstallRecord(plan, { env, status: "workspace_ready", nowMs: 1 });
    await seedClawPackageBootstrap(plan, { env, nowMs: 1 });
    const bootstrapPath = join(plan.agent.workspace, "BOOTSTRAP.md");
    expect(existsSync(bootstrapPath)).toBe(true);

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      installPackages: async () => {
        throw new ClawPackageInstallError("package_install_failed", "install failed", []);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "package_install_failed" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
    expect(existsSync(bootstrapPath)).toBe(false);
    expect((await readWorkspaceStateSnapshot(plan.agent.workspace, { env })).setup).toEqual(
      expect.not.objectContaining({ bootstrapSeededAt: expect.anything() }),
    );
  });

  it("preserves a pre-existing consumed bootstrap marker when the config claim fails", async () => {
    const { root, plan, config } = await fixture({ bootstrap: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const seededAt = new Date(1).toISOString();
    await mergeWorkspaceSetupState(plan.agent.workspace, { bootstrapSeededAt: seededAt }, 1, {
      env,
    });

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async () => {
        throw new Error("config unavailable");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "config_commit_failed" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(existsSync(join(plan.agent.workspace, "BOOTSTRAP.md"))).toBe(false);
    expect((await readWorkspaceStateSnapshot(plan.agent.workspace, { env })).setup).toMatchObject({
      bootstrapSeededAt: seededAt,
    });
  });

  it("rejects an adopted workspace replaced during plugin installation", async () => {
    const { root, plan, config } = await fixture({ plugin: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const commitConfig = vi.fn();

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      installPackages: async () => {
        await rmdir(plan.agent.workspace);
        await mkdir(plan.agent.workspace);
        return [];
      },
      commitConfig,
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "workspace_collision" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("clears a new pending record when the pre-mutation digest changed", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const installPackages = vi.fn();
    const createWorkspaceFiles = vi.fn();
    const commitConfig = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        env,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => ({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Changed" } } },
        }),
        installPackages,
        createWorkspaceFiles,
        commitConfig,
      }),
    ).rejects.toMatchObject({ code: "agent_config_conflict" });

    expect(installPackages).not.toHaveBeenCalled();
    expect(createWorkspaceFiles).not.toHaveBeenCalled();
    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("releases the unclaimed adoption when the final compare-and-swap loses a race", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        transform({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        });
      },
    });

    expect(result).toMatchObject({ status: "partial", error: { code: "agent_config_conflict" } });
    expect(result.error?.message).toContain("released its unclaimed adoption");
    // The result must not report ownership the state database no longer holds.
    expect(result.installRecord).toBeUndefined();
    // The claim never landed, so no record may survive to block resume or authorize a remove
    // that would delete the operator's own agent.
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("releases the unclaimed adoption when the in-lock config recheck loses", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const managedPath = join(plan.agent.workspace, "SKILL.md");
    await writeFile(managedPath, "edited by the operator");
    const createWorkspaceFiles = vi.fn(async () => [managedWorkspaceFile(plan, "managed")]);
    const commitConfig = vi.fn();

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      readConfigForApply: () => ({
        ...config,
        agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
      }),
      createWorkspaceFiles,
      commitConfig,
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "agent_config_conflict" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(createWorkspaceFiles).not.toHaveBeenCalled();
    expect(commitConfig).not.toHaveBeenCalled();
    expect(await readFile(managedPath, "utf8")).toBe("edited by the operator");
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("clears a fresh adoption record when its workspace becomes a file", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    await rmdir(plan.agent.workspace);
    await writeFile(plan.agent.workspace, "not a directory");

    await expect(
      applyClawAddPlan(plan, {
        env,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => config,
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });

    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("reports an adopted-workspace reinspection error and clears its fresh record", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const inspectionError = Object.assign(new Error("synthetic access failure"), {
      code: "EACCES",
    });
    const lstatWorkspace = vi
      .fn((path: string) => lstat(path))
      .mockImplementationOnce((path) => lstat(path))
      .mockRejectedValueOnce(inspectionError);

    await expect(
      applyClawAddPlan(plan, {
        env,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => config,
        lstatWorkspace,
      }),
    ).rejects.toMatchObject({
      code: "workspace_parent_failed",
      message: expect.stringContaining("synthetic access failure"),
    });

    expect(lstatWorkspace).toHaveBeenCalledTimes(2);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("preserves an implicit partial record when adopted-workspace reinspection fails", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const existingRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });
    const inspectionError = Object.assign(new Error("synthetic I/O failure"), { code: "EIO" });
    const lstatWorkspace = vi
      .fn((path: string) => lstat(path))
      .mockImplementationOnce((path) => lstat(path))
      .mockRejectedValueOnce(inspectionError);

    await expect(
      applyClawAddPlan(plan, {
        env,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => config,
        lstatWorkspace,
      }),
    ).rejects.toMatchObject({ code: "workspace_parent_failed" });

    expect(lstatWorkspace).toHaveBeenCalledTimes(2);
    expect(readClawInstallRecord("worker", { env })).toEqual(existingRecord);
  });

  it("releases when workspace creation loses a race before the agent is claimed", async () => {
    const { root, plan, config } = await fixture({ createWorkspace: false });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const commitConfig = vi.fn();

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      readConfigForApply: async () => {
        await writeFile(plan.agent.workspace, "not a directory");
        return config;
      },
      commitConfig,
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "workspace_collision" },
    });
    expect(result.error?.message).toContain("released its unclaimed adoption");
    expect(result.installRecord).toBeUndefined();
    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("retains an unclaimed partial record when a created workspace cannot be identified", async () => {
    const { root, plan, config } = await fixture({ createWorkspace: false });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const commitConfig = vi.fn();

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      captureWorkspaceIdentity: async () => {
        throw Object.assign(new Error("synthetic identity failure"), { code: "EIO" });
      },
      commitConfig,
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: false,
      installRecord: { status: "partial", agentClaimed: false },
      error: {
        code: "workspace_parent_failed",
        message: expect.stringContaining("synthetic identity failure"),
      },
    });
    expect(commitConfig).not.toHaveBeenCalled();
    expect(existsSync(plan.agent.workspace)).toBe(true);
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      status: "partial",
      agentClaimed: false,
    });
  });

  it("releases written workspace files when file creation fails before claim", async () => {
    const { root, plan, config } = await fixture({ managedFile: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const managedPath = join(plan.agent.workspace, "SKILL.md");
    const commitConfig = vi.fn();

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      createWorkspaceFiles: async (currentPlan, options) => {
        const created = await createClawWorkspaceFiles(currentPlan, options);
        throw new ClawWorkspaceWriteError(
          [
            {
              level: "error",
              code: "workspace_file_io_error",
              phase: "mutation",
              path: "$.workspace.files[0]",
              message: "synthetic write failure",
            },
          ],
          created,
        );
      },
      commitConfig,
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "workspace_files_failed" },
    });
    expect(commitConfig).not.toHaveBeenCalled();
    expect(existsSync(managedPath)).toBe(false);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
    expect(result.installRecord).toBeUndefined();
    expect(result.error?.message).toContain("released its unclaimed adoption");
  });

  it("releases when the write retries and the second transform loses", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const raced = {
      ...config,
      agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
    };

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      // A config write that hash-conflicts re-runs the transform against the newer file, so a
      // first transform that would have committed proves nothing about what landed.
      commitConfig: async (transform) => {
        transform(config);
        transform(raced);
      },
    });

    expect(result).toMatchObject({ status: "partial", error: { code: "agent_config_conflict" } });
    expect(result.installRecord).toBeUndefined();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("retains a byte-identical managed-file replacement when the config claim loses", async () => {
    const { root, plan, config } = await fixture({ managedFile: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const managedPath = join(plan.agent.workspace, "SKILL.md");
    const replacementPath = join(plan.agent.workspace, "replacement.md");

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        await writeFile(replacementPath, "managed by claw");
        await unlink(managedPath);
        await rename(replacementPath, managedPath);
        transform({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        });
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      installRecord: { status: "partial", agentClaimed: false },
      error: { code: "agent_config_conflict" },
    });
    expect(await readFile(managedPath, "utf8")).toBe("managed by claw");
    expect(result.error?.message).toContain("still owns SKILL.md");
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      status: "partial",
      agentClaimed: false,
    });
  });

  it("removes an empty workspace created before an adoption claim loses", async () => {
    const { root, plan, config } = await fixture({ createWorkspace: false });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        transform({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        });
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "agent_config_conflict" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(result.error?.message).toContain("removed the empty workspace it created");
    expect(existsSync(plan.agent.workspace)).toBe(false);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("removes its new workspace when recording the adoption phase fails", async () => {
    const { root, plan, config } = await fixture({ createWorkspace: false });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      updateRecord: () => {
        throw new Error("synthetic phase write failure");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "provenance_failed" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(existsSync(plan.agent.workspace)).toBe(false);
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("preserves a replacement for the workspace created before an adoption claim loses", async () => {
    const { root, plan, config } = await fixture({ createWorkspace: false, managedFile: true });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const managedPath = join(plan.agent.workspace, "SKILL.md");

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        await rm(plan.agent.workspace, { recursive: true });
        await mkdir(plan.agent.workspace);
        await writeFile(managedPath, "managed by claw");
        transform({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        });
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: false,
      error: { code: "agent_config_conflict" },
    });
    expect(result.installRecord).toBeUndefined();
    expect(existsSync(plan.agent.workspace)).toBe(true);
    expect(await readFile(managedPath, "utf8")).toBe("managed by claw");
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("retains ownership when its created workspace cannot be removed after a lost claim", async () => {
    const { root, plan, config } = await fixture({ createWorkspace: false });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const retainedPath = join(plan.agent.workspace, "operator.txt");

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        await writeFile(retainedPath, "appeared during apply");
        transform({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        });
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: false,
      installRecord: { status: "partial", agentClaimed: false },
      error: { code: "agent_config_conflict" },
    });
    expect(result.error?.message).toContain(plan.agent.workspace);
    expect(existsSync(retainedPath)).toBe(true);
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      status: "partial",
      agentClaimed: false,
    });
  });

  it("rejects a concurrently configured overlapping workspace in the final CAS", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    let committedConfig: OpenClawConfig | undefined;

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        const racedConfig: OpenClawConfig = {
          ...config,
          agents: {
            entries: {
              ...config.agents?.entries,
              other: { workspace: join(plan.agent.workspace, "nested") },
            },
          },
        };
        committedConfig = transform(racedConfig);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "agent_workspace_conflict" },
    });
    // A workspace conflict loses the same claim as a digest conflict, so it releases the same way.
    expect(result.installRecord).toBeUndefined();
    expect(committedConfig).toBeUndefined();
  });

  it("preserves an existing v3 resume record when the early digest check loses a race", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const resumeRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });
    const installPackages = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        env,
        resumeRecord,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => ({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        }),
        installPackages,
      }),
    ).rejects.toMatchObject({ code: "agent_config_conflict" });

    expect(installPackages).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toEqual(resumeRecord);
  });

  it.each(["pending", "partial"] as const)(
    "preserves an implicitly resumed %s record when the early digest check loses",
    async (status) => {
      const { root, plan, config } = await fixture();
      const env = { OPENCLAW_STATE_DIR: join(root, "state") };
      const existingRecord = persistClawInstallRecord(plan, { env, status, nowMs: 1 });
      const installPackages = vi.fn();

      await expect(
        applyClawAddPlan(plan, {
          env,
          consentPlanIntegrity: plan.planIntegrity,
          readConfig: () => ({
            ...config,
            agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
          }),
          installPackages,
        }),
      ).rejects.toMatchObject({ code: "agent_config_conflict" });

      expect(installPackages).not.toHaveBeenCalled();
      expect(readClawInstallRecord("worker", { env })).toEqual(existingRecord);
    },
  );

  it("keeps prior retained effects when a resumed adoption loses its in-lock recheck", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const managedPath = join(plan.agent.workspace, "SKILL.md");
    const managed = managedWorkspaceFile(plan, "managed by claw");
    await writeFile(managedPath, "operator changed this");
    upsertClawWorkspaceFile(managed, { env });
    expect(readClawWorkspaceFiles("worker", { env })).toHaveLength(1);
    const resumeRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });

    const result = await applyClawAddPlan(plan, {
      env,
      resumeRecord,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      readConfigForApply: () => ({
        ...config,
        agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
      }),
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      installRecord: { agentClaimed: false, status: "partial" },
      workspaceFiles: [expect.objectContaining({ path: "SKILL.md" })],
      error: { code: "agent_config_conflict" },
    });
    expect(result.error?.message).toContain("Claw still owns SKILL.md");
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      agentClaimed: false,
      status: "partial",
    });
    expect(readClawWorkspaceFiles("worker", { env })).toHaveLength(1);
    expect(await readFile(managedPath, "utf8")).toBe("operator changed this");
  });

  it("removes an unclaimed failed attempt without deleting the operator's agent", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const managedPath = join(plan.agent.workspace, "SKILL.md");
    const managed = managedWorkspaceFile(plan, "managed by claw");
    const operatorConfig: OpenClawConfig = {
      ...config,
      bindings: [{ agentId: "WORKER", match: { channel: "telegram" } }],
      tools: { agentToAgent: { allow: ["WORKER"] } },
    };

    const failed = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => operatorConfig,
      createWorkspaceFiles: async () => {
        await writeFile(managedPath, "managed by claw");
        upsertClawWorkspaceFile(managed, { env });
        return [managed];
      },
      commitConfig: async (transform) => {
        transform(operatorConfig);
        await writeFile(managedPath, "operator changed this");
        throw new Error("config write failed");
      },
    });

    expect(failed).toMatchObject({
      status: "partial",
      configCommitted: false,
      installRecord: { agentOrigin: "adopted", agentClaimed: false },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      status: "partial",
      agentClaimed: false,
    });

    const currentWorkspace = join(root, "operator-current-workspace");
    const operatorFile = join(currentWorkspace, "operator.txt");
    await mkdir(currentWorkspace);
    await writeFile(operatorFile, "operator state");
    const changedOperatorConfig: OpenClawConfig = {
      ...operatorConfig,
      agents: {
        entries: {
          worker: { ...operatorConfig.agents?.entries?.worker, workspace: currentWorkspace },
        },
      },
    };
    const remove = await buildClawRemovePlan("worker", { env, config: changedOperatorConfig });
    expect(remove.blockers).toEqual([]);
    expect(remove.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", action: "retain", blocked: false }),
    );
    expect(remove.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", target: plan.agent.workspace }),
    );
    expect(remove.actions).not.toContainEqual(
      expect.objectContaining({ kind: "configBinding", action: "remove" }),
    );
    expect(remove.actions).not.toContainEqual(
      expect.objectContaining({ kind: "agentAllow", action: "remove" }),
    );

    const removed = await applyClawRemovePlan(remove, {
      env,
      config: changedOperatorConfig,
      consentPlanIntegrity: remove.planIntegrity,
    });

    expect(removed).toMatchObject({ status: "complete", agentRemoved: false });
    expect(changedOperatorConfig.agents?.entries?.worker).toBeDefined();
    expect(changedOperatorConfig.bindings).toHaveLength(1);
    expect(changedOperatorConfig.tools?.agentToAgent?.allow).toEqual(["WORKER"]);
    expect(await readFile(managedPath, "utf8")).toBe("operator changed this");
    expect(await readFile(operatorFile, "utf8")).toBe("operator state");
    await expect(
      readClawStatus("worker", { env, config: changedOperatorConfig }),
    ).resolves.toMatchObject({ summary: { claws: 0 } });
  });

  it("retains pre-existing adopted files while removing files written by an unclaimed attempt", async () => {
    const root = tempDirs.make("openclaw-claw-unclaimed-workspace-files-");
    const workspace = join(root, "workspace");
    await mkdir(join(root, "content"), { recursive: true });
    await mkdir(workspace);
    await writeFile(join(root, "content", "adopted.md"), "operator file\n");
    await writeFile(join(root, "content", "adopted-missing.md"), "missing operator file\n");
    await writeFile(join(root, "content", "written.md"), "claw file\n");
    await writeFile(join(root, "content", "replaced.md"), "replaceable claw file\n");
    await writeFile(join(root, "content", "linked.md"), "replaceable claw link\n");
    await writeFile(join(root, "content", "missing.md"), "missing claw file\n");
    await mkdir(join(root, "operator-target"));
    await writeFile(join(root, "operator-target", "content.md"), "operator link target\n");
    await writeFile(join(workspace, "adopted.md"), "operator file\n");
    await writeFile(join(workspace, "adopted-missing.md"), "missing operator file\n");
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker", name: "Worker" },
      workspace: {
        files: [
          { source: "content/adopted.md", path: "adopted.md" },
          { source: "content/adopted-missing.md", path: "adopted-missing.md" },
          { source: "content/written.md", path: "written.md" },
          { source: "content/replaced.md", path: "replaced.md" },
          { source: "content/linked.md", path: "linked.md" },
          { source: "content/missing.md", path: "missing.md" },
        ],
      },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const config: OpenClawConfig = {
      agents: { entries: { worker: { name: "Worker", workspace } } },
    };
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source: {
        kind: "package",
        name: "@acme/worker",
        version: "1.0.0",
        packageRoot: root,
        manifestPath: join(root, "openclaw.claw.json"),
        integrityKind: "artifact",
        integrity: "sha256:manifest",
        byteLength: 1,
      },
      context: {
        workspace,
        adoptExistingWorkspace: true,
        adoptExistingAgent: true,
        existingAgents: [{ id: "worker", name: "Worker", workspace }],
      },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspaceFile", id: "adopted.md", action: "adopt" }),
        expect.objectContaining({ kind: "workspaceFile", id: "written.md", action: "write" }),
      ]),
    );
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    persistClawInstallRecord(plan, { env, status: "workspace_ready", nowMs: 1 });
    await createClawWorkspaceFiles(plan, { env, nowMs: 2 });
    const replacement = join(workspace, "operator-replacement.tmp");
    await writeFile(replacement, "replaceable claw file\n");
    await unlink(join(workspace, "replaced.md"));
    await rename(replacement, join(workspace, "replaced.md"));
    await unlink(join(workspace, "linked.md"));
    await symlink(
      join(root, "operator-target"),
      join(workspace, "linked.md"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await unlink(join(workspace, "missing.md"));
    await unlink(join(workspace, "adopted-missing.md"));

    const remove = await buildClawRemovePlan("worker", { env, config });
    expect(remove.blockers).toEqual([]);
    expect(remove.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspaceFile",
          id: "adopted.md",
          action: "retain",
        }),
        expect.objectContaining({
          kind: "workspaceFile",
          id: "written.md",
          action: "delete",
        }),
        expect.objectContaining({
          kind: "workspaceFile",
          id: "replaced.md",
          action: "retain",
        }),
        expect.objectContaining({
          kind: "workspaceFile",
          id: "linked.md",
          action: "retain",
          blocked: false,
        }),
      ]),
    );
    const removed = await applyClawRemovePlan(remove, {
      env,
      config,
      consentPlanIntegrity: remove.planIntegrity,
    });
    expect(removed).toMatchObject({
      status: "complete",
      agentRemoved: false,
      workspaceFiles: expect.arrayContaining([
        { path: "adopted.md", action: "retainedUnowned" },
        { path: "adopted-missing.md", action: "missing" },
        { path: "written.md", action: "deleted" },
        { path: "replaced.md", action: "retainedUnowned" },
        { path: "linked.md", action: "retainedUnowned" },
        { path: "missing.md", action: "missing" },
      ]),
    });
    await expect(readFile(join(workspace, "adopted.md"), "utf8")).resolves.toBe("operator file\n");
    await expect(readFile(join(workspace, "written.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(workspace, "replaced.md"), "utf8")).resolves.toBe(
      "replaceable claw file\n",
    );
    await expect(readFile(join(workspace, "linked.md", "content.md"), "utf8")).resolves.toBe(
      "operator link target\n",
    );
    await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
      records: [],
    });
    expect(config.agents?.entries?.worker).toBeDefined();
  });
});
