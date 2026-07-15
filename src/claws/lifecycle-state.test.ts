import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(params: { id?: string; name?: string; withFile?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-remove-"));
  if (params.withFile) {
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: params.id ?? "worker", name: "Worker" },
    workspace: params.withFile ? { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } } : {},
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: params.name ?? "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity: "sha256:manifest",
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, `workspace-${params.id ?? "worker"}`) },
  });
  return { root, plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}

async function addFixture(params: { withFile?: boolean } = {}) {
  const current = await fixture(params);
  let config: OpenClawConfig = {};
  await applyClawAddPlan(current.plan, {
    env: current.env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
  });
  return { ...current, getConfig: () => config };
}

describe("Claw status and remove", () => {
  it("reports installed agent, managed files, and package references", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      { kind: "plugin", source: "clawhub", ref: "audit", version: "2.0.0" },
      { env: current.env, nowMs: 2 },
    );
    const status = await readClawStatus("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(status).toMatchObject({
      summary: { claws: 1, partial: 0, missingAgents: 0, driftedFiles: 0, packageRefs: 1 },
      records: [
        {
          install: { agentId: "worker", claw: { name: "@acme/worker" } },
          agentState: "present",
          workspaceFiles: [{ path: "SOUL.md", state: "unchanged" }],
          packages: [{ kind: "plugin", ref: "audit" }],
        },
      ],
    });
  });

  it("removes the agent and unchanged files but only releases package refs", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      { kind: "skill", source: "clawhub", ref: "triage", version: "1.0.0" },
      { env: current.env },
    );
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      packageRefsReleased: 1,
      workspaceFiles: [{ path: "SOUL.md", action: "deleted" }],
    });
    expect(config.agents?.list).toBeUndefined();
    await expect(readFile(join(current.plan.agent.workspace, "SOUL.md"), "utf8")).rejects.toThrow();
    await expect(readClawStatus("worker", { env: current.env, config })).resolves.toMatchObject({
      summary: { claws: 0 },
    });
  });

  it("preserves modified files while releasing their provenance", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    await writeFile(target, "operator edit\n", "utf8");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", action: "retain", blocked: false }),
    );
    let config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(result.workspaceFiles).toEqual([{ path: "SOUL.md", action: "retainedModified" }]);
    await expect(readFile(target, "utf8")).resolves.toBe("operator edit\n");
  });

  it("keeps the install ledger when workspace cleanup becomes unsafe after config commit", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
        await rm(target);
        await symlink(join(current.root, "SOUL.md"), target);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: true,
      workspaceFiles: [{ path: "SOUL.md", action: "error" }],
      error: { code: "workspace_cleanup_failed" },
    });
    await expect(readClawStatus("worker", { env: current.env, config })).resolves.toMatchObject({
      summary: { claws: 1, missingAgents: 1 },
      records: [{ install: { status: "complete" }, workspaceFiles: [{ state: "unsafe" }] }],
    });
  });

  it("blocks removal when the created agent config changed", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    config.agents!.list![0] = { ...config.agents!.list![0], name: "Operator edit" };
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_modified" }));
    await expect(applyClawRemovePlan(plan, { env: current.env, config })).rejects.toMatchObject({
      code: "remove_blocked",
    });
  });

  it("requires an agent id when a package identity has multiple installs", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/shared" });
    const second = await fixture({ id: "worker-b", name: "@acme/shared" });
    persistClawInstallRecord(first.plan, { env: first.env });
    persistClawInstallRecord(second.plan, { env: first.env });
    const plan = await buildClawRemovePlan("@acme/shared", { env: first.env, config: {} });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "claw_ambiguous" }));
  });
});
