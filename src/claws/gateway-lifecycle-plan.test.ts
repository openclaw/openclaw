import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmptyClawUpdatePlan } from "./update-plan-empty.js";

const mocked = vi.hoisted(() => ({
  assertCurrent: vi.fn(),
  readInventory: vi.fn(),
  readFacts: vi.fn(),
  readRegistry: vi.fn(),
  assertRegistryCurrent: vi.fn(),
  listMcpServers: vi.fn(),
  withSource: vi.fn(),
  buildUpdate: vi.fn(),
  buildRemove: vi.fn(),
  clearPluginCache: vi.fn(),
  loadInstallRecords: vi.fn(),
  preflightPlugin: vi.fn(),
  resolvePlugin: vi.fn(),
  preflightPackage: vi.fn(),
}));

vi.mock("./inventory-read.js", () => ({ readClawInventory: mocked.readInventory }));
vi.mock("./remove-facts-read.js", () => ({ readClawRemoveFacts: mocked.readFacts }));
vi.mock("./update-plan.js", () => ({ buildClawUpdatePlan: mocked.buildUpdate }));
vi.mock("./lifecycle-state.js", () => ({ buildClawRemovePlan: mocked.buildRemove }));
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocked.withSource }));
vi.mock("./packages.js", () => ({ preflightClawPackage: mocked.preflightPackage }));
vi.mock("../config/mcp-config.js", () => ({ listConfiguredMcpServers: mocked.listMcpServers }));
vi.mock("../plugins/installed-plugin-index-record-reader.js", () => ({
  clearLoadInstalledPluginIndexInstallRecordsCache: mocked.clearPluginCache,
  loadInstalledPluginIndexInstallRecords: mocked.loadInstallRecords,
}));
vi.mock("../plugins/plugin-install-preflight.js", () => ({
  preflightPluginInstall: mocked.preflightPlugin,
  resolveInstalledClawHubPlugin: mocked.resolvePlugin,
}));
vi.mock("../state/openclaw-agent-db-registry-listing.js", () => ({
  prepareOpenClawAgentDatabaseRegistrySnapshotRead: () => ({ read: mocked.readRegistry }),
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadWorkerContext: () => ({
    admission: {
      databasePath: "/tmp/openclaw-state/state/openclaw.sqlite",
      assertCurrent: mocked.assertCurrent,
    },
    environment: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
  }),
}));

import { planClawRemoveForGateway, planClawUpdateForGateway } from "./gateway-lifecycle-plan.js";

const source = {
  source: {
    kind: "package" as const,
    name: "@openclaw/workflow-operator",
    version: "1.2.0",
    packageRoot: "/tmp/claw-source",
    manifestPath: "/tmp/claw-source/CLAW.md",
    integrityKind: "artifact" as const,
    integrity: "sha256:source",
    byteLength: 123,
  },
  manifest: { mcpServers: {} },
  diagnostics: [],
};
const installed = {
  agentId: "workflow-operator",
  claw: {
    kind: "package",
    name: "@openclaw/workflow-operator",
    version: "1.0.0",
    integrityKind: "artifact",
  },
};
const inventory = {
  installs: [installed],
  packages: [],
  workspaceFiles: [],
  mcpServers: [],
  cronJobs: [],
};
const coordinate = { packageName: "@openclaw/workflow-operator", version: "1.2.0" };
const labsConfig = {
  gateway: { controlUi: { experimental: { claws: true } } },
  agents: { list: [{ id: "workflow-operator" }] },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocked.readInventory.mockResolvedValue(inventory);
  mocked.readFacts.mockResolvedValue({ attachedJobs: [], sessionStoreOwners: [] });
  mocked.readRegistry.mockResolvedValue({
    result: { status: "available", entries: [] },
    assertCurrent: mocked.assertRegistryCurrent,
  });
  mocked.listMcpServers.mockResolvedValue({ ok: true, mcpServers: {} });
  mocked.loadInstallRecords.mockResolvedValue({});
  mocked.withSource.mockImplementation(async ({ run }) => ({
    value: await run(source),
    riskAcknowledgementRequired: false,
  }));
  mocked.buildUpdate.mockImplementation(async ({ captureGatewayProjection }) => {
    captureGatewayProjection?.({ id: "workflow-operator" });
    return makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source: source.source,
      found: true,
      blockers: [],
    });
  });
  mocked.buildRemove.mockResolvedValue({
    schemaVersion: "openclaw.clawRemovePlan.v1",
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:canonical-remove",
    target: "workflow-operator",
    agentId: "workflow-operator",
    actions: [],
    blockers: [],
  });
});

describe("Gateway Claw lifecycle plans", () => {
  it("keeps Update planning available when the Claws Labs UI switch is off", async () => {
    const config = { agents: labsConfig.agents };
    const result = await planClawUpdateForGateway({
      agentId: "workflow-operator",
      source: coordinate,
      config,
    });
    expect(result.operation).toBe("update");
    expect(mocked.readInventory).toHaveBeenCalledOnce();
    expect(mocked.withSource).toHaveBeenCalledOnce();
  });

  it("rejects a source that does not match the exact installed package", async () => {
    await expect(
      planClawUpdateForGateway({
        agentId: "workflow-operator",
        source: { packageName: "@openclaw/different", version: "1.2.0" },
        config: labsConfig,
      }),
    ).rejects.toMatchObject({ code: "claw_update_source_mismatch" });
    expect(mocked.withSource).not.toHaveBeenCalled();
  });

  it("plans one exact ClawHub release using read-worker inventory and no Gateway SQLite handle", async () => {
    const result = await planClawUpdateForGateway({
      agentId: "workflow-operator",
      source: coordinate,
      config: labsConfig,
      baseUrl: "http://localhost:3000",
    });

    expect(mocked.withSource).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinate,
        mode: "preview",
        baseUrl: "http://localhost:3000",
      }),
    );
    expect(mocked.buildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "workflow-operator",
        targetSource: source.source,
        inventory,
        stateOptions: expect.objectContaining({ readOnly: true }),
      }),
    );
    expect(result).toMatchObject({
      operation: "update",
      target: { agentId: "workflow-operator", targetVersion: "1.2.0" },
      pluginReviews: [],
      blockers: [],
      configuredAccess: { coverage: "configuration-only", current: {}, desired: {} },
      scheduledJobs: { coverage: "package-declarations", jobs: [] },
    });
  });

  it("projects plugin capability review from the exact target Update package plan", async () => {
    mocked.buildUpdate.mockImplementation(async ({ captureGatewayProjection }) => {
      captureGatewayProjection?.(
        { id: "workflow-operator" },
        {
          actions: [
            {
              kind: "package",
              id: "plugin:@openclaw/workflow-operator-plugin",
              blocked: false,
              details: {
                kind: "plugin",
                installId: "workflow-operator-plugin",
                ref: "@openclaw/workflow-operator-plugin",
                version: "1.2.0",
                ownerAction: "install",
                declaredCapabilities: {
                  channels: [],
                  providers: [],
                  tools: ["workflow.run"],
                  contracts: [],
                  hooks: [],
                  mcpServers: [],
                  cliCommands: [],
                  cliBackends: [],
                  skills: [],
                  dangerousConfigFlags: [],
                },
                capabilityGrants: {
                  hooks: {
                    allowPromptInjection: { effective: false },
                    allowConversationAccess: { effective: false },
                  },
                },
              },
            },
          ],
        },
      );
      const plan = makeEmptyClawUpdatePlan({
        agentId: "workflow-operator",
        source: source.source,
        found: true,
        blockers: [],
      });
      plan.actions.push({
        kind: "package",
        id: "plugin:@openclaw/workflow-operator-plugin",
        action: "change",
        target: "plugin",
        blocked: false,
        reason: "Plugin version changes.",
      });
      return plan;
    });

    const result = await planClawUpdateForGateway({
      agentId: "workflow-operator",
      source: coordinate,
      config: labsConfig,
    });
    expect(result.pluginReviews).toMatchObject([
      {
        actionId: "plugin:@openclaw/workflow-operator-plugin",
        pluginId: "workflow-operator-plugin",
        ownerAction: "install",
        declaredCapabilities: { tools: ["workflow.run"] },
        reviewToken: expect.any(String),
      },
    ]);
    expect(result.blockers).toEqual([]);
  });

  it("keeps Remove available with Labs off and refreshes attached jobs after monitor inspection", async () => {
    const firstJobs = [{ id: "job-before" }];
    const nextJobs = [{ id: "job-after" }];
    mocked.readFacts
      .mockResolvedValueOnce({ attachedJobs: firstJobs, sessionStoreOwners: [] })
      .mockResolvedValueOnce({ attachedJobs: nextJobs, sessionStoreOwners: [] });
    mocked.buildRemove.mockImplementation(async (_target, options, readFacts) => {
      expect(options).toMatchObject({ readOnly: true, exactAgentId: true, config: {} });
      expect(readFacts.inventory).toBe(inventory);
      expect(await readFacts.readAttachedCronJobs("workflow-operator")).toBe(firstJobs);
      expect(await readFacts.readAttachedCronJobs("workflow-operator")).toBe(nextJobs);
      return {
        schemaVersion: "openclaw.clawRemovePlan.v1",
        stability: "experimental",
        dryRun: true,
        mutationAllowed: false,
        planIntegrity: "sha256:canonical-remove",
        target: "workflow-operator",
        agentId: "workflow-operator",
        actions: [],
        blockers: [],
      };
    });

    const result = await planClawRemoveForGateway({ agentId: "workflow-operator", config: {} });
    expect(result.operation).toBe("remove");
    expect(mocked.withSource).not.toHaveBeenCalled();
    expect(mocked.readFacts).toHaveBeenCalledTimes(2);
    expect(mocked.readFacts).toHaveBeenNthCalledWith(
      1,
      "workflow-operator",
      [],
      expect.anything(),
      { context: expect.anything(), current: true },
    );
  });

  it("fails closed when agent database ownership cannot be read", async () => {
    mocked.readRegistry.mockResolvedValue({
      result: { status: "unavailable" },
      assertCurrent: mocked.assertRegistryCurrent,
    });
    await expect(
      planClawRemoveForGateway({ agentId: "workflow-operator", config: {} }),
    ).rejects.toMatchObject({ code: "agent_database_registry_unavailable" });
    expect(mocked.readFacts).not.toHaveBeenCalled();
    expect(mocked.buildRemove).not.toHaveBeenCalled();
  });
});
