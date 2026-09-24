import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import * as versionManagerPath from "../../shared/version-manager-path.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { packageTargetStatus } from "./update-cli-package.test-support.js";
import {
  createCandidateAdmissionFixtures,
  type CandidateAdmissionFixture,
} from "./update-command-candidate-admission-fixture.test-support.js";
import * as runtimeRecovery from "./update-command-runtime-recovery.test-support.js";

export function registerCandidateAdmissionTests(f: CandidateAdmissionFixture) {
  const {
    createCaseDir,
    makeTempDir,
    fixtureRoot,
    baseSnapshot,
    setupInstalledPackageRoot,
    mockPackageInstallStatus,
    mockPackageInstallAtCaseDir,
    mockOwnedGitService,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    gatewayFixturePid,
    spawn,
    serviceLoaded,
    serviceStop,
    serviceStart,
    serviceRestart,
    mockGetSelfAndAncestorPidsSync,
    pluginAvailabilityPreflight,
    candidateValidation,
    nodeVersionSatisfiesEngine,
    databasePreflightMocks,
    readConfigFileSnapshot,
    replaceConfigFile,
    fetchNpmPackageTargetStatus,
    resolveGatewayInstallEntrypoint,
    listUpdateRuns,
    updateGitCheckout,
    defaultRuntime,
    ExitError,
    updateCommand,
    invokeUpdateCli,
    packageInstallCommandCall,
    doctorCommandCall,
    freshRestartCalls,
    lastWriteJsonCall,
    getErrorOutput,
    getTriageFailures,
    expectNoSideEffects,
  } = f;

  const { prepareCandidateAdmissionFixture, candidateAdmissionVerdict } =
    createCandidateAdmissionFixtures(f);

  it.each(["refuse-artifact", "admit-artifact", "unsupported-artifact"] as const)(
    "candidate admission: gates fresh profile bootstrap (%s)",
    async (outcome) => {
      const refused = outcome === "refuse-artifact";
      const marker = outcome !== "unsupported-artifact";
      const verdict = candidateAdmissionVerdict(refused ? "config" : undefined);
      const { pkgRoot, stages, contexts, events, databaseExistsAtAdmission } =
        await prepareCandidateAdmissionFixture({ marker, verdict, pendingLifecycle: true });
      const stateDir = makeTempDir("candidate-admission-fresh-");
      const configPath = path.join(stateDir, "openclaw.json");
      const configBytes = refused ? '{"gateway":{"port":"invalid"}}\n' : "{}\n";
      await fs.writeFile(configPath, configBytes);
      const { createConfigIO } = await import("../../config/io.js");
      vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
        createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
      );
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({
          schemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        }),
      );
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
      const databasePath = resolveOpenClawStateSqlitePath(env);
      expect(fsSync.existsSync(databasePath)).toBe(false);

      await withEnvAsync(env, async () => {
        const updating = invokeUpdateCli({
          admission: "auto",
          yes: true,
          restart: false,
          json: true,
          tag: path.join(stateDir, "candidate.tgz"),
        });
        if (refused) {
          await expect(updating).rejects.toEqual(new ExitError(1));
        } else {
          await updating;
        }
      });

      expect(stages).toHaveLength(1);
      expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
      expect(contexts).toHaveLength(marker ? 1 : 0);
      expect(databaseExistsAtAdmission).toEqual(marker ? [false] : []);
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      if (refused) {
        expect(events).toEqual(["admission"]);
        expect(fsSync.existsSync(databasePath)).toBe(false);
        expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "invalid-config" });
        expectNoSideEffects(candidateValidation, replaceConfigFile, serviceStop);
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({ version: "1.0.0" });
      } else {
        expect(events.slice(0, marker ? 3 : 2)).toEqual(
          marker ? ["admission", "preinstall", "postinstall"] : ["preinstall", "postinstall"],
        );
        expect(lastWriteJsonCall()).toMatchObject({
          status: "ok",
          run: {
            admission: marker
              ? { owner: "candidate", checks: verdict.facts.checks }
              : { owner: "installed", fallbackReason: "unsupported-target" },
          },
        });
        expect(fsSync.existsSync(databasePath)).toBe(true);
      }
    },
  );

  it.each(
    (["candidate", "unsupported", "fallback"] as const).flatMap((source) =>
      (["config", "database-schema", "node-runtime"] as const)
        .filter((check) => source !== "candidate" || check !== "node-runtime")
        .map((check) => ({ source, check })),
    ),
  )(
    "candidate admission: reports $check refusals from $source before mutation",
    async ({ source, check }) => {
      const verdict = candidateAdmissionVerdict(check);
      const { pkgRoot, stages, contexts } = await prepareCandidateAdmissionFixture({
        marker: source !== "unsupported",
        verdict,
        ...(source === "fallback" ? { exitCode: 2 } : {}),
      });
      if (check === "config") {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          valid: false,
          issues: [{ path: "gateway.port", message: "Expected a number." }],
        });
      } else if (check === "database-schema") {
        vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
          packageTargetStatus({ schemaVersions: { state: 3, agent: 9 } }),
        );
        databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
          incompatible: [
            { kind: "agent", path: "/fixture/agent.sqlite", foundVersion: 11, supportedVersion: 9 },
          ],
          indeterminate: [],
        });
      } else {
        nodeVersionSatisfiesEngine.mockReturnValue(false);
      }
      vi.mocked(defaultRuntime.writeJson).mockImplementation((value) => {
        if (isRecord(value) && value.status === "error") {
          expect(stages).toHaveLength(1);
          expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
        }
      });

      await expect(
        invokeUpdateCli({
          admission: "auto",
          yes: true,
          json: true,
          restart: false,
          ...(check === "config" ? { channel: "beta" } : {}),
        }),
      ).rejects.toEqual(new ExitError(1));

      const reason = verdict.reasons[0]!.code;
      const run = expectDefined(listUpdateRuns({ limit: 1 })[0], "failed admission run");
      expect(run).toMatchObject({ status: "failed", reason });
      expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason });
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        candidateValidation,
        replaceConfigFile,
      );
      expect(doctorCommandCall()).toBeUndefined();
      expect(
        JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: "1.0.0" });
      expect(stages).toHaveLength(1);
      expect(contexts).toHaveLength(source === "unsupported" ? 0 : 1);
      if (source === "candidate") {
        expect(run.origin).toMatchObject({
          admission: { owner: "candidate", protocol: 1, checks: verdict.facts.checks },
          candidateAdmission: verdict,
          nextAction: verdict.reasons[0]!.nextAction,
        });
        expect(lastWriteJsonCall()).toMatchObject({
          run: { admission: { owner: "candidate", candidateVersion: "9999.0.0" } },
        });
        expect(JSON.stringify(lastWriteJsonCall())).toContain(verdict.reasons[0]!.message);
        expect(run.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ step: "candidate-admission", status: "failed" }),
          ]),
        );
      } else {
        const fallbackReason = source === "unsupported" ? "unsupported-target" : "exit-2";
        const warning =
          source === "unsupported"
            ? "update-admission-unsupported-target"
            : "update-admission-fallback";
        expect(run.origin.admission).toMatchObject({ owner: "installed", fallbackReason });
        expect(run.steps.filter((step) => step.step === `warning:${warning}`)).toHaveLength(1);
        expect(run.origin.candidateAdmission).toBeUndefined();
      }
    },
  );

  it("candidate admission: skips reported candidate-owned checks but retains installed Node preflight", async () => {
    const verdict = candidateAdmissionVerdict();
    verdict.warnings = [
      {
        code: "missing-plugin-load-path",
        message: "A custom plugin path is missing; its configuration is preserved.",
      },
    ];
    verdict.facts.checks[0] = {
      name: "config",
      status: "warn",
      detail: verdict.warnings[0]!.message,
    };
    const { pkgRoot, stages, contexts } = await prepareCandidateAdmissionFixture({
      marker: true,
      verdict,
    });
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 9 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        { kind: "agent", path: "/fixture/agent.sqlite", foundVersion: 11, supportedVersion: 9 },
      ],
      indeterminate: [],
    });
    pluginAvailabilityPreflight.mockRejectedValue(new Error("Installed plugin catalog is stale."));

    await invokeUpdateCli({ admission: "auto", yes: true, restart: false, json: true });

    expect(stages).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      installation: {
        root: pkgRoot,
        canonicalRoot: resolveUpdateInstallRoot(pkgRoot),
        version: "1.0.0",
        installKind: "package",
        packageManager: "npm",
      },
      target: { version: "9999.0.0", source: "registry" },
      request: { yes: true, noRestart: true, json: true },
    });
    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).not.toHaveBeenCalled();
    expect(nodeVersionSatisfiesEngine).toHaveBeenCalled();
    expect(pluginAvailabilityPreflight).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8"))).toMatchObject(
      { version: "9999.0.0" },
    );
    expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "ok",
      run: {
        admission: { owner: "candidate", checks: verdict.facts.checks },
        origin: { candidateAdmission: verdict },
      },
    });
    expect(getErrorOutput()).toContain(verdict.warnings[0]!.message);
  });

  it.each(["existing", "fresh"] as const)(
    "candidate admit with warn does not bypass runtime recovery (%s profile)",
    async (profile) => {
      const verdict = candidateAdmissionVerdict();
      verdict.facts.nodeEngines = ">=26.1.0";
      verdict.facts.checks[2] = {
        name: "node-runtime",
        status: "warn",
        detail: "Candidate requires Node >=26.1.0; selected runtime is Node 24.20.0.",
      };
      const { pkgRoot, stages, contexts, events } = await prepareCandidateAdmissionFixture({
        marker: true,
        verdict,
        nodeEngine: ">=26.1.0",
      });
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({
          nodeEngine: ">=26.1.0",
          schemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        }),
      );
      const recovery = await import("./update-command-node-runtime-resolution.js");
      const recoveredNode = path.join(makeTempDir("admission-recovered-node-"), "node");
      await fs.symlink(process.execPath, recoveredNode);
      nodeVersionSatisfiesEngine.mockReturnValue(false);
      const recoverNode = vi
        .spyOn(recovery, "resolveTargetNodeRuntime")
        .mockImplementation(async ({ engine, recovery: provision }) => {
          expect(contexts).toHaveLength(1);
          expect(engine).toBe(">=26.1.0");
          const install = expectDefined(provision.installCommand, "installed runtime provisioner");
          expect(await install(process.execPath, ["--version"], provision.env)).toBe(0);
          events.push("runtime-recovery");
          nodeVersionSatisfiesEngine.mockReturnValue(true);
          return recoveredNode;
        });
      const env: NodeJS.ProcessEnv = {};
      if (profile === "fresh") {
        const stateDir = makeTempDir("admission-recovery-fresh-");
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n");
        Object.assign(env, { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath });
        const { createConfigIO } = await import("../../config/io.js");
        vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
          createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
        );
      }
      await withEnvAsync(env, () =>
        invokeUpdateCli({
          admission: "auto",
          yes: true,
          restart: false,
          json: true,
          ...(profile === "fresh"
            ? { tag: path.join(env.OPENCLAW_STATE_DIR!, "candidate.tgz") }
            : {}),
        }),
      );

      expect(recoverNode).toHaveBeenCalledOnce();
      expect(events).toContain("runtime-provision");
      expect(events.indexOf("admission")).toBeLessThan(events.indexOf("runtime-recovery"));
      expect(stages).toHaveLength(1);
      expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
      expect(
        JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: "9999.0.0" });
      expect(lastWriteJsonCall()).toMatchObject({
        status: "ok",
        run: { admission: { owner: "candidate" }, origin: { candidateAdmission: verdict } },
      });
      expect(candidateValidation).toHaveBeenCalledWith(
        expect.objectContaining({ nodeRunner: recoveredNode }),
      );
    },
  );

  it("candidate admission: retains a check the candidate did not report", async () => {
    const verdict = candidateAdmissionVerdict();
    verdict.facts.checks = verdict.facts.checks.filter((check) => check.name !== "node-runtime");
    const { stages, contexts } = await prepareCandidateAdmissionFixture({ marker: true, verdict });
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await expect(
      updateCommand({ admission: "auto", yes: true, json: true, restart: false }),
    ).rejects.toEqual(new ExitError(1));

    expect(contexts).toHaveLength(1);
    expect(nodeVersionSatisfiesEngine).toHaveBeenCalled();
    expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "node-runtime-preflight",
      run: { admission: { owner: "candidate" } },
    });
    expectNoSideEffects(serviceStop, candidateValidation);
  });

  it("candidate admission: forces installed checks through the option before staging", async () => {
    const { stages, contexts } = await prepareCandidateAdmissionFixture({
      marker: true,
      verdict: candidateAdmissionVerdict(),
      installed: true,
    });
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await expect(
      invokeUpdateCli({ admission: "installed", yes: true, json: true, restart: false }),
    ).rejects.toEqual(new ExitError(1));

    expect(stages).toEqual([]);
    expect(contexts).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "node-runtime-preflight",
      run: { admission: { owner: "installed", fallbackReason: "forced-installed" } },
    });
    expectNoSideEffects(serviceStop, candidateValidation);
  });

  it("candidate admission: refuses managed ancestry before spawning candidate code and disposes staging", async () => {
    const { pkgRoot, stages, contexts } = await prepareCandidateAdmissionFixture({
      marker: true,
      verdict: candidateAdmissionVerdict(),
    });
    primeServiceCommand(["node", path.join(pkgRoot, "dist", "index.js"), "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, gatewayFixturePid]));
    vi.mocked(defaultRuntime.writeJson).mockImplementation((value) => {
      if (isRecord(value) && value.status === "error") {
        expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
      }
    });

    await expect(
      withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, () =>
        invokeUpdateCli({ admission: "auto", yes: true, json: true }),
      ),
    ).rejects.toEqual(new ExitError(1));

    expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
    expect(contexts).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "managed-service-preflight",
    });
    expectNoSideEffects(spawn, serviceStop, serviceStart, serviceRestart, candidateValidation);
  });

  it("candidate admission: keeps dry-run on installed checks without staging", async () => {
    const { stages, contexts } = await prepareCandidateAdmissionFixture({
      marker: true,
      verdict: candidateAdmissionVerdict(),
    });
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await invokeUpdateCli({ admission: "auto", yes: true, json: true, dryRun: true });

    expect(stages).toEqual([]);
    expect(contexts).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      failures: expect.arrayContaining([
        expect.objectContaining({ reason: "node-runtime-preflight" }),
      ]),
    });
    expectNoSideEffects(serviceStop, candidateValidation);
  });

  it("refuses an incompatible package target before service stop or install", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-refusal"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 9 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "agent",
          path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
          agentId: "main",
          foundVersion: 11,
          supportedVersion: 9,
          writerAppVersion: "2026.7.2",
        },
      ],
      indeterminate: [],
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalledWith({
      // The inspection snapshot retains the scoped marker after the updater
      // restores process.env on refusal.
      env: { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      supportedVersions: { state: 3, agent: 9 },
      configuredAgentDatabaseTargets: [],
      configuredAgentDatabaseCandidatePaths: [
        path.join(profileStateDir(), "agents", "main", "agent", "openclaw-agent.sqlite"),
      ],
    });
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "agent database (agent main)",
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(listUpdateRuns({ limit: 1 })).toMatchObject([
      { trigger: "cli", phase: "finished", status: "failed", reason: "database-schema-preflight" },
    ]);
  });

  it("refuses incompatible managed-state schemas before stopping the package service", async () => {
    const { pkgRoot } = await setupInstalledPackageRoot(createCaseDir("schema-package"), "1.0.0");
    const entrypoint = path.join(pkgRoot, "dist", "index.js");
    const nodeRunner = path.join(fixtureRoot, "managed", "node");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    mockOwnedGitService(pkgRoot);
    primeServiceCommand([nodeRunner, entrypoint, "gateway", "run"], {
      OPENCLAW_STATE_DIR: profileStateDir(),
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) =>
      env?.OPENCLAW_STATE_DIR === profileStateDir()
        ? {
            incompatible: [
              {
                kind: "agent",
                path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
                foundVersion: 12,
                supportedVersion: 11,
              },
            ],
            indeterminate: [],
          }
        : { incompatible: [], indeterminate: [] },
    );

    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19999" }, async () => {
      await expect(updateCommand({ yes: true, json: true, timeout: "17" })).rejects.toEqual(
        new ExitError(1),
      );
    });

    expect(serviceStop).not.toHaveBeenCalled();
    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.calls[1]?.[0].env).toEqual(
      expect.objectContaining({ OPENCLAW_STATE_DIR: profileStateDir() }),
    );
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(freshRestartCalls()).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "database-schema-preflight",
    });
    expect(getTriageFailures()).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining("openclaw-agent.sqlite"),
        result: expect.objectContaining({
          reason: "database-schema-preflight",
          steps: [
            expect.objectContaining({
              name: "database-schema-preflight",
              exitCode: 1,
              failureFacts: [
                expect.objectContaining({
                  check: "database-schema-preflight",
                  code: "database-schema-preflight",
                }),
              ],
            }),
          ],
        }),
      }),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("blocks package updates when the target requires a newer Node runtime", async () => {
    // This case specifies system-runtime guidance, independent of the host Node manager.
    vi.spyOn(versionManagerPath, "resolveNodeVersionManager").mockReturnValue("system");
    const root = await mockPackageInstallAtCaseDir();
    primeNpmChannelTag("latest", "2026.3.23-2");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ target: "latest", version: "2026.3.23-2" }),
    );
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await expect(updateCommand({ admission: "installed", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(updateGitCheckout, defaultRuntime.exit);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]?.reason).toBe("node-runtime-preflight");
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      `openclaw@2026.3.23-2 requires Node >=22.19.0; selected runtime is Node ${process.versions.node}.\n${runtimeRecovery.expectedPlainRecovery("2026.3.23-2", "24.16.0", "absent", undefined, root)}`,
    );
  });
}
