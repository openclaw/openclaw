import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  readInventory: vi.fn(),
  readStatus: vi.fn(),
  listMcpServers: vi.fn(),
  clearInstallRecords: vi.fn(),
  loadInstallRecords: vi.fn(),
  assertCurrent: vi.fn(),
}));

vi.mock("./inventory-read.js", () => ({ readClawInventory: mocked.readInventory }));
vi.mock("./lifecycle-status.js", () => ({ readClawStatus: mocked.readStatus }));
vi.mock("../config/mcp-config.js", () => ({ listConfiguredMcpServers: mocked.listMcpServers }));
vi.mock("../plugins/installed-plugin-index-record-reader.js", () => ({
  clearLoadInstalledPluginIndexInstallRecordsCache: mocked.clearInstallRecords,
  loadInstalledPluginIndexInstallRecords: mocked.loadInstallRecords,
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

import { readClawStatusForGateway } from "./gateway-status-worker.js";

const emptyInventory = {
  installs: [],
  packages: [],
  workspaceFiles: [],
  mcpServers: [],
  cronJobs: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocked.readInventory.mockResolvedValue(emptyInventory);
  mocked.readStatus.mockResolvedValue({ records: [] });
});

describe("Gateway Claw status", () => {
  it("uses a read-only inventory and does not inspect SQLite in the shared writer", async () => {
    const config = { agents: { list: [] } };
    await expect(readClawStatusForGateway({ config, target: "my-claw" })).resolves.toEqual({
      schemaVersion: "openclaw.clawsGatewayStatus.v1",
      records: [],
      summary: { claws: 0, healthy: 0, attention: 0, managed: 0, referenced: 0 },
    });

    expect(mocked.readInventory).toHaveBeenCalledWith(
      {
        path: "/tmp/openclaw-state/state/openclaw.sqlite",
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      },
      { context: expect.anything(), current: true },
    );
    expect(mocked.readStatus).toHaveBeenCalledWith(
      "my-claw",
      expect.objectContaining({
        config,
        inventory: emptyInventory,
        sourceMcpServers: {},
        readOnly: true,
      }),
    );
    expect(mocked.listMcpServers).not.toHaveBeenCalled();
    expect(mocked.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("compares MCP refs with authored config rather than substituted runtime values", async () => {
    const inventory = {
      ...emptyInventory,
      mcpServers: [{ agentId: "docs", name: "docs", configDigest: "authored" }],
    };
    const sourceMcpServers = { docs: { env: { DOCS_TOKEN: "${DOCS_TOKEN}" } } };
    mocked.readInventory.mockResolvedValue(inventory);
    mocked.listMcpServers.mockResolvedValue({ ok: true, mcpServers: sourceMcpServers });

    await readClawStatusForGateway({
      config: { mcp: { servers: { docs: { env: { DOCS_TOKEN: "resolved-secret" } } } } },
    });

    expect(mocked.readStatus).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ inventory, sourceMcpServers }),
    );
    expect(mocked.assertCurrent).toHaveBeenCalledTimes(3);
  });

  it("resolves plugins through the cached async install-record owner", async () => {
    mocked.readInventory.mockResolvedValue({
      ...emptyInventory,
      packages: [{ agentId: "docs", kind: "plugin", ref: "@openclaw/lobster" }],
    });
    mocked.loadInstallRecords.mockResolvedValue({
      lobster: { clawhubPackage: "@openclaw/lobster", resolvedVersion: "2026.7.1" },
    });
    mocked.readStatus.mockImplementation(async (_target, options) => {
      const plugin = await options.packageDeps.resolvePlugin({
        clawhubPackage: "@openclaw/lobster",
      });
      expect(plugin).toMatchObject({
        status: "found",
        pluginId: "lobster",
        installedVersion: "2026.7.1",
      });
      return { records: [] };
    });

    await readClawStatusForGateway({ config: {} });

    expect(mocked.loadInstallRecords).toHaveBeenCalledWith({
      filePath: "/tmp/openclaw-state/state/openclaw.sqlite",
      stateDir: "/tmp/openclaw-state",
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      artifactPreservingReadOnly: true,
    });
    expect(mocked.clearInstallRecords).toHaveBeenCalledOnce();
    expect(mocked.clearInstallRecords.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.loadInstallRecords.mock.invocationCallOrder[0]!,
    );
  });

  it("observes plugin index changes written outside this Gateway on the next status read", async () => {
    mocked.readInventory.mockResolvedValue({
      ...emptyInventory,
      packages: [{ agentId: "docs", kind: "plugin", ref: "@openclaw/lobster" }],
    });
    let persistedVersion = "1.0.0";
    let cachedRecords:
      | Record<string, { clawhubPackage: string; resolvedVersion: string }>
      | undefined;
    mocked.clearInstallRecords.mockImplementation(() => {
      cachedRecords = undefined;
    });
    mocked.loadInstallRecords.mockImplementation(async () => {
      cachedRecords ??= {
        lobster: { clawhubPackage: "@openclaw/lobster", resolvedVersion: persistedVersion },
      };
      return cachedRecords;
    });
    const observed: string[] = [];
    mocked.readStatus.mockImplementation(async (_target, options) => {
      const plugin = await options.packageDeps.resolvePlugin({
        clawhubPackage: "@openclaw/lobster",
      });
      observed.push(plugin.status === "found" ? plugin.installedVersion : plugin.status);
      return { records: [] };
    });

    await readClawStatusForGateway({ config: {} });
    persistedVersion = "2.0.0";
    await readClawStatusForGateway({ config: {} });

    expect(observed).toEqual(["1.0.0", "2.0.0"]);
    expect(mocked.clearInstallRecords).toHaveBeenCalledTimes(2);
  });

  it("treats an unavailable live cron inventory as attention, not health", async () => {
    mocked.readStatus.mockResolvedValue({
      records: [
        {
          install: {
            agentId: "worker",
            claw: { kind: "package", name: "@openclaw/worker", version: "1.0.0" },
            status: "complete",
            addedAtMs: 1,
            updatedAtMs: 1,
          },
          agentState: "present",
          bootstrapState: "complete",
          workspaceFiles: [],
          packages: [],
          mcpServers: [],
          cronJobs: [{ manifestId: "daily", status: "complete", schedulerJobId: "job-1" }],
        },
      ],
    });

    const result = await readClawStatusForGateway({
      config: {},
      listCronJobs: async () => {
        throw new Error("scheduler unavailable: secret-token");
      },
    });

    expect(result.summary).toMatchObject({ healthy: 0, attention: 1 });
    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "cron-job", state: "unresolved" })]),
    );
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
