import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import type { OpenClawConfig } from "../config/config.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let gatewaySnapshots: typeof import("../skills/runtime/session-snapshot.js");
let gatewayRefreshState: typeof import("../skills/runtime/refresh-state.js");
let gatewayWorkshop: typeof import("../skills/workshop/service.js");
let registerSkillsCli: (typeof import("./skills-cli.js"))["registerSkillsCli"];

const mocks = vi.hoisted(() => ({
  callGateway:
    vi.fn<
      (request: {
        method: string;
        params?: { proposalId?: string; expectedRevisionHash?: string };
      }) => Promise<unknown>
    >(),
  config: {} as OpenClawConfig,
  resolvedAgentIds: [] as string[],
  acquireGatewayLock: vi.fn(),
  releaseGatewayLock: vi.fn(),
  workspaceDir: "",
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn<(message: string) => void>(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  },
}));

const gatewayWorkshopScope = () => ({ config: mocks.config, agentId: "main" });

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: { gateway?: { mode?: string } } }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));
vi.mock("../infra/gateway-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-lock.js")>();
  mocks.acquireGatewayLock.mockImplementation(async (options) => {
    const lock = await actual.acquireGatewayLock(options);
    if (!lock) {
      return lock;
    }
    return {
      ...lock,
      release: async () => {
        mocks.releaseGatewayLock();
        await lock.release();
      },
    };
  });
  return { ...actual, acquireGatewayLock: mocks.acquireGatewayLock };
});
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
  resetConfigRuntimeState: () => undefined,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveConfiguredAgentId: (_config: unknown, agentId: string) => agentId,
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: (_config: unknown, agentId: string) => {
    mocks.resolvedAgentIds.push(agentId);
    return mocks.workspaceDir;
  },
}));

const inspectProposal = (id: string) =>
  gatewayWorkshop.inspectSkillProposal(id, gatewayWorkshopScope());
async function expectStatus(id: string, status: "pending" | "applied") {
  await expect(inspectProposal(id)).resolves.toMatchObject({ record: { status } });
}
const propose = () =>
  gatewayWorkshop.proposeCreateSkill({
    ...gatewayWorkshopScope(),
    workspaceDir: mocks.workspaceDir,
    name: "Gateway Visible",
    description: "Visible in sessions without restarting the gateway",
    content: "# Gateway Visible\n\nUse the newly applied workflow.\n",
  });
const credentialsError = () =>
  Object.assign(new Error("gateway proposal inspection requires credentials"), {
    name: "GatewayCredentialsRequiredError",
    method: "skills.proposals.inspect",
    configPath: "/tmp/openclaw.json",
  });
async function run(...args: string[]) {
  const program = new Command().enablePositionalOptions();
  program.exitOverride();
  registerSkillsCli(program);
  await program.parseAsync(["skills", "workshop", ...args], { from: "user" });
}

const stdout = () => mocks.defaultRuntime.writeStdout.mock.lastCall?.[0].trimEnd();
async function configureAgentDirectory() {
  const agentDir = await tempDirs.make("skills-cli-agent-");
  mocks.config = { agents: { entries: { main: { default: true, agentDir } } } };
}

describe("skills workshop CLI", () => {
  beforeAll(async () => {
    // Separate module graphs preserve the Gateway/CLI process-cache boundary.
    vi.resetModules();
    gatewaySnapshots = await import("../skills/runtime/session-snapshot.js");
    gatewayRefreshState = await import("../skills/runtime/refresh-state.js");
    gatewayWorkshop = await import("../skills/workshop/service.js");
    vi.resetModules();
    ({ registerSkillsCli } = await import("./skills-cli.js"));
  });
  afterAll(() => vi.resetModules());
  beforeEach(async () => {
    testState = await createOpenClawTestState({ layout: "state-only", prefix: "skills-cache-" });
    mocks.workspaceDir = await tempDirs.make("skills-cache-");
    mocks.config = {};
    mocks.resolvedAgentIds.length = 0;
    vi.clearAllMocks();
    mocks.callGateway.mockReset().mockRejectedValue(
      new GatewayTransportError({
        kind: "closed",
        code: 1006,
        reason: "abnormal closure",
        message: "gateway closed (1006): abnormal closure",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "",
        },
      }),
    );
  });
  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
    vi.unstubAllEnvs();
  });

  it("applies through the gateway process that owns the cached session skill index", async () => {
    const proposal = await propose();
    const snapshotOptions = {
      workspaceDir: mocks.workspaceDir,
      config: mocks.config,
      agentId: "main",
      watch: false,
    };
    const beforeApply = (
      await gatewaySnapshots.resolveReusableWorkspaceSkillSnapshot(snapshotOptions)
    ).snapshot;
    expect(beforeApply.skills.map((skill) => skill.name)).not.toContain("gateway-visible");
    // Persisted sessions omit resolvedSkills; stale cache reuse would hide the new skill.
    const { resolvedSkills: _runtimeOnly, ...persistedSnapshot } = beforeApply;
    const beforeVersion = gatewayRefreshState.getSkillsSnapshotVersion(mocks.workspaceDir);
    mocks.callGateway.mockImplementation(async (request) => {
      if (request.method === "skills.proposals.inspect") {
        return await inspectProposal(proposal.record.id);
      }
      expect(request.method).toBe("skills.proposals.apply");
      return await gatewayWorkshop.applySkillProposal({
        ...gatewayWorkshopScope(),
        workspaceDir: mocks.workspaceDir,
        proposalId: request.params?.proposalId ?? "",
        expectedRevisionHash: request.params?.expectedRevisionHash,
      });
    });
    await run("apply", proposal.record.id);
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "skills.proposals.apply",
        params: {
          agentId: "main",
          proposalId: proposal.record.id,
          expectedRevisionHash: proposal.revisionHash,
        },
        timeoutMs: 1_850_000,
      }),
    );
    expect(gatewayRefreshState.getSkillsSnapshotVersion(mocks.workspaceDir)).toBeGreaterThan(
      beforeVersion,
    );
    const newSession = (
      await gatewaySnapshots.resolveReusableWorkspaceSkillSnapshot({
        ...snapshotOptions,
        existingSnapshot: persistedSnapshot,
      })
    ).snapshot;
    expect(newSession.skills.map((skill) => skill.name)).toContain("gateway-visible");
  });

  it("does not replay a dispatched gateway apply failure in the CLI process", async () => {
    const proposal = await propose();
    mocks.callGateway
      .mockResolvedValueOnce(await inspectProposal(proposal.record.id))
      .mockRejectedValueOnce(new Error("gateway apply failed"));
    await expect(run("apply", proposal.record.id)).rejects.toThrow("__exit__:1");
    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "skills.proposals.inspect",
      "skills.proposals.apply",
    ]);
    await expectStatus(proposal.record.id, "pending");
  });

  it("preserves configless offline apply after missing credentials", async () => {
    const proposal = await propose();
    mocks.callGateway.mockRejectedValueOnce(credentialsError());
    await run("apply", proposal.record.id);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.acquireGatewayLock).toHaveBeenCalledWith({
      allowInTests: true,
      port: 18789,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
    expect(mocks.releaseGatewayLock).toHaveBeenCalledOnce();
    await expectStatus(proposal.record.id, "applied");
  });

  it("does not bypass Gateway ownership after a dispatched inspection times out", async () => {
    const proposal = await propose();
    const error = new GatewayProtocolRequestTimeoutError({
      method: "skills.proposals.inspect",
      timeoutMs: 1_500,
      requestSent: true,
    });
    mocks.callGateway.mockRejectedValueOnce(error);
    await expect(run("apply", proposal.record.id)).rejects.toThrow("__exit__:1");
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(error.message);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
    await expectStatus(proposal.record.id, "pending");
  });

  it("does not bypass Gateway ownership when CLI credentials are missing", async () => {
    const proposal = await propose();
    const error = credentialsError();
    mocks.callGateway.mockRejectedValueOnce(error);
    mocks.acquireGatewayLock.mockRejectedValueOnce(new Error("gateway lock is owned"));
    await expect(run("apply", proposal.record.id)).rejects.toBe(error);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.acquireGatewayLock).toHaveBeenCalledOnce();
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
    await expectStatus(proposal.record.id, "pending");
  });

  it("does not apply locally after an explicitly configured remote Gateway fails", async () => {
    const proposal = await propose();
    mocks.config.gateway = { mode: "remote" };
    const error = credentialsError();
    mocks.callGateway.mockRejectedValueOnce(error);
    await expect(run("apply", proposal.record.id)).rejects.toBe(error);
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
    await expectStatus(proposal.record.id, "pending");
  });

  it("evaluates the exact inspected draft through the gateway plugin registry", async () => {
    mocks.callGateway
      .mockResolvedValueOnce({
        record: { id: "proposal-evaluate", draftHash: "a".repeat(64) },
        revisionHash: "b".repeat(64),
        content: "# Evaluate\n",
      })
      .mockResolvedValueOnce({
        record: { id: "proposal-evaluate" },
        evaluation: {
          proposedVersion: "0.2.0",
          revisionHash: "b".repeat(64),
          outcomes: [
            {
              evaluatorId: "skill-spector",
              pluginId: "nvidia-evals",
              pluginVersion: "1.2.3",
              status: "completed",
              result: { decision: "revise", summary: "Tighten the trigger." },
            },
          ],
        },
      });
    await run("evaluate", "proposal-evaluate", "--correlation-id", "optimizer-run-7");
    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "skills.proposals.inspect",
      "skills.proposals.evaluate",
    ]);
    expect(mocks.callGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "skills.proposals.evaluate",
        params: {
          agentId: "main",
          proposalId: "proposal-evaluate",
          expectedRevisionHash: "b".repeat(64),
          correlationId: "optimizer-run-7",
        },
        timeoutMs: 650_000,
      }),
    );
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining(
        "skill-spector (nvidia-evals@1.2.3)  completed revise: Tighten the trigger.",
      ),
    );
  });

  it("renders workshop parent help successfully without creating workshop state", async () => {
    const helpOutput: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => helpOutput.push(value),
      writeOut: (value) => helpOutput.push(value),
    });
    registerSkillsCli(program);

    const originalExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await program.parseAsync(["skills", "workshop"], { from: "user" });

      expect(process.exitCode).toBe(0);
      expect(helpOutput.join("")).toContain("Manage pending skill proposals");
      expect(helpOutput.join("")).toContain("propose-create");
      expect(mocks.defaultRuntime.writeStdout).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
      await expect(fs.access(path.join(testState.stateDir, "skill-workshop"))).rejects.toThrow();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("gives the leaf --agent precedence when listing proposals", async () => {
    await run("--agent", "parent-agent", "list", "--agent", "leaf-agent");
    expect(mocks.resolvedAgentIds.at(-1)).toBe("leaf-agent");
  });

  it("uses the leaf --agent when inspecting a proposal", async () => {
    await expect(
      run("--agent", "parent-agent", "inspect", "missing-proposal", "--agent", "leaf-agent"),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.resolvedAgentIds.at(-1)).toBe("leaf-agent");
  });

  it("creates, lists, inspects, and applies a skill proposal in the configured agent directory", async () => {
    await configureAgentDirectory();
    const draftPath = path.join(mocks.workspaceDir, "proposal-draft");
    await fs.mkdir(path.join(draftPath, "references"), { recursive: true });
    await fs.writeFile(
      path.join(draftPath, "PROPOSAL.md"),
      "# Paris Weather\n\nCheck current weather before advice.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(draftPath, "references", "weather.md"),
      "Use current conditions before recommendations.\n",
      "utf8",
    );

    await run(
      "propose-create",
      "--name",
      "Paris Weather",
      "--description",
      "Weather lookup workflow",
      "--proposal-dir",
      draftPath,
    );

    const proposalId = stdout();
    expect(proposalId).toMatch(/^paris-weather-/);

    await run("list");
    expect(stdout()).toContain(`${proposalId}  pending  create`);

    await run("inspect", proposalId!);
    expect(stdout()).toContain("status: proposal");
    expect(stdout()).toContain("--- references/weather.md ---");
    expect(stdout()).toContain("Use current conditions before recommendations.");

    const revisedPath = path.join(mocks.workspaceDir, "revised-proposal.md");
    await fs.writeFile(
      revisedPath,
      "# Paris Weather\n\nCheck current weather and alerts before advice.\n",
      "utf8",
    );
    await run(
      "revise",
      proposalId!,
      "--description",
      "Revised weather lookup workflow",
      "--proposal",
      revisedPath,
    );
    expect(stdout()).toContain(`Revised ${proposalId} v2`);

    await run("apply", proposalId!);
    expect(stdout()).toContain("Applied");
    const skillDir = path.join(
      resolveWorkshopSkillsDir(mocks.config, "main", testState.env),
      "paris-weather",
    );
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "Check current weather and alerts",
    );
    await expect(
      fs.readFile(path.join(skillDir, "references", "weather.md"), "utf8"),
    ).resolves.toContain("Use current conditions");
  });

  it("rejects a proposal from the configured agent directory", async () => {
    await configureAgentDirectory();
    const draftPath = path.join(mocks.workspaceDir, "reject.md");
    await fs.writeFile(draftPath, "# Rejected Skill\n", "utf8");
    await run(
      "propose-create",
      "--name",
      "Rejected Skill",
      "--description",
      "Reject this draft",
      "--proposal",
      draftPath,
    );
    const proposalId = stdout()!;
    await run("inspect", proposalId);
    expect(stdout()).not.toContain("Support files:");
    await run("reject", proposalId);
    expect(stdout()).toContain(`Rejected ${proposalId}`);
  });
});
