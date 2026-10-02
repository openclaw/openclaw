import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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
    closeReadOnlyDatabase: vi.fn(),
    stateTableGet: vi.fn(),
    openExistingOpenClawStateDatabaseReadOnly: vi.fn(),
    applyClawAddPlan: vi.fn(),
    readClawInventory: vi.fn(),
    readClawStatus: vi.fn(),
    buildClawRemovePlan: vi.fn(),
    applyClawRemovePlan: vi.fn(),
    applyClawUpdatePlan: vi.fn(),
    buildClawUpdatePlan: vi.fn(),
    withOpenClawStateLease: vi.fn(),
    leaseAssertOwned: vi.fn(),
    exportClawAgent: vi.fn(),
    callGatewayFromCli: vi.fn(),
    sleep: vi.fn(),
    preflightClawPackage: vi.fn(),
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

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("../utils/sleep.js", () => ({
  sleep: mocks.sleep,
}));

vi.mock("../claws/packages.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/packages.js")>("../claws/packages.js")),
  preflightClawPackage: mocks.preflightClawPackage,
}));

vi.mock("../state/openclaw-state-db.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
    "../state/openclaw-state-db.js",
  )),
  openExistingOpenClawStateDatabaseReadOnly: mocks.openExistingOpenClawStateDatabaseReadOnly,
}));

vi.mock("../state/openclaw-state-lease.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-lease.js")>(
    "../state/openclaw-state-lease.js",
  )),
  withOpenClawStateLease: mocks.withOpenClawStateLease,
}));

vi.mock("../claws/add.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js")),
  applyClawAddPlan: mocks.applyClawAddPlan,
}));

vi.mock("../claws/inventory-read.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/inventory-read.js")>(
    "../claws/inventory-read.js",
  )),
  readClawInventory: mocks.readClawInventory,
}));

vi.mock("../claws/lifecycle-state.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/lifecycle-state.js")>(
    "../claws/lifecycle-state.js",
  )),
  readClawStatus: mocks.readClawStatus,
  buildClawRemovePlan: mocks.buildClawRemovePlan,
  applyClawRemovePlan: mocks.applyClawRemovePlan,
}));

vi.mock("../claws/export.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/export.js")>("../claws/export.js")),
  exportClawAgent: mocks.exportClawAgent,
}));

vi.mock("../claws/update-plan.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-plan.js")>("../claws/update-plan.js")),
  buildClawUpdatePlan: mocks.buildClawUpdatePlan,
}));

vi.mock("../claws/update-apply.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-apply.js")>("../claws/update-apply.js")),
  applyClawUpdatePlan: mocks.applyClawUpdatePlan,
}));

const { registerClawsCli } = await import("./claws-cli.js");
const { ClawUpdateMutationError } = await import("../claws/update-apply.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.preflightClawPackage.mockReset();
    mocks.preflightClawPackage.mockResolvedValue({
      ok: false,
      code: "package_install_unavailable",
      message: "Package preflight is unavailable.",
    });
    mocks.closeReadOnlyDatabase.mockReset();
    mocks.stateTableGet.mockReset();
    mocks.stateTableGet.mockReturnValue({ 1: 1 });
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockReset();
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockReturnValue({
      db: {
        prepare: (sql: string) => ({
          get: sql.includes("sqlite_master") ? mocks.stateTableGet : vi.fn(() => undefined),
          all: vi.fn(() => [
            { name: "bootstrap_source_path" },
            { name: "bootstrap_content_digest" },
          ]),
        }),
      },
      path: "state.sqlite",
      walMaintenance: {
        checkpoint: () => false,
        close: mocks.closeReadOnlyDatabase,
        reclaimFreePages: createSqliteWalReclamationResult,
      },
    });
    mocks.applyClawAddPlan.mockReset();
    mocks.applyClawAddPlan.mockImplementation(async (plan) => ({
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
      installRecord: { agentId: plan.agent.finalId },
    }));
    mocks.readClawStatus.mockReset();
    mocks.readClawInventory.mockReset();
    mocks.readClawInventory.mockResolvedValue({
      installs: [],
      packages: [],
      workspaceFiles: [],
      mcpServers: [],
      cronJobs: [],
    });
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      records: [],
      summary: { claws: 0, partial: 0, missingAgents: 0, driftedFiles: 0, packageRefs: 0 },
    });
    mocks.buildClawRemovePlan.mockReset();
    const removal = cliTestHelpers.createClawRemoveFixtures();
    mocks.buildClawRemovePlan.mockResolvedValue(removal.plan);
    mocks.applyClawRemovePlan.mockReset();
    mocks.applyClawRemovePlan.mockResolvedValue(removal.result);
    mocks.buildClawUpdatePlan.mockReset();
    mocks.buildClawUpdatePlan.mockResolvedValue({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:update-plan",
      found: true,
      agentId: "demo-agent",
      currentClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
      targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
      summary: {
        totalActions: 1,
        added: 0,
        changed: 1,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 0,
        blocked: 0,
        capabilityChanges: 1,
        capabilityEscalations: 1,
      },
      actions: [],
      capabilityChanges: [
        {
          kind: "agent",
          id: "demo-agent",
          path: "agent.sandbox.mode",
          action: "change",
          classification: "escalation",
          requiresDistinctConsent: true,
          reason: "Agent capability field sandbox.mode changes in the target manifest.",
          effect: { path: "sandbox.mode", current: "non-main", desired: "all" },
          current: { summary: "non-main", digest: "sha256:current" },
          desired: { summary: "all", digest: "sha256:desired" },
        },
      ],
      readiness: cliTestHelpers.pluginSetupReadiness,
      blockers: [],
      diagnostics: [],
    });
    mocks.applyClawUpdatePlan.mockReset();
    mocks.applyClawUpdatePlan.mockResolvedValue({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      stability: "experimental",
      dryRun: false,
      mutationAllowed: true,
      status: "complete",
      agentId: "demo-agent",
      previousClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
      targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
      appliedActions: [],
      installRecord: { agentId: "demo-agent" },
    });
    mocks.leaseAssertOwned.mockReset();
    mocks.withOpenClawStateLease.mockReset();
    mocks.withOpenClawStateLease.mockImplementation(
      async (_options, run) => await run({ assertOwned: mocks.leaseAssertOwned }),
    );
    mocks.exportClawAgent.mockReset();
    mocks.exportClawAgent.mockResolvedValue({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "demo-agent",
      outputDirectory: "/tmp/exported",
      manifest: {
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        workspace: { bootstrapFiles: {}, files: [] },
        packages: [],
        mcpServers: {},
        cronJobs: [],
      },
      filesWritten: ["package.json", "openclaw.claw.json"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it("prints a read-only grouped update plan", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);

    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "demo-agent",
        targetManifest: expect.objectContaining({
          agent: { id: "demo-agent", name: "Demo Agent" },
        }),
        targetSource: expect.objectContaining({ name: "@acme/demo-agent", version: "1.2.3" }),
        config: {},
        sourceMcpServers: {},
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      dryRun: true,
      mutationAllowed: false,
      agentId: "demo-agent",
    });
  });

  it("discloses a warned skill Update and passes exact-plan consent to the installer", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const warning = "Review this skill update.";
    const integrity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    mocks.preflightClawPackage.mockResolvedValue({
      ok: true,
      action: "install",
      integrity,
      warning,
    });
    const baseBuild = mocks.buildClawUpdatePlan.getMockImplementation();
    if (!baseBuild) {
      throw new Error("missing update fixture implementation");
    }
    mocks.buildClawUpdatePlan.mockImplementation(async (input) => {
      await input.packagePreflight(
        { kind: "skill", source: "clawhub", ref: "@acme/demo-skill", version: "1.0.0" },
        "/tmp/demo-workspace",
      );
      input.captureGatewayProjection?.(
        { id: "demo-agent" },
        {
          actions: [
            {
              kind: "package",
              id: "skill:@acme/demo-skill",
              blocked: false,
              details: {
                kind: "skill",
                source: "clawhub",
                ref: "@acme/demo-skill",
                version: "1.0.0",
                integrity,
                ownerAction: "install",
                riskWarning: warning,
              },
            },
          ],
        },
      );
      return {
        ...(await baseBuild(input)),
        actions: [
          {
            kind: "package",
            id: "skill:@acme/demo-skill",
            action: "change",
            target: "clawhub:@acme/demo-skill@1.0.0",
            blocked: false,
            reason: "Upgrade managed skill",
            desiredDigest: "sha256:planned-skill",
          },
        ],
      };
    });

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      skillWarnings: [
        { ref: "@acme/demo-skill", version: "1.0.0", integrity, riskWarning: warning },
      ],
    });
    mocks.logs.length = 0;
    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);
    const consent = mocks.applyClawUpdatePlan.mock.calls[0]?.[2]?.skillConsent;
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

  it("uses reviewed skill warnings for an exclusively Claw-owned upgrade", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const warning = "Review this upgraded skill.";
    const integrity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const skill = {
      kind: "skill" as const,
      source: "clawhub" as const,
      ref: "@acme/demo-skill",
      version: "1.0.0",
    };
    mocks.preflightClawPackage.mockResolvedValue({
      ok: false,
      code: "skill_version_conflict",
      message: "The installed skill has another version.",
      integrity,
      warning,
    });
    const baseBuild = mocks.buildClawUpdatePlan.getMockImplementation();
    if (!baseBuild) {
      throw new Error("missing update fixture implementation");
    }
    mocks.buildClawUpdatePlan.mockImplementation(async (input) => {
      expect(await input.packagePreflight(skill, "/tmp/demo-workspace")).toMatchObject({
        ok: false,
        code: "skill_version_conflict",
      });
      input.captureGatewayProjection?.(
        { id: "demo-agent" },
        {
          actions: [
            {
              kind: "package",
              id: "skill:@acme/demo-skill",
              blocked: false,
              details: { ...skill, integrity, ownerAction: "install", riskWarning: warning },
            },
          ],
        },
      );
      return {
        ...(await baseBuild(input)),
        actions: [
          {
            kind: "package",
            id: "skill:@acme/demo-skill",
            action: "change",
            target: "clawhub:@acme/demo-skill@1.0.0",
            blocked: false,
            reason: "Upgrade exclusively Claw-owned skill",
            desiredDigest: "sha256:planned-skill",
          },
        ],
      };
    });

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      skillWarnings: [{ ref: skill.ref, version: skill.version, integrity, riskWarning: warning }],
    });

    mocks.logs.length = 0;
    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);
    const consent = mocks.applyClawUpdatePlan.mock.calls[0]?.[2]?.skillConsent;
    expect(consent).toBeDefined();
    expect(() =>
      consent.assertApproved({
        ref: skill.ref,
        version: skill.version,
        integrity,
        riskWarning: warning,
      }),
    ).not.toThrow();
  });

  it("prints capability escalation details in human update previews", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run"]);

    const output = mocks.logs.join("\n");
    expect(output).toContain("Capability changes: 1; escalations requiring explicit review: 1");
    expect(output).toContain("MARKET_DATA_TOKEN");
    expect(output).toContain(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
    expect(output).toContain("! agent.sandbox.mode: non-main -> all (change)");
    expect(output).toContain(
      'effect: {"path":"sandbox.mode","current":"non-main","desired":"all"}',
    );
  });

  it("returns failure when an update plan contains blocked actions", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.buildClawUpdatePlan.mockResolvedValueOnce({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:blocked-plan",
      found: true,
      agentId: "demo-agent",
      summary: {
        totalActions: 1,
        added: 0,
        changed: 0,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 1,
        blocked: 1,
        capabilityChanges: 0,
        capabilityEscalations: 0,
      },
      capabilityChanges: [],
      readiness: { ready: true, requirements: [] },
      actions: [
        {
          kind: "workspaceFile",
          id: "SOUL.md",
          action: "manual",
          target: "workspace:SOUL.md",
          blocked: true,
          reason: "Local content changed.",
        },
      ],
      blockers: [],
      diagnostics: [],
    });

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);

    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("uses the source recorded by the installed Claw when --from is omitted", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    profile: coding\n",
      "utf8",
    );
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      records: [
        {
          install: {
            agentId: "demo-agent",
            claw: {
              kind: "package",
              name: "@acme/demo-agent",
              version: "1.0.0",
              packageRoot: root,
              manifestPath: join(root, "openclaw.claw.json"),
              integrity: "sha256:old",
            },
          },
          workspaceFiles: [],
          packages: [],
          mcpServers: [],
          cronJobs: [],
        },
      ],
      summary: { claws: 1 },
    });

    await runCli(["claws", "update", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.readClawStatus).toHaveBeenCalledWith(
      "demo-agent",
      expect.objectContaining({ readOnly: true, sourceMcpServers: {} }),
    );
    expect(mocks.closeReadOnlyDatabase).toHaveBeenCalled();
    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "demo-agent",
        targetSource: expect.objectContaining({ name: "@acme/demo-agent", version: "1.2.3" }),
        targetOpenClawProfile: expect.objectContaining({
          agent: {
            tools: expect.objectContaining({
              profile: "full",
              allow: expect.not.arrayContaining(["bundle-mcp"]),
            }),
          },
        }),
      }),
    );
  });

  it("returns not found for a supported state database without Claws tables", async () => {
    mocks.stateTableGet.mockReturnValue(undefined);

    await runCli(["claws", "update", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.readClawStatus).not.toHaveBeenCalled();
    expect(mocks.closeReadOnlyDatabase).toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "claw_not_found", phase: "plan" })],
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when update is invoked without dry-run", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--json"]);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("requires exact plan integrity with update consent", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--yes", "--json"]);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies a supported update only after explicit consent", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const applyUpdate = mocks.applyClawUpdatePlan.getMockImplementation();
    if (!applyUpdate) {
      throw new Error("missing update fixture implementation");
    }
    mocks.applyClawUpdatePlan.mockImplementationOnce(async (...args) => {
      const options = args[2] as { runtime?: typeof mocks.runtime };
      (options.runtime ?? mocks.runtime).log("Installed plugin: demo");
      return await applyUpdate(...args);
    });

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);

    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "demo-agent" }),
      expect.objectContaining({
        targetManifest: expect.objectContaining({
          agent: { id: "demo-agent", name: "Demo Agent" },
        }),
      }),
      expect.objectContaining({
        config: {},
        sourceMcpServers: {},
        consentPlanIntegrity: "sha256:update-plan",
        packagePreflight: expect.any(Function),
        cronGateway: expect.objectContaining({
          add: expect.any(Function),
          get: expect.any(Function),
          remove: expect.any(Function),
        }),
      }),
    );
    expect(mocks.logs).toHaveLength(1);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "complete",
      agentId: "demo-agent",
    });
    mocks.callGatewayFromCli.mockResolvedValue({
      config: { agents: { entries: { "demo-agent": {} } } },
      configRevisionHash: "applied",
      appliedConfigHash: "applied",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(20_000);
    const [plan, , options] = mocks.applyClawUpdatePlan.mock.calls[0]!;
    await expect(
      options.cronGateway.waitUntilAgentAvailable(plan.agentId),
    ).resolves.toBeUndefined();
  });

  it("does not Update when Labs was switched off after review", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.readCurrentConfigForPolicyCheck.mockReturnValue({});

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "failed",
      error: { code: "claws_labs_disabled" },
    });
    expect(mocks.applyClawUpdatePlan).not.toHaveBeenCalled();
  });

  it("does not apply an update before owning the target agent's deletion lease", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    let releaseLease!: () => void;
    const heldLease = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    mocks.withOpenClawStateLease.mockImplementationOnce(async (_options, run) => {
      await heldLease;
      return await run({ assertOwned: mocks.leaseAssertOwned });
    });
    const pending = runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);
    try {
      await vi.waitFor(() => expect(mocks.withOpenClawStateLease).toHaveBeenCalledOnce());
      expect(mocks.withOpenClawStateLease).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "core:agent-deletion", key: "demo-agent" }),
        expect.any(Function),
      );
      expect(mocks.applyClawUpdatePlan).not.toHaveBeenCalled();
    } finally {
      releaseLease();
      await pending;
    }
    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledOnce();
    const options = mocks.applyClawUpdatePlan.mock.calls[0]![2];
    options.assertCurrent();
    expect(mocks.leaseAssertOwned).toHaveBeenCalledOnce();
  });

  it("reports uncertain update mutations as partial JSON", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.applyClawUpdatePlan.mockRejectedValueOnce(
      new ClawUpdateMutationError("update_partial", "artifact outcome requires reconciliation"),
    );

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "partial",
      error: { code: "update_partial" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each(
    [true, false].flatMap((json) => ["complete", "partial"].map((status) => ({ json, status }))),
  )("reports consented removal outcomes (json=$json, status=$status)", async ({ json, status }) => {
    const warnings = ["Plugin cleanup is still finishing."];
    const pluginRuntime = { operationId: "runtime-final", generation: 3, pluginIds: ["audit"] };
    const error = {
      code: "package_cleanup_failed",
      message: "Plugin activation failed. Gateway generation 3: replacement applied.",
    };
    mocks.applyClawRemovePlan.mockResolvedValue({
      ...cliTestHelpers.createClawRemoveFixtures().result,
      pluginRuntime,
      warnings,
      status,
      agentRemoved: status === "complete",
      ...(status === "partial" ? { error } : {}),
    });
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--yes",
      "--plan-integrity",
      "sha256:remove-plan",
      ...(json ? ["--json"] : []),
    ]);

    expect(mocks.applyClawRemovePlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: "sha256:remove-plan" }),
      expect.objectContaining({
        consentPlanIntegrity: "sha256:remove-plan",
        referencedCleanup: { mode: "retain" },
      }),
    );
    if (json) {
      expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
        schemaVersion: "openclaw.clawRemoveResult.v1",
        status,
        agentId: "demo-agent",
        pluginRuntime,
        warnings,
        ...(status === "partial" ? { error } : {}),
      });
    } else {
      expect(mocks.logs.filter((line) => line === `Warning: ${warnings[0]}`)).toHaveLength(1);
      expect(mocks.logs).toContain("Plugin runtime changed in Gateway generation 3.");
      if (status === "partial") {
        expect(mocks.errors).toContain(error.message);
        expect(mocks.logs).not.toContain("Removed agent: demo-agent");
      }
    }
    if (status === "partial") {
      expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    }
  });
});
