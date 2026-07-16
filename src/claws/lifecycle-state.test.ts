import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { markClawCronRefRemoved } from "./cron.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
} from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

const packageIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function fixture(
  params: {
    id?: string;
    name?: string;
    withFile?: boolean;
    withCron?: boolean;
    withMcp?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-remove-"));
  if (params.withFile) {
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: params.id ?? "worker", name: "Worker" },
    workspace: params.withFile ? { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } } : {},
    mcpServers: params.withMcp
      ? {
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
        }
      : {},
    cronJobs: params.withCron
      ? [
          {
            id: "daily-report",
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            message: "Prepare report",
          },
        ]
      : [],
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
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, `workspace-${params.id ?? "worker"}`) },
  });
  return { root, plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}

async function addFixture(
  params: { withFile?: boolean; withCron?: boolean; withMcp?: boolean } = {},
) {
  const current = await fixture(params);
  let config: OpenClawConfig = {};
  await applyClawAddPlan(current.plan, {
    consentPlanIntegrity: current.plan.planIntegrity,
    env: current.env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
    ...(params.withMcp ? { installMcpServers: async () => [] } : {}),
  });
  return { ...current, getConfig: () => config };
}

describe("Claw status and remove", () => {
  it("reports installed agent, managed files, and package references", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env, nowMs: 2 },
    );
    const status = await readClawStatus("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(status).toMatchObject({
      summary: {
        claws: 1,
        partial: 0,
        missingAgents: 0,
        driftedFiles: 0,
        packageRefs: 1,
        missingPackages: 1,
      },
      records: [
        {
          install: { agentId: "worker", claw: { name: "@acme/worker" } },
          agentState: "present",
          workspaceFiles: [{ path: "SOUL.md", state: "unchanged" }],
          packages: [{ kind: "plugin", ref: "audit", state: "missing" }],
        },
      ],
    });
  });

  it("reports orphaned subordinate ownership without a root install row", async () => {
    const current = await fixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env, nowMs: 2 },
    );

    await expect(readClawStatus("worker", { env: current.env, config: {} })).resolves.toMatchObject(
      {
        summary: { claws: 1, partial: 1, missingAgents: 1, packageRefs: 1 },
        records: [
          {
            orphaned: true,
            install: { agentId: "worker", status: "partial" },
            packages: [{ ref: "audit", state: "missing" }],
          },
        ],
      },
    );
  });

  it("previews all canonical agent config deletion effects", async () => {
    const current = await addFixture();
    const config: OpenClawConfig = {
      ...current.getConfig(),
      bindings: [{ match: { channel: "telegram", accountId: "*" }, agentId: "worker" }],
      tools: { agentToAgent: { allow: ["worker"] } },
    } as OpenClawConfig;

    const plan = await buildClawRemovePlan("worker", { env: current.env, config });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", target: "agents.list[worker]" }),
        expect.objectContaining({ kind: "configBinding", target: "bindings[agentId=worker]" }),
        expect.objectContaining({ kind: "agentAllow", target: "tools.agentToAgent.allow[worker]" }),
        expect.objectContaining({ kind: "workspace", action: "trash" }),
        expect.objectContaining({ kind: "agentState", action: "trash" }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "trash" }),
      ]),
    );
  });

  it("removes the agent and unchanged files but only releases package refs", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      {
        kind: "skill",
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env },
    );
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
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

  it("removes scheduler-owned cron jobs before agent config", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "cronJob",
        id: "daily-report",
        action: "remove",
        target: "scheduler-daily",
      }),
    );
    let config = current.getConfig();
    const order: string[] = [];
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      cronGateway: {
        remove: async (id) => {
          order.push(`cron:${id}`);
          return { ok: true };
        },
      },
      commitConfig: async (transform) => {
        order.push("config");
        config = transform(config);
      },
    });
    expect(order).toEqual(["cron:scheduler-daily", "config"]);
    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [
        { manifestId: "daily-report", schedulerJobId: "scheduler-daily", action: "removed" },
      ],
    });
  });

  it("delegates agent and cron teardown to the canonical agent lifecycle", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const calls: string[] = [];

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config: current.getConfig(),
      deleteAgent: async (agentId) => {
        calls.push(`agent:${agentId}`);
      },
      cronGateway: {
        remove: async (id) => {
          calls.push(`cron:${id}`);
          return { ok: true };
        },
      },
    });

    expect(calls).toEqual(["cron:scheduler-daily", "agent:worker"]);
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("retains the agent when recurring work cannot be disabled", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const deletedAgents: string[] = [];

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config: current.getConfig(),
      deleteAgent: async (agentId) => {
        deletedAgents.push(agentId);
      },
      cronGateway: {
        remove: async () => {
          throw new Error("scheduler unavailable");
        },
      },
    });

    expect(deletedAgents).toEqual([]);
    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: false,
      error: { code: "cron_cleanup_failed", message: "scheduler unavailable" },
      cronJobs: [{ manifestId: "daily-report", action: "error" }],
    });
  });

  it("finishes local cleanup without repeating a confirmed remote cron removal", async () => {
    const current = await addFixture({ withCron: true });
    markClawCronRefRemoved("worker", "daily-report", { env: current.env });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();
    const remoteRemovals: string[] = [];

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      cronGateway: {
        remove: async (id) => {
          remoteRemovals.push(id);
          return { ok: true };
        },
      },
    });

    expect(remoteRemovals).toEqual([]);
    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
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
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(result.workspaceFiles).toEqual([{ path: "SOUL.md", action: "retainedModified" }]);
    await expect(readFile(target, "utf8")).resolves.toBe("operator edit\n");
  });

  it("retains a replacement introduced after planning instead of deleting it", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
        await writeFile(target, "replacement\n", "utf8");
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      workspaceFiles: [{ path: "SOUL.md", action: "retainedModified" }],
    });
    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
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
      consentPlanIntegrity: plan.planIntegrity,
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
    const agent = config.agents!.list![0]!;
    config.agents!.list![0] = { ...agent, name: "Operator edit" };
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_modified" }));
    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
      }),
    ).rejects.toMatchObject({
      code: "remove_blocked",
    });
  });

  it("rejects removal consent for a different plan identity", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: "sha256:stale",
      }),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
  });

  it("requires an agent id when a package identity has multiple installs", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/shared" });
    const second = await fixture({ id: "worker-b", name: "@acme/shared" });
    persistClawInstallRecord(first.plan, { env: first.env });
    persistClawInstallRecord(second.plan, { env: first.env });
    const plan = await buildClawRemovePlan("@acme/shared", { env: first.env, config: {} });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "claw_ambiguous" }));
  });

  it("keeps Claw-installed plugin origin on every surviving Claw reference", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/first" });
    const second = await fixture({ id: "worker-b", name: "@acme/second" });
    persistClawInstallRecord(first.plan, { env: first.env, nowMs: 1 });
    persistClawInstallRecord(second.plan, { env: first.env, nowMs: 2 });
    const plugin = {
      kind: "plugin",
      source: "clawhub",
      ref: "audit",
      version: "1.0.0",
      integrity: packageIntegrity,
    } as const;
    persistClawPackageRef(first.plan, plugin, {
      env: first.env,
      nowMs: 1,
      ownership: "claw-installed",
    });
    persistClawPackageRef(second.plan, plugin, {
      env: first.env,
      nowMs: 2,
      ownership: "claw-installed",
    });
    let config: OpenClawConfig = {
      agents: { list: [first.plan.agent.config, second.plan.agent.config] },
    };
    const remove = await buildClawRemovePlan("worker-a", { env: first.env, config });
    await applyClawRemovePlan(remove, {
      consentPlanIntegrity: remove.planIntegrity,
      env: first.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(readClawPackageRefs({ env: first.env, agentId: "worker-b" })).toMatchObject([
      { ref: "audit", ownership: "claw-installed" },
    ]);
  });

  it("releases an exact pre-existing MCP server without deleting it", async () => {
    const current = await addFixture({ withMcp: true });
    const server = {
      command: "uvx",
      args: ["docs-mcp"],
      env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
    };
    await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue({
        ok: true,
        path: "config",
        config: {},
        mcpServers: { docs: server },
      }),
    });
    let config: OpenClawConfig = {
      ...current.getConfig(),
      mcp: { servers: { docs: server } },
    };
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", id: "docs", action: "release" }),
    );
    const unsetMcpServer = vi.fn();
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      unsetMcpServer,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(unsetMcpServer).not.toHaveBeenCalled();
    expect(result.mcpServers).toEqual([{ name: "docs", action: "released" }]);
    expect(config.mcp?.servers?.docs).toEqual(server);
  });

  it("deletes the final unchanged Claw-created MCP server", async () => {
    const current = await addFixture({ withMcp: true });
    const sourceServer = {
      command: "uvx",
      args: ["docs-mcp"],
      env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
    };
    await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn().mockResolvedValue({ ok: true, path: "config", config: {} }),
      listMcpServers: vi.fn().mockResolvedValue({
        ok: true,
        path: "config",
        config: {},
        mcpServers: {},
      }),
    });
    let config: OpenClawConfig = {
      ...current.getConfig(),
      mcp: {
        servers: {
          docs: {
            ...sourceServer,
            env: { DOCS_TOKEN: "resolved-secret-must-not-affect-removal" },
          },
        },
      },
    };
    const sourceMcpServers = { docs: sourceServer };
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      sourceMcpServers,
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", id: "docs", action: "remove" }),
    );
    const unsetMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {}, removed: true });
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      sourceMcpServers,
      unsetMcpServer,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(unsetMcpServer).toHaveBeenCalledWith({ name: "docs", expectedServer: sourceServer });
    expect(result.mcpServers).toEqual([{ name: "docs", action: "removed" }]);
  });
});
