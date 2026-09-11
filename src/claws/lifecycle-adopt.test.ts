// Tests for planning Claw adds that adopt an existing workspace directory.
import { createHash } from "node:crypto";
import { link, mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { ClawPackageInstallError } from "./packages.js";
import { makeProvenancePlan, readInstallRow, stateEnv } from "./provenance.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawSourceIdentity } from "./types.js";
import { readClawWorkspaceAdoption } from "./workspace-origin.js";
import { readClawWorkspaceFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function requireManifest(): ClawManifest {
  const result = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "adopt-agent" },
    workspace: {
      bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      files: [{ source: "workspace/reference/policy.md", path: "reference/policy.md" }],
    },
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.manifest;
}

async function createPlanSource(): Promise<{ source: ClawSourceIdentity; workspace: string }> {
  const root = tempDirs.make("openclaw-claw-adopt-plan-");
  await mkdir(join(root, "workspace", "reference"), { recursive: true });
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Agent\n", "utf8");
  await writeFile(join(root, "workspace", "reference", "policy.md"), "Policy\n", "utf8");
  return {
    source: {
      kind: "package",
      name: "@acme/adopt-agent",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    workspace: join(root, "existing-workspace"),
  };
}

describe("buildClawAddPlan workspace adoption", () => {
  it("adopts an existing workspace when identical declared files are present", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Agent\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "adopt", blocked: false }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", action: "adopt" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "reference/policy.md",
        action: "write",
      }),
    );
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({ kind: "agent", path: "workspace", action: "configure" }),
    );
  });

  it("blocks adoption when a declared file exists with different content", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Divergent\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", blocked: true }),
    );
  });

  it("blocks adoption of a hardlinked declared file before consent", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "origin.md"), "# Agent\n", "utf8");
    await link(join(workspace, "origin.md"), join(workspace, "AGENTS.md"));

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", blocked: true }),
    );
    expect(plan.actions).not.toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "AGENTS.md", action: "adopt" }),
    );
  });

  it("blocks an existing package bootstrap instead of claiming operator-owned content", async () => {
    const { source, workspace } = await createPlanSource();
    const bootstrap = Buffer.from("Package setup\n");
    const bootstrapPath = join(source.packageRoot, "BOOTSTRAP.md");
    await writeFile(bootstrapPath, bootstrap);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "BOOTSTRAP.md"), bootstrap);

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      packageBootstrap: {
        sourcePath: "BOOTSTRAP.md",
        realPath: bootstrapPath,
        byteLength: bootstrap.byteLength,
        digest: `sha256:${createHash("sha256").update(bootstrap).digest("hex")}`,
      },
      context: { workspace, adoptExistingWorkspace: true },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict", path: "$packageBootstrap" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", id: "BOOTSTRAP.md", blocked: true }),
    );
  });

  it("still blocks adoption of a workspace configured for another agent", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        existingWorkspacePaths: [workspace],
      },
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "workspace_collision" }));
  });

  it("keeps blocking a non-adopted existing workspace", async () => {
    const { source, workspace } = await createPlanSource();
    await mkdir(workspace, { recursive: true });

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: { workspace },
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "workspace_collision" }));
  });

  it("blocks adopting a subdirectory of another agent's configured workspace", async () => {
    const { source, workspace: parent } = await createPlanSource();
    const subdir = join(parent, "subdir");
    await mkdir(join(subdir, "reference"), { recursive: true });
    await writeFile(join(subdir, "AGENTS.md"), "# Agent\n", "utf8");
    await writeFile(join(subdir, "reference", "policy.md"), "Policy\n", "utf8");

    // Every declared file matches on disk; absent the overlap check this would adopt cleanly.
    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: {
        workspace: subdir,
        adoptExistingWorkspace: true,
        existingWorkspacePaths: [parent],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_collision", path: "$.workspace" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", blocked: true }),
    );
  });

  it("blocks adopting a workspace that contains another agent's configured subdirectory", async () => {
    const { source, workspace: parent } = await createPlanSource();
    const subdir = join(parent, "subdir");
    await mkdir(subdir, { recursive: true });

    const plan = await buildClawAddPlan({
      manifest: requireManifest(),
      source,
      context: {
        workspace: parent,
        adoptExistingWorkspace: true,
        existingWorkspacePaths: [subdir],
      },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_collision", path: "$.workspace" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", blocked: true }),
    );
  });
});

describe("applyClawAddPlan workspace adoption", () => {
  it("revalidates an adopted workspace before realizing shared plugin requirements", async () => {
    const root = tempDirs.make("openclaw-claw-adopt-add-");
    const workspace = join(root, "existing-workspace");
    await mkdir(workspace);
    const { plan } = await makeProvenancePlan(
      root,
      {
        schemaVersion: 1,
        agent: { id: "worker" },
        packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/audit", version: "1.0.0" }],
      },
      {
        workspace,
        adoptExistingWorkspace: true,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
      },
    );
    expect(plan.blockers).toEqual([]);
    await rmdir(workspace);
    const installPackages = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
        installPackages,
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });
    expect(installPackages).not.toHaveBeenCalled();
    expect(readInstallRow("worker", root)).toBeUndefined();
  });

  it("preserves the recorded workspace_ready phase when shared package install fails on first adoption", async () => {
    const root = tempDirs.make("openclaw-claw-adopt-package-failure-");
    const workspace = join(root, "existing-workspace");
    await mkdir(workspace);
    const { plan } = await makeProvenancePlan(
      root,
      {
        schemaVersion: 1,
        agent: { id: "worker" },
        packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/audit", version: "1.0.0" }],
      },
      {
        workspace,
        adoptExistingWorkspace: true,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
      },
    );
    expect(plan.blockers).toEqual([]);
    const env = stateEnv(root);

    const first = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      installPackages: async () => {
        throw new ClawPackageInstallError("package_install_failed", "install failed", []);
      },
    });

    // Adoption records workspace_ready before packages run; the phase must be reflected
    // locally so a package failure preserves it instead of re-marking a stale "pending" row.
    expect(first).toMatchObject({
      status: "partial",
      installRecord: { status: "workspace_ready" },
      error: { code: "package_install_failed", message: "install failed" },
    });
    expect(readInstallRow("worker", root)?.status).toBe("workspace_ready");
    if (!first.installRecord) {
      throw new Error("expected a partial install record");
    }

    let config: OpenClawConfig = {};
    const second = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      resumeRecord: first.installRecord,
      resumePlan: plan,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      seedPackageBootstrap: async () => undefined,
      createWorkspaceFiles: async () => [],
      installPackages: async () => [],
      installMcpServers: async () => [],
      installCronJobs: async () => [],
    });

    expect(second.status).toBe("complete");
    expect(config.agents?.entries?.worker).toBeDefined();
    expect(readInstallRow("worker", root)?.status).toBe("complete");
  });
});

describe("buildClawAddPlan workspace inspection", () => {
  it("blocks an uninspectable workspace parent at plan time, before workspace mutation", async () => {
    const root = tempDirs.make("openclaw-claw-add-");
    const blockedParent = join(root, "blocked-parent");
    await writeFile(blockedParent, "not a directory", "utf8");
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(blockedParent, "workspace-worker") },
    );

    // Resolving the workspace under a regular file fails ENOTDIR, not ENOENT. Planning fails
    // closed on it, so consent is never offered for a path apply would refuse mid-mutation.
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_parent_failed", path: "$.workspace" }),
    );
    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
      }),
    ).rejects.toMatchObject({ code: "plan_blocked" });
    expect(readInstallRow("worker", root)).toBeUndefined();
  });
});

describe("planWorkspaceAdoptionTargets resume ownership", () => {
  async function buildResumeManifestAndSource(params: { withPlugin?: boolean } = {}) {
    const root = tempDirs.make("openclaw-claw-adopt-resume-");
    await mkdir(join(root, "content"), { recursive: true });
    await writeFile(join(root, "content", "SOUL.md"), "# Soul\n", "utf8");
    await writeFile(join(root, "content", "HEARTBEAT.md"), "# Heartbeat\n", "utf8");
    const bootstrapContent = Buffer.from("Package bootstrap\n");
    const bootstrapPath = join(root, "BOOTSTRAP.md");
    await writeFile(bootstrapPath, bootstrapContent);
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        bootstrapFiles: {
          "SOUL.md": { source: "content/SOUL.md" },
          "HEARTBEAT.md": { source: "content/HEARTBEAT.md" },
        },
      },
      ...(params.withPlugin
        ? {
            packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/audit", version: "1.0.0" }],
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
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    };
    const packageBootstrap = {
      sourcePath: "BOOTSTRAP.md",
      realPath: bootstrapPath,
      byteLength: bootstrapContent.byteLength,
      digest: `sha256:${createHash("sha256").update(bootstrapContent).digest("hex")}`,
    };
    const workspace = join(root, "existing-workspace");
    return {
      root,
      source,
      manifest: parsed.manifest,
      packageBootstrap,
      workspace,
      bootstrapContent,
    };
  }

  it("rebuilds an identical plan on resume after a config-commit failure leaves files written", async () => {
    const { root, source, manifest, packageBootstrap, workspace, bootstrapContent } =
      await buildResumeManifestAndSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "# Soul\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest,
      source,
      packageBootstrap,
      context: { workspace, adoptExistingWorkspace: true },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "SOUL.md", action: "adopt" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "HEARTBEAT.md", action: "write" }),
    );

    const env = stateEnv(root);
    const first = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      commitConfig: async () => {
        throw new Error("config unavailable");
      },
    });

    expect(first).toMatchObject({
      status: "partial",
      installRecord: { status: "workspace_ready" },
      error: { code: "config_commit_failed" },
    });
    if (!first.installRecord) {
      throw new Error("expected a partial install record");
    }
    expect(readInstallRow("worker", root)?.status).toBe("workspace_ready");
    await expect(readFile(join(workspace, "HEARTBEAT.md"), "utf8")).resolves.toBe("# Heartbeat\n");
    await expect(readFile(join(workspace, "BOOTSTRAP.md"))).resolves.toEqual(bootstrapContent);

    const workspaceOrigin = readClawWorkspaceAdoption("worker", workspace, { env });
    // The seed step ran before the config-commit failure, so this install's own
    // recordClawBootstrapSeeded call already flipped the marker's bootstrapSeeded flag.
    expect(workspaceOrigin).toEqual({
      adopted: true,
      adoptedFiles: ["SOUL.md"],
      bootstrapSeeded: true,
    });
    if (!workspaceOrigin.adopted) {
      throw new Error("expected the workspace to be recorded as adopted");
    }
    const ownedFiles = readClawWorkspaceFiles("worker", { env });

    // The CLI resume rebuilds the plan with the consented adopted set and this install's owned
    // files; the previously-missing HEARTBEAT.md and the seeded BOOTSTRAP.md now exist on disk,
    // but the rebuilt plan must still match the original.
    const resumedPlan = await buildClawAddPlan({
      manifest,
      source,
      packageBootstrap,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        resumableWorkspace: workspace,
        resumableWorkspaceOwnership: {
          adoptedFiles: workspaceOrigin.adoptedFiles,
          ownedFiles,
          bootstrapSeeded: workspaceOrigin.bootstrapSeeded,
        },
      },
    });

    expect(resumedPlan.blockers).toEqual([]);
    expect(resumedPlan.planIntegrity).toBe(plan.planIntegrity);
    expect(resumedPlan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", id: "BOOTSTRAP.md", blocked: false }),
    );
    expect(resumedPlan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "HEARTBEAT.md", action: "write" }),
    );

    // A declared file that merely looks identical, with no ownership row for it, was never
    // consented or written by this install; adoption must still block it, even mid-resume.
    const unownedFiles = ownedFiles.filter((file) => file.path !== "HEARTBEAT.md");
    const collisionPlan = await buildClawAddPlan({
      manifest,
      source,
      packageBootstrap,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        resumableWorkspace: workspace,
        resumableWorkspaceOwnership: {
          adoptedFiles: workspaceOrigin.adoptedFiles,
          ownedFiles: unownedFiles,
          bootstrapSeeded: workspaceOrigin.bootstrapSeeded,
        },
      },
    });
    expect(collisionPlan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict" }),
    );
    expect(collisionPlan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "HEARTBEAT.md", blocked: true }),
    );
  });

  it("blocks an operator-created bootstrap that only looks identical when this install never seeded it", async () => {
    const root = tempDirs.make("openclaw-claw-adopt-unseeded-bootstrap-");
    await mkdir(join(root, "content"), { recursive: true });
    await writeFile(join(root, "content", "SOUL.md"), "# Soul\n", "utf8");
    const bootstrapContent = Buffer.from("Package bootstrap\n");
    const bootstrapPath = join(root, "BOOTSTRAP.md");
    await writeFile(bootstrapPath, bootstrapContent);
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: { bootstrapFiles: { "SOUL.md": { source: "content/SOUL.md" } } },
      packages: [{ kind: "plugin", source: "clawhub", ref: "@acme/audit", version: "1.0.0" }],
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
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    };
    const packageBootstrap = {
      sourcePath: "BOOTSTRAP.md",
      realPath: bootstrapPath,
      byteLength: bootstrapContent.byteLength,
      digest: `sha256:${createHash("sha256").update(bootstrapContent).digest("hex")}`,
    };
    const workspace = join(root, "existing-workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "# Soul\n", "utf8");

    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source,
      packageBootstrap,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
      },
    });
    expect(plan.blockers).toEqual([]);
    const env = stateEnv(root);

    // installPackages runs, and fails, before the bootstrap seed step: this install never
    // gets a chance to write BOOTSTRAP.md itself.
    const first = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      installPackages: async () => {
        throw new ClawPackageInstallError("package_install_failed", "install failed", []);
      },
    });
    expect(first).toMatchObject({
      status: "partial",
      installRecord: { status: "workspace_ready" },
      error: { code: "package_install_failed" },
    });
    await expect(readFile(join(workspace, "BOOTSTRAP.md"))).rejects.toThrow();

    // An operator (or another tool) writes a byte-identical BOOTSTRAP.md while the install sits
    // partial. Its content matches what this install would seed, but this install did not write it.
    await writeFile(join(workspace, "BOOTSTRAP.md"), bootstrapContent);

    const workspaceOrigin = readClawWorkspaceAdoption("worker", workspace, { env });
    expect(workspaceOrigin).toMatchObject({ adopted: true, bootstrapSeeded: false });
    if (!workspaceOrigin.adopted) {
      throw new Error("expected the workspace to be recorded as adopted");
    }
    const ownedFiles = readClawWorkspaceFiles("worker", { env });

    const resumedPlan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source,
      packageBootstrap,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        resumableWorkspace: workspace,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
        resumableWorkspaceOwnership: {
          adoptedFiles: workspaceOrigin.adoptedFiles,
          ownedFiles,
          bootstrapSeeded: workspaceOrigin.bootstrapSeeded,
        },
      },
    });

    expect(resumedPlan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_file_conflict", path: "$packageBootstrap" }),
    );
    expect(resumedPlan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", id: "BOOTSTRAP.md", blocked: true }),
    );
  });

  it("rejects a workspace reassigned to another agent during the package install before any file effect", async () => {
    const { root, source, manifest, packageBootstrap, workspace } =
      await buildResumeManifestAndSource({ withPlugin: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "# Soul\n", "utf8");
    const plan = await buildClawAddPlan({
      manifest,
      source,
      packageBootstrap,
      context: {
        workspace,
        adoptExistingWorkspace: true,
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: `sha256:${"a".repeat(64)}`,
          installId: "audit",
        }),
      },
    });
    expect(plan.blockers).toEqual([]);
    const env = stateEnv(root);

    let config: OpenClawConfig = {};
    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      loadConfig: () => config,
      // The plan-time overlap check passed. While the shared package install is awaited, another
      // add assigns the parent of this workspace to a different agent.
      installPackages: async () => {
        config = { agents: { entries: { other: { workspace: root } } } };
        return [];
      },
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    // Admission is decided after the await, at the file-effect boundary: nothing was seeded,
    // written, or claimed inside what is now another agent's workspace.
    expect(result).toMatchObject({
      status: "partial",
      installRecord: { status: "workspace_ready" },
      error: { code: "workspace_collision" },
    });
    expect(readInstallRow("worker", root)?.status).toBe("workspace_ready");
    await expect(readFile(join(workspace, "BOOTSTRAP.md"))).rejects.toThrow();
    await expect(readFile(join(workspace, "HEARTBEAT.md"))).rejects.toThrow();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([]);
    expect(readWorkspaceStateSnapshot(workspace, { env }).setup.bootstrapSeededAt).toBeUndefined();
    expect(config.agents?.entries?.worker).toBeUndefined();
  });

  it("refuses an identical BOOTSTRAP.md that appears between consent and apply", async () => {
    const { root, source, manifest, packageBootstrap, workspace, bootstrapContent } =
      await buildResumeManifestAndSource();
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "# Soul\n", "utf8");
    const plan = await buildClawAddPlan({
      manifest,
      source,
      packageBootstrap,
      context: { workspace, adoptExistingWorkspace: true },
    });
    expect(plan.blockers).toEqual([]);
    // Consent was given with no bootstrap on disk; a byte-identical file lands before apply.
    const bootstrapPath = join(workspace, "BOOTSTRAP.md");
    await writeFile(bootstrapPath, bootstrapContent);
    const before = await stat(bootstrapPath);
    const env = stateEnv(root);

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
    });

    expect(result).toMatchObject({
      status: "partial",
      installRecord: { status: "workspace_ready" },
      error: { code: "bootstrap_conflict" },
    });
    expect(readInstallRow("worker", root)?.status).toBe("workspace_ready");
    // The operator's file is untouched, nothing else was written, and the native seed state was
    // not stamped for a file this install never wrote: the receipt stays false.
    expect((await stat(bootstrapPath)).mtimeMs).toBe(before.mtimeMs);
    await expect(readFile(join(workspace, "HEARTBEAT.md"))).rejects.toThrow();
    expect(readWorkspaceStateSnapshot(workspace, { env }).setup.bootstrapSeededAt).toBeUndefined();
    expect(readClawWorkspaceAdoption("worker", workspace, { env })).toMatchObject({
      adopted: true,
      bootstrapSeeded: false,
    });
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([]);
  });
});
