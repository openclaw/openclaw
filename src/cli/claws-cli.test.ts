import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cliTestHelpers from "./claws-cli.test-helpers.js";

const enabledClawsLabsConfig = { gateway: { controlUi: { experimental: { claws: true } } } };

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    logs,
    errors,
    runtime,
    loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
    readCurrentConfigForPolicyCheck: vi.fn(),
    listConfiguredMcpServers: vi.fn(),
    applyClawAddPlanStateless: vi.fn(),
    withOpenClawStateLease: vi.fn(),
    leaseAssertOwned: vi.fn(),
    preflightClawPackage: vi.fn(),
    callGatewayFromCli: vi.fn(),
    sleep: vi.fn(),
  };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/io.js", async () => ({
  ...(await vi.importActual<typeof import("../config/io.js")>("../config/io.js")),
  readCurrentConfigForPolicyCheck: mocks.readCurrentConfigForPolicyCheck,
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

vi.mock("../claws/packages.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/packages.js")>("../claws/packages.js")),
  preflightClawPackage: mocks.preflightClawPackage,
}));

vi.mock("../state/openclaw-state-lease.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-lease.js")>(
    "../state/openclaw-state-lease.js",
  )),
  withOpenClawStateLease: mocks.withOpenClawStateLease,
}));

vi.mock("../claws/add-stateless.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/add-stateless.js")>(
    "../claws/add-stateless.js",
  )),
  applyClawAddPlanStateless: mocks.applyClawAddPlanStateless,
}));

// mock-isolation: CLI unit tests bypass live Gateway ownership probes; the owner guard has its own test.
vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({ runLocal }: { runLocal: () => Promise<void> }) =>
    await runLocal(),
}));
vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGatewayFromCli,
}));
vi.mock("../utils/sleep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/sleep.js")>()),
  sleep: mocks.sleep,
}));

const { registerClawsCli } = await import("./claws-cli.js");
const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeManifest(value: unknown = cliTestHelpers.minimalManifest): Promise<string> {
  return await cliTestHelpers.writeManifestFile(tempDirs, value);
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

async function addWithAgentReadiness(beforeWait?: () => void) {
  const manifestPath = await writeManifest({
    ...cliTestHelpers.minimalManifest,
    agent: { id: "worker" },
  });
  const apply = mocks.applyClawAddPlanStateless.getMockImplementation();
  if (!apply) {
    throw new Error("Missing Add fixture implementation");
  }
  mocks.applyClawAddPlanStateless.mockImplementationOnce(async (plan, options) => {
    beforeWait?.();
    await options.cronGateway.waitUntilAgentAvailable(plan.agent.finalId);
    return apply(plan, options);
  });
  await runCli(["claws", "add", manifestPath, "--json"]);
}

describe("claws cli", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue(enabledClawsLabsConfig);
    mocks.readCurrentConfigForPolicyCheck.mockReset();
    mocks.readCurrentConfigForPolicyCheck.mockReturnValue(enabledClawsLabsConfig);
    mocks.listConfiguredMcpServers.mockReset();
    mocks.listConfiguredMcpServers.mockResolvedValue({
      ok: true,
      path: "config",
      config: {},
      mcpServers: {},
    });
    mocks.callGatewayFromCli.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    mocks.preflightClawPackage.mockReset();
    mocks.preflightClawPackage.mockResolvedValue({
      ok: false,
      code: "package_install_unavailable",
      message: "Package preflight is unavailable.",
    });
    mocks.applyClawAddPlanStateless.mockReset();
    mocks.applyClawAddPlanStateless.mockImplementation(async (plan) => ({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      workspaceFiles: [],
      packages: [],
      mcpServers: [],
      cronJobs: [],
    }));
    mocks.leaseAssertOwned.mockReset();
    mocks.withOpenClawStateLease.mockReset();
    mocks.withOpenClawStateLease.mockImplementation(
      async (_options, run) => await run({ assertOwned: mocks.leaseAssertOwned }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers without the process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const program = new Command();

    registerClawsCli(program);

    expect(program.commands.map((command) => command.name())).toContain("claws");
  });

  it("exposes only authoring, inspection, and Add commands", () => {
    const program = new Command();
    registerClawsCli(program);

    expect(
      program.commands
        .find((command) => command.name() === "claws")
        ?.commands.map((command) => command.name()),
    ).toEqual(["create", "validate", "dev", "build", "inspect", "add"]);
  });

  it("blocks local Add while Claws Labs is off", async () => {
    mocks.loadConfig.mockReturnValue({});
    const manifestPath = await writeManifest();
    await runCli(["claws", "add", manifestPath, "--dry-run", "--json"]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "claws_labs_disabled" },
    });
    expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
  });

  it("prints versioned experimental JSON for a development manifest", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: { schemaVersion: 1, agent: { id: "demo-agent" } },
    });
  });

  it("takes identity from package.json and plans one new agent", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    const expectedWorkspace = await cliTestHelpers.canonicalFuturePath(workspace);

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      stability: "experimental",
      claw: { kind: "package", name: "@acme/demo-agent", version: "1.2.3" },
      agent: { finalId: "demo-agent", workspace: expectedWorkspace },
      summary: { agentActions: 1, workspaceActions: 2, packageActions: 1, blockedActions: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("redacts credential-bearing remote MCP URLs in add previews", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      mcpServers: {
        remote: {
          url: "https://example.com/mcp?token=abc123&mode=ok",
          transport: "streamable-http",
        },
      },
    });
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");

    await runClawsAddCommand(manifestPath, { dryRun: true, workspace });

    const output = mocks.logs.join("\n");
    expect(output).not.toMatch(/^Experimental:/m);
    expect(output).toContain("MCP remote:");
    expect(output).toContain("example.com");
    expect(output).not.toContain("abc123");
    expect(output).toContain("token=***");
  });

  it("honors an explicit unused agent id in the plan", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.loadConfig.mockReturnValue({
      ...enabledClawsLabsConfig,
      agents: { entries: { "demo-agent": {} } },
    });

    await runCli([
      "claws",
      "add",
      root,
      "--dry-run",
      "--agent-id",
      "demo-agent-two",
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}").agent).toMatchObject({
      requestedId: "demo-agent",
      finalId: "demo-agent-two",
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("discloses capability escalations in the human dry-run", async () => {
    const root = tempDirs.make("openclaw-claws-cli-profile-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    allow: [read]\n",
      "utf8",
    );
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        mcpServers: {
          docs: {
            command: "node",
            env: { API_TOKEN: "${GITHUB_TOKEN}" },
            toolFilter: { include: ["search_*"] },
          },
        },
      }),
      "utf8",
    );

    await runCli(["claws", "add", path, "--dry-run"]);

    expect(mocks.logs).toContain("Capability escalations (2):");
    expect(mocks.logs.some((line) => line.startsWith("  ! agent:demo-agent"))).toBe(true);
    expect(mocks.logs.some((line) => line.startsWith("  ! mcpServer:docs"))).toBe(true);
    expect(mocks.logs.some((line) => line.includes('"env":["API_TOKEN"]'))).toBe(true);
  });

  it("adds a minimal Claw directly with an internal plan binding", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "add", manifestPath, "--json"]);

    expect(mocks.errors).toEqual([]);
    expect(mocks.applyClawAddPlanStateless).toHaveBeenCalledOnce();
    const [plan, options] = mocks.applyClawAddPlanStateless.mock.calls[0]!;
    expect(options.consentPlanIntegrity).toBe(plan.planIntegrity);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "complete",
      agent: { finalId: "demo-agent" },
    });
  });

  it("does not Add when Labs was switched off after planning", async () => {
    const manifestPath = await writeManifest();
    mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});

    await runCli(["claws", "add", manifestPath, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "failed",
      error: { code: "claws_labs_disabled" },
    });
    expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
  });

  it("stops Add effects when Labs turns off after apply begins", async () => {
    const manifestPath = await writeManifest();
    const commitEffect = vi.fn();
    mocks.applyClawAddPlanStateless.mockImplementationOnce(async (_plan, options) => {
      await Promise.resolve();
      mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});
      options.assertForwardCurrent?.();
      commitEffect();
    });

    await runCli(["claws", "add", manifestPath, "--json"]);

    expect(commitEffect).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}").error.code).toBe("claws_labs_disabled");
  });

  it("requires explicit acknowledgement of a warned skill", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const warning = "This community skill requires review before installation.";
    const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mocks.preflightClawPackage.mockResolvedValue({
      ok: true,
      action: "install",
      integrity,
      warning,
    });

    await runCli(["claws", "add", root, "--json"]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "clawhub_risk_acknowledgement_required" },
      warnings: [expect.objectContaining({ warning })],
    });
    expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
    mocks.logs.length = 0;

    await runCli(["claws", "add", root, "--acknowledge-clawhub-risk", "--json"]);
    expect(mocks.applyClawAddPlanStateless).toHaveBeenCalledOnce();
    const consent = mocks.applyClawAddPlanStateless.mock.calls[0]?.[1]?.skillConsent;
    expect(consent).toBeDefined();
    expect(() =>
      consent.assertApproved({
        ref: "@acme/demo-skill",
        version: "1.0.0",
        integrity,
        riskWarning: warning,
      }),
    ).not.toThrow();
    expect(() =>
      consent.assertApproved({
        ref: "@acme/demo-skill",
        version: "1.0.0",
        integrity,
        riskWarning: "changed",
      }),
    ).toThrow(/review.*again/i);
  });

  it("does not apply Add before owning the target agent lease", async () => {
    const manifestPath = await writeManifest();
    let releaseLease!: () => void;
    const heldLease = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    mocks.withOpenClawStateLease.mockImplementationOnce(async (_options, run) => {
      await heldLease;
      return await run({ assertOwned: mocks.leaseAssertOwned });
    });
    const pending = runCli(["claws", "add", manifestPath, "--json"]);
    try {
      await vi.waitFor(() => expect(mocks.withOpenClawStateLease).toHaveBeenCalledOnce());
      expect(mocks.withOpenClawStateLease).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "core:agent-deletion", key: "demo-agent" }),
        expect.any(Function),
      );
      expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
    } finally {
      releaseLease();
      await pending;
    }
    const [, options] = mocks.applyClawAddPlanStateless.mock.calls[0]!;
    options.assertCurrent();
    expect(mocks.leaseAssertOwned).toHaveBeenCalledOnce();
  });

  it("accepts an already-applied Gateway config revision", async () => {
    mocks.callGatewayFromCli.mockResolvedValue({
      config: { agents: { entries: { worker: {} } } },
      configRevisionHash: "revision-new",
      appliedConfigHash: "revision-new",
    });

    await addWithAgentReadiness();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({ status: "complete" });

    expect(mocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("config.get", { timeout: "5000" }, {});
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("waits for the requested agent in an applied revision after a cached response", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        config: { agents: { entries: { other: {} } } },
        configRevisionHash: "revision-old",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      });

    await addWithAgentReadiness();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({ status: "complete" });

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(3);
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).toHaveBeenCalledWith(100);
  });

  it("reports the last Gateway error after the reload deadline", async () => {
    mocks.callGatewayFromCli.mockRejectedValue(new Error("gateway unavailable"));

    await addWithAgentReadiness(() => {
      vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15_000);
    });
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "failed",
      error: {
        code: "add_failed",
        message: "Gateway did not apply the Claw agent configuration in time: gateway unavailable",
      },
    });

    expect(mocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(mocks.sleep).toHaveBeenCalledOnce();
  });
});
