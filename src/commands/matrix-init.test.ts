import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

// Hoisted mocks must be defined before vi.mock calls
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const requireValidConfigMock = vi.hoisted(() => vi.fn());
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveWorkspaceTemplateDirMock = vi.hoisted(() => vi.fn());
const callGatewayCliMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: requireValidConfigMock,
  createQuietRuntime: vi.fn((r: unknown) => r),
}));

vi.mock("./onboard-helpers.js", () => ({
  ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
}));

vi.mock("../agents/workspace-templates.js", () => ({
  resolveWorkspaceTemplateDir: resolveWorkspaceTemplateDirMock,
}));

vi.mock("../gateway/call.js", () => ({
  callGatewayCli: callGatewayCliMock,
}));

import { matrixInitCommand } from "./matrix-init.js";

const runtime = createTestRuntime();

// Point template dir to the real templates in the repo
const TEMPLATE_DIR = path.resolve(import.meta.dirname, "../../docs/reference/templates");

describe("matrix init command", () => {
  beforeEach(() => {
    writeConfigFileMock.mockClear();
    requireValidConfigMock.mockClear();
    ensureWorkspaceAndSessionsMock.mockClear();
    resolveWorkspaceTemplateDirMock.mockClear();
    callGatewayCliMock.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();

    resolveWorkspaceTemplateDirMock.mockResolvedValue(TEMPLATE_DIR);
  });

  it("exits if config is invalid", async () => {
    requireValidConfigMock.mockResolvedValue(null);

    await matrixInitCommand({}, runtime);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(ensureWorkspaceAndSessionsMock).not.toHaveBeenCalled();
  });

  it("creates all agents from template", async () => {
    requireValidConfigMock.mockResolvedValue({});

    await matrixInitCommand({}, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = writeConfigFileMock.mock.calls[0][0];
    const list = writtenConfig.agents?.list ?? [];
    expect(list).toHaveLength(34);

    const ids = list.map((a: { id: string }) => a.id);
    // Tier 0/1: Operator1 + department heads
    expect(ids).toContain("main");
    expect(ids).toContain("neo");
    expect(ids).toContain("morpheus");
    expect(ids).toContain("trinity");
    // Engineering tier-3
    expect(ids).toContain("tank");
    expect(ids).toContain("dozer");
    expect(ids).toContain("mouse");
    expect(ids).toContain("spark");
    expect(ids).toContain("cipher");
    expect(ids).toContain("relay");
    expect(ids).toContain("ghost");
    expect(ids).toContain("binary");
    expect(ids).toContain("kernel");
    expect(ids).toContain("prism");
    // Marketing tier-3
    expect(ids).toContain("niobe");
    expect(ids).toContain("switch");
    expect(ids).toContain("rex");
    expect(ids).toContain("ink");
    expect(ids).toContain("vibe");
    expect(ids).toContain("lens");
    expect(ids).toContain("echo");
    expect(ids).toContain("nova");
    expect(ids).toContain("pulse");
    expect(ids).toContain("blaze");
    // Finance tier-3
    expect(ids).toContain("oracle");
    expect(ids).toContain("seraph");
    expect(ids).toContain("zee");
    expect(ids).toContain("ledger");
    expect(ids).toContain("vault");
    expect(ids).toContain("shield");
    expect(ids).toContain("trace");
    expect(ids).toContain("quota");
    expect(ids).toContain("merit");
    expect(ids).toContain("beacon");
  });

  it("sets correct identity, role, and department on agents", async () => {
    requireValidConfigMock.mockResolvedValue({});

    await matrixInitCommand({}, runtime);

    const writtenConfig = writeConfigFileMock.mock.calls[0][0];
    const list = writtenConfig.agents?.list ?? [];

    const neo = list.find((a: { id: string }) => a.id === "neo");
    expect(neo).toBeDefined();
    expect(neo.role).toBe("CTO");
    expect(neo.department).toBe("engineering");
    expect(neo.identity?.name).toBe("Neo");

    const morpheus = list.find((a: { id: string }) => a.id === "morpheus");
    expect(morpheus).toBeDefined();
    expect(morpheus.role).toBe("CMO");
    expect(morpheus.department).toBe("marketing");

    const trinity = list.find((a: { id: string }) => a.id === "trinity");
    expect(trinity).toBeDefined();
    expect(trinity.role).toBe("CFO");
    expect(trinity.department).toBe("finance");
  });

  it("sets subagent allowlists correctly", async () => {
    requireValidConfigMock.mockResolvedValue({});

    await matrixInitCommand({}, runtime);

    const writtenConfig = writeConfigFileMock.mock.calls[0][0];
    const list = writtenConfig.agents?.list ?? [];

    const main = list.find((a: { id: string }) => a.id === "main");
    // Operator1 can spawn department heads + all 30 tier-3 agents
    expect(main?.subagents?.allowAgents).toEqual(
      expect.arrayContaining(["neo", "morpheus", "trinity", "tank", "spark", "ink", "ledger"]),
    );

    const neo = list.find((a: { id: string }) => a.id === "neo");
    // Department heads share the full 30-agent pool
    expect(neo?.subagents?.allowAgents).toEqual(
      expect.arrayContaining(["tank", "dozer", "mouse", "spark", "cipher", "ink", "oracle"]),
    );
  });

  it("applies matrix defaults (maxSpawnDepth, maxConcurrent) without overwriting user model", async () => {
    requireValidConfigMock.mockResolvedValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5-20250514" },
        },
      },
    });

    await matrixInitCommand({}, runtime);

    const writtenConfig = writeConfigFileMock.mock.calls[0][0];
    const defaults = writtenConfig.agents?.defaults;
    expect(defaults?.subagents?.maxSpawnDepth).toBe(4);
    expect(defaults?.subagents?.maxConcurrent).toBe(12);
    // User's model must NOT be overwritten by template
    expect(defaults?.model?.primary).toBe("anthropic/claude-sonnet-4-5-20250514");
  });

  it("skips existing agents without overwriting", async () => {
    requireValidConfigMock.mockResolvedValue({
      agents: {
        list: [
          {
            id: "neo",
            name: "CustomNeo",
            workspace: "/custom/workspace",
            model: "custom-model",
          },
        ],
      },
    });

    await matrixInitCommand({}, runtime);

    const writtenConfig = writeConfigFileMock.mock.calls[0][0];
    const list = writtenConfig.agents?.list ?? [];

    // Neo should exist but other agents should be added
    expect(list.length).toBe(34);

    const neo = list.find((a: { id: string }) => a.id === "neo");
    // Neo's core fields (name, workspace, model) should NOT be overwritten
    expect(neo.name).toBe("CustomNeo");
    expect(neo.workspace).toBe("/custom/workspace");
    expect(neo.model).toBe("custom-model");
    // But enrichment fields should be set
    expect(neo.role).toBe("CTO");
    expect(neo.department).toBe("engineering");
  });

  it("ensures workspaces for agents with workspace paths", async () => {
    requireValidConfigMock.mockResolvedValue({});

    await matrixInitCommand({}, runtime);

    // Agents with explicit workspace paths get workspace setup
    // (ephemeral agents without workspace are skipped)
    const workspaceAgentCount = ensureWorkspaceAndSessionsMock.mock.calls.length;
    expect(workspaceAgentCount).toBeGreaterThanOrEqual(12);

    // Check that neo's workspace is set up with the right agentId
    const calls = ensureWorkspaceAndSessionsMock.mock.calls;
    const neoCalls = calls.filter(
      (c: unknown[]) => (c[2] as { agentId?: string })?.agentId === "neo",
    );
    expect(neoCalls).toHaveLength(1);
  });

  it("is idempotent — running twice produces no duplicates", async () => {
    // First run: empty config
    requireValidConfigMock.mockResolvedValue({});
    await matrixInitCommand({}, runtime);

    const firstConfig = writeConfigFileMock.mock.calls[0][0];

    // Second run: pass the written config back
    writeConfigFileMock.mockClear();
    requireValidConfigMock.mockResolvedValue(firstConfig);
    await matrixInitCommand({}, runtime);

    const secondConfig = writeConfigFileMock.mock.calls[0][0];
    const list = secondConfig.agents?.list ?? [];

    // Should still be 34 agents, no duplicates
    expect(list).toHaveLength(34);
    const ids = list.map((a: { id: string }) => a.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(34);
  });

  it("outputs JSON summary when --json is set", async () => {
    requireValidConfigMock.mockResolvedValue({});

    await matrixInitCommand({ json: true }, runtime);

    // Should have a single JSON log call with the summary
    const jsonCalls = runtime.log.mock.calls.filter((c: unknown[]) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCalls.length).toBeGreaterThan(0);

    const parsed = JSON.parse(String(jsonCalls[0][0]));
    expect(parsed.agents).toHaveLength(34);
    expect(parsed.added).toHaveLength(34);
    expect(parsed.skipped).toHaveLength(0);
  });

  it("reports skipped agents in JSON output", async () => {
    requireValidConfigMock.mockResolvedValue({
      agents: {
        list: [{ id: "neo", name: "Neo" }],
      },
    });

    await matrixInitCommand({ json: true }, runtime);

    const jsonCalls = runtime.log.mock.calls.filter((c: unknown[]) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    const parsed = JSON.parse(String(jsonCalls[0][0]));
    expect(parsed.skipped).toContain("neo");
    expect(parsed.added).not.toContain("neo");
    expect(parsed.added).toHaveLength(33);
  });

  describe("--with-cron", () => {
    it("does not call gateway when --with-cron is absent", async () => {
      requireValidConfigMock.mockResolvedValue({});

      await matrixInitCommand({}, runtime);

      expect(callGatewayCliMock).not.toHaveBeenCalled();
    });

    it("creates 6 cron jobs (3 maintenance + 3 sync) when --with-cron is set", async () => {
      requireValidConfigMock.mockResolvedValue({});
      // cron.list returns empty list
      callGatewayCliMock.mockImplementation(async (opts: { method: string }) => {
        if (opts.method === "cron.list") {
          return { jobs: [] };
        }
        // cron.add returns success
        return { id: "mock-id" };
      });

      await matrixInitCommand({ withCron: true, json: true }, runtime);

      // 1 cron.list + 6 cron.add = 7 calls
      expect(callGatewayCliMock).toHaveBeenCalledTimes(7);

      const addCalls = callGatewayCliMock.mock.calls.filter(
        (c: Array<{ method: string }>) => c[0].method === "cron.add",
      );
      expect(addCalls).toHaveLength(6);

      // Verify job names
      const jobNames = addCalls.map((c: Array<{ params: { name: string } }>) => c[0].params.name);
      expect(jobNames).toContain("matrix:maintenance:neo");
      expect(jobNames).toContain("matrix:maintenance:morpheus");
      expect(jobNames).toContain("matrix:maintenance:trinity");
      expect(jobNames).toContain("matrix:sync:neo");
      expect(jobNames).toContain("matrix:sync:morpheus");
      expect(jobNames).toContain("matrix:sync:trinity");

      // Verify JSON output includes cron results
      const jsonCalls = runtime.log.mock.calls.filter((c: unknown[]) => {
        try {
          JSON.parse(String(c[0]));
          return true;
        } catch {
          return false;
        }
      });
      const parsed = JSON.parse(String(jsonCalls[0][0]));
      expect(parsed.cron).toBeDefined();
      expect(parsed.cron.maintenance).toBe(3);
      expect(parsed.cron.sync).toBe(3);
      expect(parsed.cron.skipped).toBe(0);
    });

    it("skips existing cron jobs (idempotent)", async () => {
      requireValidConfigMock.mockResolvedValue({});
      // cron.list returns all 6 jobs already existing
      callGatewayCliMock.mockImplementation(async (opts: { method: string }) => {
        if (opts.method === "cron.list") {
          return {
            jobs: [
              { name: "matrix:maintenance:neo" },
              { name: "matrix:maintenance:morpheus" },
              { name: "matrix:maintenance:trinity" },
              { name: "matrix:sync:neo" },
              { name: "matrix:sync:morpheus" },
              { name: "matrix:sync:trinity" },
            ],
          };
        }
        return { id: "mock-id" };
      });

      await matrixInitCommand({ withCron: true, json: true }, runtime);

      // Only 1 cron.list call, no cron.add calls
      expect(callGatewayCliMock).toHaveBeenCalledTimes(1);
      expect(callGatewayCliMock.mock.calls[0][0].method).toBe("cron.list");

      const jsonCalls = runtime.log.mock.calls.filter((c: unknown[]) => {
        try {
          JSON.parse(String(c[0]));
          return true;
        } catch {
          return false;
        }
      });
      const parsed = JSON.parse(String(jsonCalls[0][0]));
      expect(parsed.cron.maintenance).toBe(0);
      expect(parsed.cron.sync).toBe(0);
      expect(parsed.cron.skipped).toBe(6);
    });

    it("handles gateway unreachable gracefully", async () => {
      requireValidConfigMock.mockResolvedValue({});
      callGatewayCliMock.mockRejectedValue(new Error("Connection refused"));

      await matrixInitCommand({ withCron: true, json: true }, runtime);

      // Agents should still be configured despite cron failure
      expect(writeConfigFileMock).toHaveBeenCalledTimes(1);

      const jsonCalls = runtime.log.mock.calls.filter((c: unknown[]) => {
        try {
          JSON.parse(String(c[0]));
          return true;
        } catch {
          return false;
        }
      });
      const parsed = JSON.parse(String(jsonCalls[0][0]));
      expect(parsed.agents).toHaveLength(34);
      expect(parsed.cron).toBeDefined();
      expect(parsed.cron.error).toContain("Connection refused");
      expect(parsed.cron.maintenance).toBe(0);
      expect(parsed.cron.sync).toBe(0);
    });

    it("includes cron schedule and payload details in add calls", async () => {
      requireValidConfigMock.mockResolvedValue({});
      callGatewayCliMock.mockImplementation(async (opts: { method: string }) => {
        if (opts.method === "cron.list") {
          return { jobs: [] };
        }
        return { id: "mock-id" };
      });

      await matrixInitCommand({ withCron: true }, runtime);

      // eslint-disable-next-line -- mock call args are untyped
      const addCalls = callGatewayCliMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as { method: string }).method === "cron.add",
      );

      // Check a maintenance cron
      const neoMaintenance = addCalls.find(
        (c: unknown[]) =>
          (c[0] as { params: { name: string } }).params.name === "matrix:maintenance:neo",
      ) as unknown[] | undefined;
      expect(neoMaintenance).toBeDefined();
      const maintenanceParams = (neoMaintenance![0] as { params: Record<string, unknown> }).params;
      expect(maintenanceParams.agentId).toBe("neo");
      expect(maintenanceParams.schedule).toEqual({ kind: "cron", expr: "0 2 * * *", tz: "UTC" });
      expect(maintenanceParams.sessionTarget).toBe("isolated");
      expect(maintenanceParams.wakeMode).toBe("now");
      expect((maintenanceParams.payload as { kind: string }).kind).toBe("agentTurn");
      expect(maintenanceParams.enabled).toBe(true);

      // Check a sync cron
      const trinitySync = addCalls.find(
        (c: unknown[]) =>
          (c[0] as { params: { name: string } }).params.name === "matrix:sync:trinity",
      ) as unknown[] | undefined;
      expect(trinitySync).toBeDefined();
      const syncParams = (trinitySync![0] as { params: Record<string, unknown> }).params;
      expect(syncParams.agentId).toBe("trinity");
      expect(syncParams.schedule).toEqual({ kind: "cron", expr: "0 3 * * *", tz: "UTC" });
      expect(syncParams.sessionTarget).toBe("isolated");
    });
  });
});
