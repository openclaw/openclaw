import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGatewayClawAddPlan, projectGatewayClawAddPlan } from "./gateway-add-plan.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";

const preflightClawPackage = vi.hoisted(() => vi.fn(async () => ({ ok: false, code: "fixture" })));
vi.mock("./packages.js", () => ({ preflightClawPackage }));

afterEach(() => vi.unstubAllEnvs());

describe("Gateway Claw Add plan", () => {
  it("uses the canonical planner and keeps source paths out of reviewed facts", async () => {
    const fixture = path.resolve("src/claws/fixtures/workspace-agent.claw.json");
    const source = await readClawManifestFile(fixture);
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const config = { agents: { list: [] } };
    const plan = await buildGatewayClawAddPlan(source, {
      config,
      agentId: "claw-gateway-add-fixture",
      sourceMcpServers: {},
    });
    const projected = projectGatewayClawAddPlan(
      plan,
      source.source.packageRoot,
      {
        riskAcknowledgementRequired: false,
        trustRecord: {
          clawhubTrustDisposition: "clean",
          clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
        },
      },
      config,
    );

    expect(plan.actions.filter((action) => action.kind === "workspaceFile")).toHaveLength(3);
    expect(projected).toMatchObject({
      operation: "add",
      target: { agentId: "claw-gateway-add-fixture" },
      pluginReviews: [],
      riskAcknowledgementRequired: false,
    });
    expect(JSON.stringify(projected)).not.toContain(source.source.packageRoot);
    expect(JSON.stringify(projected)).not.toContain("sourcePath");
  });

  it("returns a blocked preview when the requested agent ID already exists", async () => {
    const fixture = path.resolve("src/claws/fixtures/workspace-agent.claw.json");
    const source = await readClawManifestFile(fixture);
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const config = { agents: { list: [{ id: "claw-gateway-add-fixture" }] } };
    const plan = await buildGatewayClawAddPlan(source, {
      config,
      agentId: "claw-gateway-add-fixture",
      sourceMcpServers: {},
    });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_id_collision" }));

    const projected = projectGatewayClawAddPlan(
      plan,
      source.source.packageRoot,
      {
        riskAcknowledgementRequired: false,
        trustRecord: {
          clawhubTrustDisposition: "clean",
          clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
        },
      },
      config,
    );
    expect(projected).toMatchObject({
      target: { agentId: "claw-gateway-add-fixture" },
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "agent_id_collision" }),
        expect.objectContaining({ code: "configured_access_unavailable" }),
      ]),
    });
    expect(projected.configuredAccess).toBeUndefined();
  });

  it("preflights plugin grants with the config that Add will install under", async () => {
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/incident-response.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const config = {
      plugins: { entries: { "plugin-pager-duty": { hooks: { allowConversationAccess: true } } } },
    };
    await buildGatewayClawAddPlan(source, {
      config,
      agentId: "claw-gateway-plugin-config-fixture",
      sourceMcpServers: {},
    });
    expect(preflightClawPackage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plugin" }),
      expect.any(String),
      { config },
    );
  });

  it("uses the configured state root for a new agent workspace", async () => {
    const stateDir = path.join(
      realpathSync(os.tmpdir()),
      "openclaw-claws-gateway-add-isolated-state",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }

    const plan = await buildGatewayClawAddPlan(source, {
      config: { agents: { list: [] } },
      agentId: "claw-gateway-state-root-fixture",
      sourceMcpServers: {},
    });

    expect(plan.agent.workspace).toBe(
      path.join(stateDir, "workspace-claw-gateway-state-root-fixture"),
    );
  });

  it("keeps a new Claw workspace outside the default agent workspace", async () => {
    const stateDir = path.join(realpathSync(os.tmpdir()), "openclaw-claws-gateway-default-root");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const mainWorkspace = path.join(stateDir, "workspace");
    const plan = await buildGatewayClawAddPlan(source, {
      config: {
        agents: {
          defaults: { workspace: mainWorkspace },
          entries: { main: { workspace: mainWorkspace } },
        },
      },
      agentId: "claw-gateway-default-root-fixture",
      sourceMcpServers: {},
    });

    expect(plan.agent.workspace).toBe(
      path.join(stateDir, "workspace-claw-gateway-default-root-fixture"),
    );
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain("workspace_collision");
  });

  it("uses a sibling workspace when an implicit main agent owns the default root", async () => {
    const stateDir = path.join(realpathSync(os.tmpdir()), "openclaw-claws-gateway-legacy-root");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const mainWorkspace = path.join(stateDir, "workspace");
    const plan = await buildGatewayClawAddPlan(source, {
      config: { agents: { defaults: { workspace: mainWorkspace } } },
      agentId: "claw-gateway-legacy-root-fixture",
      sourceMcpServers: {},
    });

    expect(plan.agent.workspace).toBe(
      path.join(stateDir, "workspace-claw-gateway-legacy-root-fixture"),
    );
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain("workspace_collision");
  });

  it("keeps an explicitly configured workspace for a blocked agent", async () => {
    const stateDir = path.join(realpathSync(os.tmpdir()), "openclaw-claws-gateway-explicit-root");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const mainWorkspace = path.join(stateDir, "workspace");
    const explicitWorkspace = path.join(mainWorkspace, "existing-agent");
    const plan = await buildGatewayClawAddPlan(source, {
      config: {
        agents: {
          defaults: { workspace: mainWorkspace },
          entries: {
            main: { workspace: mainWorkspace },
            "existing-agent": { workspace: explicitWorkspace },
          },
        },
      },
      agentId: "existing-agent",
      sourceMcpServers: {},
    });

    expect(plan.agent.workspace).toBe(explicitWorkspace);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("agent_id_collision");
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("workspace_collision");
  });

  it.each(["is inside", "contains"] as const)(
    "blocks a new workspace that %s an existing agent workspace",
    async (relationship) => {
      const source = await readClawManifestFile(
        path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
      );
      expect(source.ok).toBe(true);
      if (!source.ok) {
        return;
      }
      const workspace = path.join(realpathSync(os.tmpdir()), "openclaw-claws-gateway-deep-overlap");
      const nested = path.join(workspace, "nested-agent");
      const plan = await buildClawAddPlan({
        manifest: source.manifest,
        source: source.source,
        context: {
          workspace: relationship === "is inside" ? nested : workspace,
          existingWorkspacePaths: [relationship === "is inside" ? workspace : nested],
        },
      });

      expect(plan.blockers).toContainEqual(
        expect.objectContaining({
          code: "workspace_collision",
          message: expect.stringContaining("overlaps an existing agent workspace"),
        }),
      );
      expect(plan.actions).toContainEqual(
        expect.objectContaining({ kind: "workspace", blocked: true }),
      );
    },
  );

  it("reviews configured access and recurring work without exposing source secrets", async () => {
    const fixture = path.resolve("src/claws/fixtures/incident-response.claw.json");
    const source = await readClawManifestFile(fixture);
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const config = { agents: { list: [] } };
    const plan = await buildGatewayClawAddPlan(source, {
      config,
      sourceMcpServers: {},
      packagePreflight: async () => ({
        ok: false,
        code: "test_unavailable",
        message: "Package install is unavailable in this preview test.",
      }),
    });
    const projected = projectGatewayClawAddPlan(
      plan,
      source.source.packageRoot,
      {
        riskAcknowledgementRequired: false,
        trustRecord: {
          clawhubTrustDisposition: "clean",
          clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
        },
      },
      config,
    );

    expect(projected.configuredAccess).toMatchObject({
      coverage: "configuration-only",
      desired: {
        tools: {
          allowed: expect.arrayContaining(["read", "write", "web_fetch"]),
          excluded: expect.arrayContaining(["exec", "browser"]),
        },
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
        heartbeat: { enabled: true, intervalMs: 1_800_000 },
      },
    });
    expect(projected.scheduledJobs).toEqual({
      coverage: "package-declarations",
      jobs: [
        {
          id: "heartbeat-summary",
          action: "schedule",
          blocked: false,
          proposed: {
            schedule: { cron: "0 * * * *", timezone: "UTC" },
            session: "isolated",
            delivery: "last-channel",
            message: "Review active incidents and prepare a concise status summary.",
            messageDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      ],
    });
    const response = JSON.stringify(projected);
    expect(response).not.toContain(source.source.packageRoot);
    expect(response).toContain('"sourceName":"STATUSPAGE_TOKEN"');
    expect(response).not.toContain("${STATUSPAGE_TOKEN}");
    expect(response).toContain("Review active incidents");

    const changed = projectGatewayClawAddPlan(
      plan,
      source.source.packageRoot,
      {
        riskAcknowledgementRequired: false,
        trustRecord: {
          clawhubTrustDisposition: "clean",
          clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
        },
      },
      { ...config, tools: { deny: ["web_fetch"] } },
    );
    expect(changed.configuredAccess?.desired?.tools.excluded).toContain("web_fetch");
    expect(changed.planIntegrity).not.toBe(projected.planIntegrity);
  });
});
