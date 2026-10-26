import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as cliTestHelpers from "./claws-cli.test-helpers.js";

const enabledClawsLabsConfig = { gateway: { controlUi: { experimental: { claws: true } } } };

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  },
  loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
  readCurrentConfigForPolicyCheck: vi.fn(),
  listConfiguredMcpServers: vi.fn(),
  applyClawAddPlanStateless: vi.fn(),
  withOpenClawStateLease: vi.fn(),
  leaseAssertOwned: vi.fn(),
  preflightClawPackage: vi.fn(),
  callGatewayFromCli: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  readCurrentConfigForPolicyCheck: mocks.readCurrentConfigForPolicyCheck,
}));

vi.mock("../config/mcp-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/mcp-config.js")>()),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

vi.mock("../claws/packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claws/packages.js")>()),
  preflightClawPackage: mocks.preflightClawPackage,
}));

vi.mock("../state/openclaw-state-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-lease.js")>()),
  withOpenClawStateLease: mocks.withOpenClawStateLease,
}));

vi.mock("../claws/add-stateless.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claws/add-stateless.js")>()),
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

async function add(args: string[] = [], source?: string) {
  await runCli(["claws", "add", source ?? (await writeManifest()), ...args]);
  return args.includes("--json") ? output() : undefined;
}

function output() {
  return mocks.runtime.writeJson.mock.calls[0]?.[0];
}
const logLines = () => mocks.runtime.log.mock.calls.map(([line]) => String(line));

function gatewayConfig(agent = "worker", revision = "revision-new", applied = revision) {
  return {
    config: { agents: { entries: { [agent]: {} } } },
    configRevisionHash: revision,
    appliedConfigHash: applied,
  };
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
  return await add(["--json"], manifestPath);
}

describe("claws cli", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    vi.clearAllMocks();
    mocks.loadConfig.mockReset().mockReturnValue(enabledClawsLabsConfig);
    mocks.readCurrentConfigForPolicyCheck.mockReset().mockReturnValue(enabledClawsLabsConfig);
    mocks.listConfiguredMcpServers.mockReset().mockResolvedValue({
      ok: true,
      mcpServers: {},
    });
    mocks.callGatewayFromCli.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    mocks.preflightClawPackage.mockReset().mockResolvedValue({
      ok: false,
      code: "package_install_unavailable",
      message: "Package preflight is unavailable.",
    });
    mocks.applyClawAddPlanStateless.mockReset().mockImplementation(async (plan) => ({
      status: "complete",
      agent: plan.agent,
    }));
    mocks.leaseAssertOwned.mockReset();
    mocks.withOpenClawStateLease
      .mockReset()
      .mockImplementation(
        async (_options, run) => await run({ assertOwned: mocks.leaseAssertOwned }),
      );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks local Add while Claws Labs is off", async () => {
    mocks.loadConfig.mockReturnValue({});
    expect(await add(["--dry-run", "--json"])).toMatchObject({
      ok: false,
      error: { code: "claws_labs_disabled" },
    });
    expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
  });

  it("prints versioned experimental JSON for a development manifest", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(output()).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: { schemaVersion: 1, agent: { id: "demo-agent" } },
    });
  });

  it.each([undefined, "demo-agent-two"])(
    "plans package identity with agent override %s",
    async (agentId) => {
      const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
      const expectedWorkspace = await cliTestHelpers.canonicalFuturePath(workspace);
      if (agentId) {
        mocks.loadConfig.mockReturnValue({
          ...enabledClawsLabsConfig,
          agents: { entries: { "demo-agent": {} } },
        });
      }
      await add(
        [
          "--dry-run",
          "--workspace",
          workspace,
          "--json",
          ...(agentId ? ["--agent-id", agentId] : []),
        ],
        root,
      );

      expect(output()).toMatchObject({
        schemaVersion: "openclaw.clawAddPlan.v1",
        stability: "experimental",
        claw: { kind: "package", name: "@acme/demo-agent", version: "1.2.3" },
        agent: {
          requestedId: "demo-agent",
          finalId: agentId ?? "demo-agent",
          workspace: expectedWorkspace,
        },
        summary: { agentActions: 1, workspaceActions: 2, packageActions: 1, blockedActions: 1 },
      });
      expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("redacts credential-bearing remote MCP URLs in add previews", async () => {
    const manifestPath = await writeManifest({
      ...cliTestHelpers.minimalManifest,
      mcpServers: {
        remote: {
          url: "https://example.com/mcp?token=abc123&mode=ok",
          transport: "streamable-http",
        },
      },
    });
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");

    await runClawsAddCommand(manifestPath, { dryRun: true, workspace });

    const printed = logLines().join("\n");
    expect(printed).not.toMatch(/^Experimental:/m);
    expect(printed).toContain("MCP remote:");
    expect(printed).toContain("example.com");
    expect(printed).not.toContain("abc123");
    expect(printed).toContain("token=***");
  });

  it("discloses capability escalations in the human dry-run", async () => {
    const path = await writeManifest({
      ...cliTestHelpers.minimalManifest,
      mcpServers: {
        docs: {
          command: "node",
          env: { API_TOKEN: "${GITHUB_TOKEN}" },
          toolFilter: { include: ["search_*"] },
        },
      },
    });
    const root = dirname(path);
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    allow: [read]\n",
      "utf8",
    );

    await add(["--dry-run"], path);

    expect(logLines()).toEqual(
      expect.arrayContaining([
        "Capability escalations (2):",
        expect.stringMatching(/^ {2}! agent:demo-agent/),
        expect.stringMatching(/^ {2}! mcpServer:docs/),
        expect.stringContaining('"env":["API_TOKEN"]'),
      ]),
    );
  });

  it("adds a minimal Claw directly with an internal plan binding", async () => {
    await add(["--json"]);

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    const [plan, options] = mocks.applyClawAddPlanStateless.mock.calls[0]!;
    expect(options.consentPlanIntegrity).toBe(plan.planIntegrity);
    expect(output()).toMatchObject({
      status: "complete",
      agent: { finalId: "demo-agent" },
    });
  });

  it("does not Add when Labs was switched off after planning", async () => {
    mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});
    expect(await add(["--json"])).toMatchObject({
      status: "failed",
      error: { code: "claws_labs_disabled" },
    });
    expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
  });

  it("stops Add effects when Labs turns off after apply begins", async () => {
    const commitEffect = vi.fn();
    mocks.applyClawAddPlanStateless.mockImplementationOnce(async (_plan, options) => {
      await Promise.resolve();
      mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});
      options.assertForwardCurrent?.();
      commitEffect();
    });

    await add(["--json"]);

    expect(commitEffect).not.toHaveBeenCalled();
    expect(output().error.code).toBe("claws_labs_disabled");
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

    await add(["--json"], root);
    expect(output()).toMatchObject({
      error: { code: "clawhub_risk_acknowledgement_required" },
      warnings: [expect.objectContaining({ warning })],
    });
    expect(mocks.applyClawAddPlanStateless).not.toHaveBeenCalled();
    mocks.runtime.writeJson.mockClear();

    await add(["--acknowledge-clawhub-risk", "--json"], root);
    expect(mocks.applyClawAddPlanStateless).toHaveBeenCalledOnce();
    const consent = mocks.applyClawAddPlanStateless.mock.calls[0]?.[1]?.skillConsent;
    expect(consent).toBeDefined();
    const reviewed = { ref: "@acme/demo-skill", version: "1.0.0", integrity, riskWarning: warning };
    expect(() => consent.assertApproved(reviewed)).not.toThrow();
    expect(() => consent.assertApproved({ ...reviewed, riskWarning: "changed" })).toThrow(
      /review.*again/i,
    );
  });

  it("does not apply Add before owning the target agent lease", async () => {
    const manifestPath = await writeManifest();
    const { promise: heldLease, resolve: releaseLease } = createDeferredCore();
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
    mocks.callGatewayFromCli.mockResolvedValue(gatewayConfig());

    expect(await addWithAgentReadiness()).toMatchObject({ status: "complete" });

    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("waits for the requested agent in an applied revision after a cached response", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce(gatewayConfig("other", "revision-old"))
      .mockResolvedValueOnce(gatewayConfig("worker", "revision-new", "revision-old"))
      .mockResolvedValueOnce(gatewayConfig());

    expect(await addWithAgentReadiness()).toMatchObject({ status: "complete" });

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(3);
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
  });

  it("reports the last Gateway error after the reload deadline", async () => {
    mocks.callGatewayFromCli.mockRejectedValue(new Error("gateway unavailable"));

    await addWithAgentReadiness(() => {
      vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15_000);
    });
    expect(output()).toMatchObject({
      status: "failed",
      error: {
        code: "add_failed",
        message: "Gateway did not apply the Claw agent configuration in time: gateway unavailable",
      },
    });
  });
});
