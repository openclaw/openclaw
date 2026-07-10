import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawPackage, ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-update-"));
  await writeFile(join(root, "SOUL.md"), "base soul\n", "utf8");
  await writeFile(join(root, "OLD.md"), "old\n", "utf8");
  const raw = {
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    workspace: {
      bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
      files: [{ source: "OLD.md", path: "OLD.md" }],
    },
    packages: [
      { kind: "skill", source: "clawhub", ref: "triage", version: "1.0.0" },
      { kind: "plugin", source: "clawhub", ref: "obsolete", version: "1.0.0" },
    ],
    mcpServers: { docs: { command: "uvx", args: ["docs-mcp"] } },
    cronJobs: [
      {
        id: "daily",
        schedule: { cron: "0 9 * * *" },
        session: "isolated",
        message: "Base report",
      },
    ],
  };
  const parsed = parseClawManifest(raw);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity: "sha256:base",
  };
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  const addPlan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  let config: OpenClawConfig = {};
  await applyClawAddPlan(addPlan, {
    env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    installPackages: async (plan, options) =>
      plan.actions
        .filter((action) => action.kind === "package")
        .map((action) => persistClawPackageRef(plan, action.details as ClawPackage, options)),
    installMcpServers: async (plan, options) =>
      await installClawMcpServers(plan, {
        ...options,
        setMcpServer: async ({ name, server }) => {
          config.mcp = { ...config.mcp, servers: { ...config.mcp?.servers, [name]: server } };
          return { ok: true, path: "config", config, mcpServers: config.mcp.servers! };
        },
      }),
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
  });
  return { root, env, config, manifest: parsed.manifest, source };
}

function targetSource(root: string, version: string, integrity: string): ClawSourceIdentity {
  return {
    kind: "package",
    name: "@acme/worker",
    version,
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrity,
  };
}

describe("buildClawUpdatePlan", () => {
  it("reports an unchanged grouped target without mutating state", async () => {
    const current = await fixture();
    const beforeConfig = structuredClone(current.config);

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      stateOptions: { env: current.env },
    });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      found: true,
      summary: { totalActions: 7, unchanged: 7, added: 0, changed: 0, removed: 0 },
      blockers: [],
    });
    expect(current.config).toEqual(beforeConfig);
  });

  it("resolves an unambiguous installed package name to its final local agent id", async () => {
    const current = await fixture();

    const plan = await buildClawUpdatePlan({
      agentId: "@acme/worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      stateOptions: { env: current.env },
    });

    expect(plan).toMatchObject({ found: true, agentId: "worker", blockers: [] });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "unchanged" }),
    );
  });

  it("plans restoration when the owned agent entry is missing", async () => {
    const current = await fixture();
    current.config.agents = { ...current.config.agents, list: [] };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      stateOptions: { env: current.env },
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "change", blocked: false }),
    );
  });

  it("plans grouped add, change, and removal actions", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "SOUL-v2.md"), "new soul\n", "utf8");
    await writeFile(join(current.root, "NEW.md"), "new\n", "utf8");
    const raw = {
      schemaVersion: 1,
      agent: { id: "requested-id", name: "Worker v2" },
      workspace: {
        bootstrapFiles: { "SOUL.md": { source: "SOUL-v2.md" } },
        files: [{ source: "NEW.md", path: "NEW.md" }],
      },
      packages: [
        { kind: "skill", source: "clawhub", ref: "triage", version: "2.0.0" },
        { kind: "plugin", source: "clawhub", ref: "new-plugin", version: "1.0.0" },
      ],
      mcpServers: {
        docs: { command: "uvx", args: ["docs-mcp-v2"] },
        search: {
          url: "https://mcp.example.com/search",
          transport: "streamable-http",
          auth: "oauth",
        },
      },
      cronJobs: [
        {
          id: "daily",
          schedule: { cron: "0 10 * * *" },
          session: "isolated",
          message: "Updated report",
        },
        {
          id: "weekly",
          schedule: { cron: "0 9 * * 1" },
          session: "isolated",
          message: "Weekly report",
        },
      ],
    };
    const parsed = parseClawManifest(raw);
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      stateOptions: { env: current.env },
    });

    expect(plan.summary).toMatchObject({
      totalActions: 11,
      added: 4,
      changed: 5,
      removed: 2,
      unchanged: 0,
      manual: 0,
      blocked: 0,
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "change", id: "worker" }),
        expect.objectContaining({ kind: "workspaceFile", action: "remove", id: "OLD.md" }),
        expect.objectContaining({ kind: "package", action: "change", id: "skill:triage" }),
        expect.objectContaining({ kind: "mcpServer", action: "add", id: "search" }),
        expect.objectContaining({ kind: "cronJob", action: "change", id: "daily" }),
      ]),
    );
  });

  it("marks operator drift and unresolved ownership as manual", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "workspace-worker", "SOUL.md"), "operator edit\n", "utf8");
    current.config.mcp!.servers!.docs = { command: "node", args: ["operator.mjs"] };
    openOpenClawStateDatabase({ env: current.env })
      .db.prepare("UPDATE claw_cron_refs SET status = 'pending' WHERE agent_id = 'worker'")
      .run();

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      stateOptions: { env: current.env },
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspaceFile", id: "SOUL.md", action: "manual" }),
        expect.objectContaining({ kind: "mcpServer", id: "docs", action: "manual" }),
        expect.objectContaining({ kind: "cronJob", id: "daily", action: "manual" }),
      ]),
    );
    expect(plan.summary.manual).toBe(3);
    expect(plan.summary.blocked).toBe(3);
    expect(plan.actions.filter((action) => action.action === "manual")).toEqual(
      expect.arrayContaining([expect.objectContaining({ blocked: true })]),
    );
  });

  it("fails closed for missing agents and mismatched package identity", async () => {
    const current = await fixture();
    const missing = await buildClawUpdatePlan({
      agentId: "missing",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      stateOptions: { env: current.env },
    });
    expect(missing.blockers).toContainEqual(expect.objectContaining({ code: "claw_not_found" }));

    const mismatch = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: { ...current.source, name: "@other/worker" },
      config: current.config,
      stateOptions: { env: current.env },
    });
    expect(mismatch.blockers).toContainEqual(
      expect.objectContaining({ code: "claw_identity_mismatch" }),
    );
  });
});
