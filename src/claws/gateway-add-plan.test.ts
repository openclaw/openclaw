import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGatewayClawAddPlan, projectGatewayClawAddPlan } from "./gateway-add-plan.js";
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
          },
        },
      ],
    });
    const response = JSON.stringify(projected);
    expect(response).not.toContain(source.source.packageRoot);
    expect(response).not.toContain("STATUSPAGE_TOKEN");
    expect(response).not.toContain("Review active incidents");

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
