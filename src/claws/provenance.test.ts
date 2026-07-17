// Tests root Claw install ownership and the narrow agent/workspace mutation slice.
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function makePlan(
  manifestValue: unknown = { schemaVersion: 1, agent: { id: "worker" } },
  options: { workspace?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claw-add-"));
  const parsed = parseClawManifest(manifestValue);
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
    byteLength: 123,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: options.workspace ?? join(root, "workspace-worker") },
  });
  return { root, plan };
}

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

function readInstallRow(agentId: string, root: string) {
  return openOpenClawStateDatabase({ env: stateEnv(root) })
    .db.prepare(
      `SELECT agent_id, schema_version, claw_name, claw_version, integrity, plan_integrity,
              workspace, agent_config_digest, agent_owned_paths_json, status, added_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as
    | {
        agent_id: string;
        schema_version: string;
        claw_name: string;
        claw_version: string;
        integrity: string;
        plan_integrity: string;
        workspace: string;
        agent_config_digest: string;
        agent_owned_paths_json: string;
        status: string;
        added_at_ms: number | bigint;
      }
    | undefined;
}

describe("Claw root install provenance", () => {
  it("persists package identity, agent ownership, workspace, and config digest", async () => {
    const { root, plan } = await makePlan();

    const record = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 42 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      claw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:manifest" },
      manifestSchemaVersion: 1,
      planIntegrity: plan.planIntegrity,
      agentId: "worker",
      workspace: plan.agent.workspace,
      agentOwnedPaths: ['agents.list["worker"]'],
      status: "complete",
      addedAtMs: 42,
    });
    expect(record.agentConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readInstallRow("worker", root)).toMatchObject({
      agent_id: record.agentId,
      schema_version: record.schemaVersion,
      claw_name: record.claw.name,
      claw_version: record.claw.version,
      integrity: record.claw.integrity,
      plan_integrity: record.planIntegrity,
      workspace: record.workspace,
      agent_config_digest: record.agentConfigDigest,
      agent_owned_paths_json: JSON.stringify(record.agentOwnedPaths),
      status: record.status,
      added_at_ms: record.addedAtMs,
    });
  });

  it("does not overwrite a completed install record for the same agent", async () => {
    const { root, plan } = await makePlan();
    persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });

    expect(() => persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 2 })).toThrow();
    expect(Number(readInstallRow("worker", root)?.added_at_ms)).toBe(1);
  });

  it("resumes a matching non-complete install record without inserting again", async () => {
    const { root, plan } = await makePlan();
    const first = persistClawInstallRecord(plan, {
      env: stateEnv(root),
      status: "pending",
      nowMs: 1,
    });

    const resumed = persistClawInstallRecord(plan, {
      env: stateEnv(root),
      status: "pending",
      nowMs: 2,
    });

    expect(resumed).toEqual(first);
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toMatchObject({
      agentId: "worker",
      status: "pending",
      addedAtMs: 1,
    });
  });
});

describe("applyClawAddPlan", () => {
  it("appends one agent, preserves defaults and existing agents, and creates a new workspace", async () => {
    const { root, plan } = await makePlan({
      schemaVersion: 1,
      agent: {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
      },
    });
    let config: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/operator/default" },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 10,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      workspaceCreated: true,
      configCommitted: true,
      installRecord: { agentId: "worker" },
    });
    expect(config.agents?.defaults).toEqual({ workspace: "/operator/default" });
    expect(config.agents?.list).toEqual([
      { id: "main", default: true },
      {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
        workspace: plan.agent.workspace,
      },
    ]);
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
  });

  it("rechecks agent collisions during the config commit and cleans the reserved workspace", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          transform({ agents: { list: [{ id: "worker" }] } });
        },
      }),
    ).rejects.toMatchObject({ code: "agent_id_collision" });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("records a partial add when the workspace appears after planning", async () => {
    const { root, plan } = await makePlan();
    await mkdir(plan.agent.workspace);

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });
    expect(readInstallRow("worker", root)?.status).toBe("partial");
  });

  it("records parent-directory creation failures before workspace mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-add-"));
    const blockedParent = join(root, "blocked-parent");
    await writeFile(blockedParent, "not a directory", "utf8");
    const { plan } = await makePlan(undefined, {
      workspace: join(blockedParent, "workspace-worker"),
    });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
      }),
    ).rejects.toMatchObject({ code: "workspace_parent_failed" });
    expect(readInstallRow("worker", root)?.status).toBe("partial");
  });

  it("resumes a matching partial add with an existing non-empty workspace", async () => {
    const { root, plan } = await makePlan();
    let config: OpenClawConfig = {};
    let attempts = 0;

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
        commitConfig: async (transform) => {
          attempts += 1;
          if (attempts === 1) {
            await writeFile(join(plan.agent.workspace, "leftover.txt"), "keep", "utf8");
            throw new Error("config unavailable");
          }
          config = transform(config);
        },
      }),
    ).rejects.toThrow("config unavailable");
    expect(readInstallRow("worker", root)?.status).toBe("workspace_ready");

    const retry = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(retry).toMatchObject({
      status: "complete",
      workspaceCreated: true,
      configCommitted: true,
    });
    expect(config.agents?.list).toContainEqual(expect.objectContaining({ id: "worker" }));
    expect(readInstallRow("worker", root)?.status).toBe("complete");
  });

  it("blocks declared components that this lifecycle slice cannot yet create", async () => {
    const { plan } = await makePlan({
      schemaVersion: 1,
      agent: { id: "worker" },
      packages: [{ kind: "skill", source: "clawhub", ref: "demo", version: "1.0.0" }],
    });

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: plan.planIntegrity }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ClawAddMutationError>>({ code: "plan_blocked" }),
    );
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("fails before mutation when the pending provenance record cannot be persisted", async () => {
    const { plan } = await makePlan();
    let config: OpenClawConfig = {};

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        persistRecord: () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "provenance_failed" });
    expect(config.agents?.list).toBeUndefined();
  });

  it("rejects mutation when consent does not bind the current plan", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: "sha256:stale" }),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });
});
