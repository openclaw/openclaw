import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quiescentClawMonitorGateway } from "../claws/lifecycle-remove.test-support.js";
import { buildClawRemovePlan } from "../claws/lifecycle-state.js";
import { readClawStatus } from "../claws/lifecycle-status.js";
import { applyClawMcpRecovery } from "../claws/mcp-recovery.js";
import {
  digestClawMcpServer,
  readClawMcpServerRefs,
  upsertClawMcpServerRef,
  type PersistedClawMcpServerRef,
} from "../claws/mcp.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { makeProvenancePlan } from "../claws/provenance.test-helpers.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "../config/write-lock.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const output = vi.hoisted(() => {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    runtime: {
      log: (value: unknown) => lines.push(String(value)),
      error: (value: unknown) => errors.push(String(value)),
      writeStdout: (value: string) => lines.push(value),
      writeJson: (value: unknown) => lines.push(JSON.stringify(value)),
      exit: (code: number) => {
        throw new Error(`runtime-exit:${code}`);
      },
    },
  };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: output.runtime,
}));

const { registerClawsCli } = await import("./claws-cli.js");

let state: OpenClawTestState;

beforeEach(async () => {
  output.lines.length = 0;
  output.errors.length = 0;
  state = await createOpenClawTestState({ prefix: "claw-mcp-recover-cli-" });
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  await state.cleanup();
});

function pendingRef(name: string, server: Record<string, unknown>): PersistedClawMcpServerRef {
  return {
    schemaVersion: "openclaw.clawMcpServerRef.v1",
    agentId: "worker",
    name,
    configDigest: digestClawMcpServer(server),
    relationship: "managed",
    origin: "claw-introduced",
    independentOwner: false,
    status: "pending",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

async function invokeCli(args: string[]): Promise<void> {
  output.lines.length = 0;
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("runtime-exit:"))) {
      throw error;
    }
  }
}

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  await invokeCli(args);
  return JSON.parse(output.lines.at(-1) ?? "{}");
}

describe("claws mcp-recover CLI", () => {
  it("previews without writing and completes an exact pending ref with Labs disabled", async () => {
    const server = { command: "fixture-mcp", args: ["serve"] };
    await state.writeConfig({ mcp: { servers: { docs: server } } });
    const sourceBytes = await readFile(state.configPath, "utf8");
    const pending = pendingRef("docs", server);
    upsertClawMcpServerRef(pending, { env: state.env });

    const status = await readClawStatus("worker", {
      env: state.env,
      config: { mcp: { servers: { docs: server } } },
    });
    expect(status.summary.unresolvedMcpServerRefs).toBe(1);
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([pending]);

    const preview = await runCli(["claws", "mcp-recover", "worker", "docs", "--dry-run", "--json"]);
    expect(preview).toMatchObject({
      schemaVersion: "openclaw.clawMcpRecoveryPlan.v1",
      stability: "experimental",
      agentId: "worker",
      name: "docs",
      action: "complete",
      liveConfig: { state: "exact", retained: true },
      planIntegrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([pending]);
    expect(await readFile(state.configPath, "utf8")).toBe(sourceBytes);

    const result = await runCli([
      "claws",
      "mcp-recover",
      "worker",
      "docs",
      "--yes",
      "--plan-integrity",
      String(preview.planIntegrity),
      "--json",
    ]);
    expect(result.status, JSON.stringify(result)).toBe("complete");
    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawMcpRecoveryResult.v1",
      status: "complete",
      action: "complete",
      liveConfigRetained: true,
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([
      expect.objectContaining({
        agentId: pending.agentId,
        name: pending.name,
        configDigest: pending.configDigest,
        status: "complete",
        updatedAtMs: result.updatedAtMs,
      }),
    ]);
    expect(await readFile(state.configPath, "utf8")).toBe(sourceBytes);
  });

  it("releases a pending removal claim after config disappeared, then clears the Remove blocker", async () => {
    const server = { command: "fixture-mcp", args: ["serve"] };
    const { plan: addPlan } = await makeProvenancePlan(
      state.root,
      { schemaVersion: 1, agent: { id: "worker" }, mcpServers: {}, cronJobs: [] },
      { workspace: state.workspaceDir },
    );
    const config = {};
    await state.writeConfig(config);
    const sourceBytes = await readFile(state.configPath, "utf8");
    persistClawInstallRecord(addPlan, { env: state.env, status: "complete" });
    const pending = pendingRef("docs", server);
    upsertClawMcpServerRef(pending, { env: state.env });

    const before = await buildClawRemovePlan("worker", {
      env: state.env,
      config,
      sourceMcpServers: {},
      monitorGateway: quiescentClawMonitorGateway,
    });
    expect(before.blockers).toContainEqual(
      expect.objectContaining({ code: "mcp_cleanup_uncertain" }),
    );

    const preview = await runCli(["claws", "mcp-recover", "worker", "docs", "--dry-run", "--json"]);
    expect(preview).toMatchObject({
      action: "release",
      liveConfig: { state: "missing", retained: true },
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([pending]);
    const result = await runCli([
      "claws",
      "mcp-recover",
      "worker",
      "docs",
      "--yes",
      "--plan-integrity",
      String(preview.planIntegrity),
      "--json",
    ]);
    expect(result).toMatchObject({
      status: "complete",
      action: "release",
      liveConfigRetained: true,
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([]);
    expect(await readFile(state.configPath, "utf8")).toBe(sourceBytes);

    const after = await buildClawRemovePlan("worker", {
      env: state.env,
      config,
      sourceMcpServers: {},
      monitorGateway: quiescentClawMonitorGateway,
    });
    expect(after.blockers).not.toContainEqual(
      expect.objectContaining({ code: "mcp_cleanup_uncertain" }),
    );
  });

  it("blocks recovery when an interrupted Update left the old managed server live", async () => {
    const expected = { command: "next-mcp" };
    const live = { command: "current-mcp" };
    const config = { mcp: { servers: { docs: live } } };
    await state.writeConfig(config);
    const sourceBytes = await readFile(state.configPath, "utf8");
    const { plan: addPlan } = await makeProvenancePlan(
      state.root,
      { schemaVersion: 1, agent: { id: "worker" }, mcpServers: { docs: live }, cronJobs: [] },
      { workspace: state.workspaceDir },
    );
    persistClawInstallRecord(addPlan, { env: state.env, status: "complete" });
    const previous = { ...pendingRef("docs", live), status: "complete" as const };
    upsertClawMcpServerRef(previous, { env: state.env });
    const pending = {
      ...previous,
      configDigest: digestClawMcpServer(expected),
      status: "pending" as const,
      updatedAtMs: 2,
    };
    upsertClawMcpServerRef(pending, { env: state.env });

    await invokeCli(["claws", "mcp-recover", "worker", "docs", "--dry-run"]);
    expect(output.lines).toContain("Recovery action: blocked");
    expect(output.lines).toContain("Live MCP config will be retained unchanged.");
    expect(await readFile(state.configPath, "utf8")).toBe(sourceBytes);

    const preview = await runCli(["claws", "mcp-recover", "worker", "docs", "--dry-run", "--json"]);
    expect(preview).toMatchObject({
      action: "blocked",
      blocker: { code: "mcp_config_modified" },
      liveConfig: { state: "modified", retained: true },
    });
    const result = await runCli([
      "claws",
      "mcp-recover",
      "worker",
      "docs",
      "--yes",
      "--plan-integrity",
      String(preview.planIntegrity),
      "--json",
    ]);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "mcp_config_modified" },
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([pending]);
    expect(await readFile(state.configPath, "utf8")).toBe(sourceBytes);
    const remove = await buildClawRemovePlan("worker", {
      env: state.env,
      config,
      sourceMcpServers: config.mcp.servers,
      monitorGateway: quiescentClawMonitorGateway,
    });
    expect(remove.blockers).toContainEqual(
      expect.objectContaining({ code: "mcp_cleanup_uncertain" }),
    );
  });

  it("holds the source config owner through the MCP recovery commit", async () => {
    const server = { command: "fixture-mcp" };
    await state.writeConfig({ mcp: { servers: { docs: server } } });
    upsertClawMcpServerRef(pendingRef("docs", server), { env: state.env });
    const preview = await runCli(["claws", "mcp-recover", "worker", "docs", "--dry-run", "--json"]);
    let admittedChecks = 0;
    const snapshotRead = createDeferredCore();
    const resumeRecovery = createDeferredCore();
    const assertSourceOwned = () => {
      const guard = captureConfigWriteLockGuard(state.configPath);
      expect(guard).toBeDefined();
      guard?.();
      admittedChecks += 1;
    };
    const recovery = applyClawMcpRecovery("worker", "docs", String(preview.planIntegrity), {
      env: state.env,
      listMcpServers: async () => {
        assertSourceOwned();
        const listed = await listConfiguredMcpServers();
        snapshotRead.resolve();
        await resumeRecovery.promise;
        return listed;
      },
      assertCurrent: assertSourceOwned,
    });
    await Promise.race([
      snapshotRead.promise,
      recovery.then(() => {
        throw new Error("MCP recovery skipped the source config snapshot.");
      }),
    ]);
    const competingWriter = withConfigWriteLock(state.configPath, async () => {
      expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([
        expect.objectContaining({ status: "complete" }),
      ]);
    });
    resumeRecovery.resolve();
    const [result] = await Promise.all([recovery, competingWriter]);
    expect(result.action).toBe("complete");
    expect(admittedChecks).toBeGreaterThan(2);
  });

  it("rejects stale consent when live config or ownership changes after preview", async () => {
    const server = { command: "fixture-mcp" };
    await state.writeConfig({ mcp: { servers: { docs: server } } });
    const pending = pendingRef("docs", server);
    upsertClawMcpServerRef(pending, { env: state.env });
    const preview = await runCli(["claws", "mcp-recover", "worker", "docs", "--dry-run", "--json"]);

    await state.writeConfig({ mcp: { servers: { docs: { command: "changed-mcp" } } } });
    const changedConfig = await runCli([
      "claws",
      "mcp-recover",
      "worker",
      "docs",
      "--yes",
      "--plan-integrity",
      String(preview.planIntegrity),
      "--json",
    ]);
    expect(changedConfig).toMatchObject({
      status: "failed",
      error: { code: "plan_integrity_mismatch" },
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([pending]);

    await state.writeConfig({ mcp: { servers: { docs: server } } });
    const adopted = { ...pending, independentOwner: true, updatedAtMs: 2 };
    upsertClawMcpServerRef(adopted, { env: state.env });
    const changedOwner = await runCli([
      "claws",
      "mcp-recover",
      "worker",
      "docs",
      "--yes",
      "--plan-integrity",
      String(preview.planIntegrity),
      "--json",
    ]);
    expect(changedOwner).toMatchObject({
      status: "failed",
      error: { code: "plan_integrity_mismatch" },
    });
    expect(readClawMcpServerRefs("worker", { env: state.env })).toEqual([adopted]);
  });
});
