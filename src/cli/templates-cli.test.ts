import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as cliTestHelpers from "./templates-cli.test-helpers.js";

const enabledTemplatesLabsConfig = {
  gateway: { controlUi: { experimental: { templates: true } } },
};

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
  applyTemplateAddPlanStateless: vi.fn(),
  withOpenClawStateLease: vi.fn(),
  leaseAssertOwned: vi.fn(),
  localAssertCurrent: vi.fn(),
  localSignal: new AbortController().signal,
  createLocalTemplateConversationAdapters: vi.fn(),
  preflightTemplatePackage: vi.fn(),
  waitForAgentRuntime: vi.fn(),
  prepareAgentSession: vi.fn(),
  onAgentReady: vi.fn(),
  onSetupEvent: vi.fn(),
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

vi.mock("../templates/packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/packages.js")>()),
  preflightTemplatePackage: mocks.preflightTemplatePackage,
}));

vi.mock("../state/openclaw-state-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-lease.js")>()),
  withOpenClawStateLease: mocks.withOpenClawStateLease,
}));

vi.mock("../templates/add-stateless.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/add-stateless.js")>()),
  applyTemplateAddPlanStateless: mocks.applyTemplateAddPlanStateless,
}));

// mock-isolation: CLI unit tests bypass live Gateway ownership probes; the owner guard has its own test.
vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({
    runLocal,
  }: {
    runLocal: (scope: { assertCurrent: () => void; signal: AbortSignal }) => Promise<void>;
  }) => await runLocal({ assertCurrent: mocks.localAssertCurrent, signal: mocks.localSignal }),
}));
// mock-isolation: command wiring uses no live cron store; scheduler behavior is covered by Template Add integration tests.
vi.mock("../cron/local-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron/local-service.js")>()),
  withLocalCronService: async (_getConfig: unknown, run: (cron: unknown) => Promise<unknown>) =>
    run({}),
}));
// mock-isolation: this command test verifies adapter wiring; normal session/model owners are covered separately.
vi.mock("./templates-agent-conversation.js", () => ({
  createLocalTemplateConversationAdapters: mocks.createLocalTemplateConversationAdapters,
}));

const { registerTemplatesCli } = await import("./templates-cli.js");
const { runTemplatesAddCommand } = await import("./templates-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeManifest(value: unknown = cliTestHelpers.minimalManifest): Promise<string> {
  return await cliTestHelpers.writeManifestFile(tempDirs, value);
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerTemplatesCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

async function add(args: string[] = [], source?: string) {
  await runCli(["templates", "add", source ?? (await writeManifest()), ...args]);
  return args.includes("--json") ? output() : undefined;
}

function output() {
  return mocks.runtime.writeJson.mock.calls[0]?.[0];
}
const logLines = () => mocks.runtime.log.mock.calls.map(([line]) => String(line));

describe("templates cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReset().mockReturnValue(enabledTemplatesLabsConfig);
    mocks.readCurrentConfigForPolicyCheck.mockReset().mockReturnValue(enabledTemplatesLabsConfig);
    mocks.listConfiguredMcpServers.mockReset().mockResolvedValue({
      ok: true,
      mcpServers: {},
    });
    mocks.waitForAgentRuntime.mockReset().mockResolvedValue("applied");
    mocks.localAssertCurrent.mockReset();
    mocks.createLocalTemplateConversationAdapters.mockReset().mockReturnValue({
      prepareAgentSession: mocks.prepareAgentSession,
      waitForAgentRuntime: mocks.waitForAgentRuntime,
      onAgentReady: mocks.onAgentReady,
      onSetupEvent: mocks.onSetupEvent,
    });
    mocks.preflightTemplatePackage.mockReset().mockResolvedValue({
      ok: false,
      code: "package_install_unavailable",
      message: "Package preflight is unavailable.",
    });
    mocks.applyTemplateAddPlanStateless.mockReset().mockImplementation(async (plan) => ({
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

  it("blocks local Add while Templates Labs is off", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});
    expect(await add(["--dry-run", "--json"])).toMatchObject({
      ok: false,
      error: { code: "templates_labs_disabled" },
    });
    expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
  });

  it("resolves a registry name to verified artifact bytes for dry-run and scoped Add", async () => {
    const registry = await registryFixture();
    const workspace = join(tempDirs.make("openclaw-registry-cli-"), "workspace");
    const preview = await add(["--dry-run", "--json", "--workspace", workspace], registry.name);
    expect(preview).toMatchObject({
      template: {
        name: registry.name,
        version: "1.2.3",
        integrityKind: "artifact",
        integrity: registry.integrity,
      },
      summary: { blockedActions: 0 },
    });
    expect(existsSync(workspace)).toBe(false);
    expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
    expect(mocks.withOpenClawStateLease).not.toHaveBeenCalled();
    expect(mocks.createLocalTemplateConversationAdapters).not.toHaveBeenCalled();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.listConfiguredMcpServers).toHaveBeenCalledWith({ observe: false });
    mocks.runtime.writeJson.mockClear();
    let extractedRoot = "";
    mocks.applyTemplateAddPlanStateless.mockImplementationOnce(async (plan) => {
      extractedRoot = plan.template.packageRoot;
      expect(await readFile(join(extractedRoot, "workspace", "AGENTS.md"), "utf8")).toBe(
        "# Demo\n",
      );
      return {
        status: "partial",
        agent: plan.agent,
        error: { code: "fixture_partial", message: "Inspect retained resources." },
      };
    });
    expect(await add(["--json", "--workspace", workspace], registry.name)).toMatchObject({
      status: "partial",
      error: { code: "fixture_partial" },
    });
    expect(existsSync(extractedRoot)).toBe(false);
    expect(mocks.runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps registry trust acknowledgement separate from dependency preflight", async () => {
    const registry = await registryFixture("trust");
    expect(await add(["--dry-run", "--json"], registry.name)).toMatchObject({
      riskAcknowledgementRequired: true,
    });
    mocks.runtime.writeJson.mockClear();
    expect(await add(["--acknowledge-clawhub-risk", "--json"], registry.name)).toMatchObject({
      status: "complete",
    });
    mocks.runtime.writeJson.mockClear();
    mocks.applyTemplateAddPlanStateless.mockClear();
    await registryFixture("dependency");
    expect(await add(["--acknowledge-clawhub-risk", "--json"], registry.name)).toMatchObject({
      summary: { blockedActions: 1 },
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "package_install_unavailable" }),
      ]),
    });
    expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
  });

  it.for(["family", "name", "digest", "version", "trust"] as const)(
    "rejects registry %s mismatches before applying",
    async (failure) => {
      const registry = await registryFixture(failure);
      expect(await add(["--json"], registry.name)).toMatchObject({
        error: {
          code:
            failure === "digest"
              ? "clawhub_artifact_integrity_mismatch"
              : failure === "version"
                ? "clawhub_version_unavailable"
                : failure === "trust"
                  ? "clawhub_risk_acknowledgement_required"
                  : "clawhub_identity_mismatch",
        },
      });
      expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
    },
  );

  it("prints versioned experimental JSON for a development manifest", async () => {
    const manifestPath = await writeManifest();

    await runCli(["templates", "inspect", manifestPath, "--json"]);

    expect(output()).toMatchObject({
      schemaVersion: "openclaw.templateInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: { schemaVersion: 1, agent: { id: "demo-agent" } },
    });
  });

  it.for([undefined, "demo-agent-two", ""])("plans package with override %s", async (agentId) => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    const expectedWorkspace = await cliTestHelpers.canonicalFuturePath(workspace);
    if (agentId) {
      mocks.loadConfig.mockReturnValue({
        ...enabledTemplatesLabsConfig,
        agents: { entries: { "demo-agent": {} } },
      });
    }
    const args = ["--dry-run", "--workspace", workspace, "--json"];
    args.push(...(agentId === undefined ? [] : ["--agent-id", agentId]));
    await add(args, root);
    const blockedActions = agentId === "" ? 2 : 1;
    expect(output()).toMatchObject({
      schemaVersion: "openclaw.templateAddPlan.v1",
      stability: "experimental",
      template: { kind: "package", name: "@acme/demo-agent", version: "1.2.3" },
      agent: {
        requestedId: "demo-agent",
        finalId: agentId ?? "demo-agent",
        workspace: expectedWorkspace,
      },
      summary: { agentActions: 1, workspaceActions: 2, packageActions: 1, blockedActions },
    });
    if (agentId === "") {
      expect(output()).toMatchObject({
        blockers: expect.arrayContaining([expect.objectContaining({ code: "invalid_agent_id" })]),
        actions: expect.arrayContaining([
          expect.objectContaining({ kind: "agent", blocked: true }),
        ]),
      });
    }
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(existsSync(workspace)).toBe(false);
  });

  it("redacts credentials and sanitizes MCP targets in add previews", async () => {
    const manifestPath = await writeManifest({
      ...cliTestHelpers.minimalManifest,
      mcpServers: {
        remote: {
          url: "https://example.com/mcp?token=abc123&mode=ok",
          transport: "streamable-http",
        },
        server: { command: "node\u001b[2Jevil\narg" },
      },
    });
    const workspace = join(tempDirs.make("openclaw-templates-add-"), "workspace");
    await runTemplatesAddCommand(manifestPath, { dryRun: true, workspace });

    const printed = logLines().join("\n");
    expect(printed).not.toMatch(/^Experimental:/m);
    expect(printed).toContain("MCP remote: https://example.com/mcp?token=***&mode=ok");
    expect(printed).not.toContain("abc123");
    expect(printed).toContain("MCP server: nodeevil\\narg");
    expect(printed).not.toContain("\u001b[2J");
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

  it("adds a minimal Template directly with an internal plan binding", async () => {
    await add(["--json"]);

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    const [plan, options] = mocks.applyTemplateAddPlanStateless.mock.calls[0]!;
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
      error: { code: "templates_labs_disabled" },
    });
    expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
  });

  it("stops Add effects when Labs turns off after apply begins", async () => {
    const commitEffect = vi.fn();
    mocks.applyTemplateAddPlanStateless.mockImplementationOnce(async (_plan, options) => {
      await Promise.resolve();
      mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});
      options.assertForwardCurrent?.();
      commitEffect();
    });

    await add(["--json"]);

    expect(commitEffect).not.toHaveBeenCalled();
    expect(output().error.code).toBe("templates_labs_disabled");
  });

  it("requires explicit acknowledgement of a warned skill", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const warning = "This community skill requires review before installation.";
    const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mocks.preflightTemplatePackage.mockResolvedValue({
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
    expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
    mocks.runtime.writeJson.mockClear();

    await add(["--acknowledge-clawhub-risk", "--json"], root);
    expect(mocks.applyTemplateAddPlanStateless).toHaveBeenCalledOnce();
    const consent = mocks.applyTemplateAddPlanStateless.mock.calls[0]?.[1]?.skillConsent;
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
    const pending = runCli(["templates", "add", manifestPath, "--json"]);
    try {
      await vi.waitFor(() => expect(mocks.withOpenClawStateLease).toHaveBeenCalledOnce());
      expect(mocks.withOpenClawStateLease).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "core:agent-deletion", key: "demo-agent" }),
        expect.any(Function),
      );
      expect(mocks.applyTemplateAddPlanStateless).not.toHaveBeenCalled();
    } finally {
      releaseLease();
      await pending;
    }
    const [, options] = mocks.applyTemplateAddPlanStateless.mock.calls[0]!;
    options.assertCurrent();
    expect(mocks.leaseAssertOwned).toHaveBeenCalled();
  });

  it.for(["local", "registry"])(
    "wires %s Add into the same offline shared installer",
    async (source) => {
      await add(["--json"], source === "registry" ? (await registryFixture()).name : undefined);
      const [, options] = mocks.applyTemplateAddPlanStateless.mock.calls[0]!;
      expect(mocks.createLocalTemplateConversationAdapters).toHaveBeenCalledExactlyOnceWith({
        agentId: "demo-agent",
        assertCurrent: options.assertCurrent,
        signal: mocks.localSignal,
        runtime: expect.objectContaining({ log: expect.any(Function) }),
      });
      options.assertCurrent();
      expect(mocks.localAssertCurrent).toHaveBeenCalled();
      expect(mocks.leaseAssertOwned).toHaveBeenCalled();
      mocks.localAssertCurrent.mockImplementation(() => {
        throw new Error("offline custody lost");
      });
      expect(() => options.assertCurrent()).toThrow("offline custody lost");
      expect(options.prepareAgentSession).toBe(mocks.prepareAgentSession);
      expect(options.waitForAgentRuntime).toBe(mocks.waitForAgentRuntime);
      expect(options.onAgentReady).toBe(mocks.onAgentReady);
      expect(options.onSetupEvent).toBe(mocks.onSetupEvent);
      expect(options.cronGateway).toEqual(
        expect.objectContaining({
          add: expect.any(Function),
          enable: expect.any(Function),
          writeScratch: expect.any(Function),
        }),
      );
      const [conversationOptions] = mocks.createLocalTemplateConversationAdapters.mock.calls[0]!;
      conversationOptions.runtime.log("conversation output");
      options.runtime.log("conversation output");
      expect(logLines()).not.toContain("conversation output");
      expect(output()).toMatchObject({ status: "complete" });
    },
  );
});

// Wire fixtures keep the real registry client, trust gate, downloader, extractor,
// manifest reader, and Add planner; only HTTP responses and the final mutation are controlled.
async function registryFixture(
  failure?: "family" | "name" | "digest" | "version" | "trust" | "dependency",
) {
  const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
  const manifestPath = join(root, "CLAW.md");
  const manifest = JSON.parse((await readFile(manifestPath, "utf8")).split("---")[1]!);
  if (failure !== "dependency") {
    manifest.packages = [];
  }
  await writeFile(manifestPath, `---\n${JSON.stringify(manifest)}\n---\n`);
  const archive = join(tempDirs.make("openclaw-registry-archive-"), "package.tgz");
  await createTar({ gzip: true, file: archive, cwd: dirname(root) }, [root.split("/").at(-1)!]);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const npmIntegrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const name = "@acme/demo-agent";
  const pkg = {
    name,
    family: "template",
    displayName: "Demo",
    channel: "community",
    isOfficial: false,
    updatedAt: 1,
    latestVersion: failure === "version" ? "latest" : "1.2.3",
  };
  const artifact = {
    kind: "npm-pack",
    sha256: failure === "digest" ? "0".repeat(64) : sha256,
    npmIntegrity,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = decodeURIComponent(url.pathname);
    if (route.endsWith("/artifact/download")) {
      return new Response(bytes, { headers: { "X-ClawHub-Artifact-Sha256": sha256 } });
    }
    if (route.endsWith("/artifact")) {
      return Response.json({ package: pkg, version: "1.2.3", artifact });
    }
    if (route.endsWith("/security")) {
      return Response.json({
        package: pkg,
        release: {
          version: "1.2.3",
          artifactKind: "npm-pack",
          artifactSha256: artifact.sha256,
          npmIntegrity,
        },
        overview: "Synthetic security review.",
        securityAuditUrl: "https://clawhub.ai/acme/templates/demo-agent/security-audit",
        verdict: failure === "trust" ? "suspicious" : "benign",
        trust: {
          scanStatus: "clean",
          moderationState: "approved",
          blockedFromDownload: false,
          reasons: [],
          pending: false,
          stale: false,
        },
      });
    }
    if (route === "/api/v1/packages/" + name) {
      return Response.json({
        package: {
          ...pkg,
          ...(failure === "family" ? { family: "plugin" } : {}),
          ...(failure === "name" ? { name: "@acme/other" } : {}),
        },
        owner: { handle: "acme" },
      });
    }
    throw new Error("Unexpected registry request: " + route);
  });
  return { name, integrity: "sha256:" + sha256 };
}
