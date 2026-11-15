import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as versionManagerPath from "../../shared/version-manager-path.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  commandTransport,
  managedUpdateHandoff,
  serviceReadRuntime,
} from "../update-cli-mocks.test-support.js";
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
    runUpdateFailureTriage,
    expectNoSideEffects,
  } = f;

  // Failure assertions must not render the triage target's inherited environment.
  const getTriageFailures = () =>
    vi.mocked(runUpdateFailureTriage).mock.calls.map(([call]) => call.failure);

  const { prepareCandidateAdmissionFixture, candidateAdmissionVerdict } =
    createCandidateAdmissionFixtures(f);
  const prepare = () =>
    prepareCandidateAdmissionFixture({ marker: true, verdict: candidateAdmissionVerdict() });
  const update = (options: Parameters<typeof invokeUpdateCli>[0] = {}) =>
    invokeUpdateCli({ admission: "auto", yes: true, restart: false, json: true, ...options });
  const expectDisposed = (stages: string[]) => {
    expect(stages).toHaveLength(1);
    expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
  };
  const expectVersion = async (root: string, version: string) =>
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version,
    });
  const schemaTarget = (
    schemaVersions = { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
  ) =>
    vi
      .mocked(fetchNpmPackageTargetStatus)
      .mockResolvedValue(packageTargetStatus({ schemaVersions }));
  const rejectSchema = () =>
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        { kind: "agent", path: "/fixture/agent.sqlite", foundVersion: 11, supportedVersion: 9 },
      ],
      indeterminate: [],
    });
  async function useRealConfigRead() {
    const { createConfigIO } = await import("../../config/io.js");
    vi.mocked(readConfigFileSnapshot).mockImplementation(() =>
      createConfigIO({ observe: false, pluginValidation: "skip" }).readConfigFileSnapshot(),
    );
  }

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
      await useRealConfigRead();
      schemaTarget();
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
      const databasePath = resolveOpenClawStateSqlitePath(env);
      expect(fsSync.existsSync(databasePath)).toBe(false);
      await withEnvAsync(env, async () => {
        const updating = update({ tag: path.join(stateDir, "candidate.tgz") });
        if (refused) {
          await expect(updating).rejects.toEqual(new ExitError(1));
        } else {
          await updating;
        }
      });

      expectDisposed(stages);
      expect(contexts).toHaveLength(marker ? 1 : 0);
      expect(databaseExistsAtAdmission).toEqual(marker ? [false] : []);
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      if (refused) {
        expect(events).toEqual(["admission"]);
        expect(fsSync.existsSync(databasePath)).toBe(false);
        expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "invalid-config" });
        expectNoSideEffects(candidateValidation, replaceConfigFile, serviceStop);
        await expectVersion(pkgRoot, "1.0.0");
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

  it.each([
    { source: "candidate", check: "database-schema" },
    { source: "unsupported", check: "config" },
    { source: "fallback", check: "node-runtime" },
  ] as const)(
    "candidate admission: reports $check refusals from $source before mutation",
    async ({ source, check }) => {
      if (check === "node-runtime") {
        runtimeRecovery.stubNodeRuntime();
      }
      const verdict = candidateAdmissionVerdict(check);
      const { pkgRoot, stages } = await prepareCandidateAdmissionFixture({
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
        schemaTarget({ state: 3, agent: 9 });
        rejectSchema();
      } else {
        nodeVersionSatisfiesEngine.mockReturnValue(false);
      }
      vi.mocked(defaultRuntime.writeJson).mockImplementation((value) => {
        if (isRecord(value) && value.status === "error") {
          expectDisposed(stages);
        }
      });

      await expect(
        update({
          ...(source === "fallback" ? { tag: path.join(pkgRoot, "candidate.tgz") } : {}),
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
      await expectVersion(pkgRoot, "1.0.0");
      expect(stages).toHaveLength(1);
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
        expect(run.steps).toContainEqual(
          expect.objectContaining({ step: "candidate-admission", status: "failed" }),
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

  it.each([undefined, "17"])(
    "candidate admission: retains work deadline %s and installed Node preflight",
    async (timeout) => {
      runtimeRecovery.stubNodeRuntime();
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
      const { pkgRoot, stages } = await prepareCandidateAdmissionFixture({
        marker: true,
        verdict,
        pendingLifecycle: true,
      });
      schemaTarget({ state: 3, agent: 9 });
      rejectSchema();
      pluginAvailabilityPreflight.mockRejectedValue(
        new Error("Installed plugin catalog is stale."),
      );

      // Freeze only activation time; SQLite workers share real wall-clock deadlines.
      vi.spyOn(performance, "now").mockReturnValue(performance.now());
      await update({ timeout });

      const timeoutMs = timeout === undefined ? undefined : 17_000;
      expect(packageInstallCommandCall()?.[1].timeoutMs).toBe(timeoutMs);

      const lifecycleCommands = commandTransport.run.mock.calls.filter(([argv]) =>
        /(?:preinstall-package-manager-warning|postinstall-bundled-plugins)\.mjs$/.test(
          argv[1] ?? "",
        ),
      );
      expect(lifecycleCommands).toHaveLength(2);
      expect(
        lifecycleCommands.map(([, options]) =>
          typeof options === "number" ? options : options.timeoutMs,
        ),
      ).toEqual([timeoutMs, timeoutMs]);

      expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).not.toHaveBeenCalled();
      expect(nodeVersionSatisfiesEngine).toHaveBeenCalled();
      expect(pluginAvailabilityPreflight).not.toHaveBeenCalled();
      await expectVersion(pkgRoot, "9999.0.0");
      expectDisposed(stages);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "ok",
        run: {
          admission: { owner: "candidate", checks: verdict.facts.checks },
          origin: { candidateAdmission: verdict },
        },
      });
      expect(getErrorOutput()).toContain(verdict.warnings[0]!.message);
    },
  );

  it.each(["existing", "fresh"] as const)(
    "keeps installed runtime admission authoritative (%s profile)",
    async (profile) => {
      runtimeRecovery.stubNodeRuntime();
      const verdict = candidateAdmissionVerdict();
      verdict.facts.nodeEngines = ">=26.12.1";
      verdict.facts.checks[2] = {
        name: "node-runtime",
        status: "warn",
        detail: "Candidate requires Node >=26.12.1; selected runtime is Node 24.20.0.",
      };
      const { pkgRoot, stages, contexts, events } = await prepareCandidateAdmissionFixture({
        marker: true,
        verdict,
        nodeEngine: ">=26.12.1",
      });
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({
          nodeEngine: ">=26.12.1",
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
          expect(engine).toBe(">=26.12.1");
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
        await useRealConfigRead();
      }
      const updating = withEnvAsync(env, () =>
        update(
          profile === "fresh" ? { tag: path.join(env.OPENCLAW_STATE_DIR!, "candidate.tgz") } : {},
        ),
      );
      if (profile === "existing") {
        await expect(updating).rejects.toEqual(new ExitError(1));
        expect(recoverNode).not.toHaveBeenCalled();
        expect(stages).toEqual([]);
        expect(contexts).toEqual([]);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "preflight-node-runtime-incompatible",
        });
        return;
      }
      await updating;

      expect(recoverNode).toHaveBeenCalledOnce();
      expect(events).toContain("runtime-provision");
      expect(events.indexOf("admission")).toBeLessThan(events.indexOf("runtime-recovery"));
      expectDisposed(stages);
      await expectVersion(pkgRoot, "9999.0.0");
      expect(lastWriteJsonCall()).toMatchObject({
        status: "ok",
        run: { admission: { owner: "candidate" }, origin: { candidateAdmission: verdict } },
      });
      expect(candidateValidation).toHaveBeenCalledWith(
        expect.objectContaining({ nodeRunner: recoveredNode }),
      );
    },
  );

  it("candidate admission: leaves an accepted Gateway handoff pending after disposing staging", async () => {
    const { pkgRoot, stages, contexts } = await prepare();
    primeServiceCommand(["node", path.join(pkgRoot, "dist", "index.js"), "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "running", pid: gatewayFixturePid });
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, gatewayFixturePid, 1]));
    managedUpdateHandoff.start.mockResolvedValue({
      status: "started",
      handoffId: "candidate-handoff",
      installRoot: pkgRoot,
      logPath: path.join(pkgRoot, "handoff.log"),
      command: "openclaw update --yes",
      pid: 12345,
    });
    managedUpdateHandoff.transfer.mockResolvedValue(true);

    await update({ restart: undefined });

    expect(managedUpdateHandoff.transfer).toHaveBeenCalled();
    expectDisposed(stages);
    expect(contexts).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "skipped",
      reason: "managed-service-handoff-started",
    });
    expect(process.exitCode).toBe(75);
    expect(listUpdateRuns({ limit: 1 })[0]).toMatchObject({ status: "running" });
    expect(getTriageFailures()).toEqual([]);
    expectNoSideEffects(serviceStop, serviceStart, serviceRestart, candidateValidation);
  });

  it("candidate admission: stages the package with the managed service Node on PATH", async () => {
    const { pkgRoot, stages } = await prepare();
    const serviceNode = path.join(makeTempDir("candidate-service-node-"), "bin", "node");
    primeServiceCommand([serviceNode, path.join(pkgRoot, "dist", "index.js"), "gateway", "run"]);

    await update().catch(() => undefined);

    expect(stages).toHaveLength(1);
    const [, options] = expectDefined(packageInstallCommandCall(), "staged package install");
    const env = options.env as NodeJS.ProcessEnv | undefined;
    expect(env?.PATH?.split(path.delimiter)[0]).toBe(path.dirname(serviceNode));
  });

  it("candidate admission: refuses managed ancestry before spawning candidate code and disposes staging", async () => {
    const { pkgRoot, stages, contexts } = await prepare();
    primeServiceCommand(["node", path.join(pkgRoot, "dist", "index.js"), "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, gatewayFixturePid]));
    vi.mocked(defaultRuntime.writeJson).mockImplementation((value) => {
      if (isRecord(value) && value.status === "error") {
        expect(stages.every((root) => !fsSync.existsSync(root))).toBe(true);
      }
    });

    await expect(
      withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, () => update({ restart: undefined })),
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
    runtimeRecovery.stubNodeRuntime();
    const { stages, contexts } = await prepare();
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await update({ restart: undefined, dryRun: true });

    expect(stages).toEqual([]);
    expect(contexts).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      failures: expect.arrayContaining([
        expect.objectContaining({ reason: "preflight-node-runtime-incompatible" }),
      ]),
    });
    expectNoSideEffects(serviceStop, candidateValidation);
  });

  it("refuses incompatible shared caller and managed schemas before stopping the package service", async () => {
    const { pkgRoot } = await setupInstalledPackageRoot(createCaseDir("schema-package"), "1.0.0");
    const entrypoint = path.join(pkgRoot, "dist", "index.js");
    const nodeRunner = path.join(fixtureRoot, "managed", "node");
    const managedState = profileStateDir();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    mockOwnedGitService(pkgRoot);
    primeServiceCommand([nodeRunner, entrypoint, "gateway", "run"], {
      OPENCLAW_STATE_DIR: managedState,
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) =>
      env?.OPENCLAW_STATE_DIR === managedState
        ? {
            incompatible: [
              {
                kind: "agent",
                path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
                agentId: "main",
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
    const refusal = lastWriteJsonCall();
    expect(isRecord(refusal) ? refusal.reason : undefined).toBe("database-schema-preflight");
    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: managedState }),
      }),
    );
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(freshRestartCalls()).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart);
    expect(refusal).toMatchObject({ status: "error" });
    expect(listUpdateRuns({ limit: 1 })).toMatchObject([
      { trigger: "cli", phase: "finished", status: "failed", reason: "database-schema-preflight" },
    ]);
    expect(listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "agent database (agent main)",
    );
    expect(getTriageFailures()).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining("openclaw-agent.sqlite"),
        result: expect.objectContaining({ reason: "database-schema-preflight" }),
      }),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("blocks package updates when the target requires a newer Node runtime", async () => {
    runtimeRecovery.stubNodeRuntime();
    // This case specifies system-runtime guidance, independent of the host Node manager.
    vi.spyOn(versionManagerPath, "resolveNodeVersionManager").mockReturnValue("system");
    const { pkgRoot: root, stages, contexts } = await prepare();
    primeNpmChannelTag("latest", "2026.3.23-2");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ version: "2026.3.23-2" }),
    );
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await expect(updateCommand({ admission: "installed", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(updateGitCheckout, defaultRuntime.exit);
    expectNoSideEffects(serviceStop, candidateValidation);
    expect(stages).toEqual([]);
    expect(contexts).toEqual([]);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]?.reason).toBe("preflight-node-runtime-incompatible");
    const refusal = "Failing check node-runtime (node-runtime-preflight); key engines.node: ";
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      [
        `${refusal}Required: openclaw@2026.3.23-2 Node >=22.19.0; detected: Node ${process.versions.node} at ${process.execPath}`,
        `${refusal}Update install root: ${fsSync.realpathSync(root)}`,
        `${refusal}Update binary: ${path.join(root, "openclaw.mjs")}`,
        `${refusal}Gateway install root: unresolved`,
        `${refusal}${runtimeRecovery.expectedPlainRecovery("2026.3.23-2", "24.16.0", "absent", undefined, root)}`,
        `Updater Node ${process.versions.node} at ${process.execPath}.`,
        "PATH Node: not found.",
      ].join("\n"),
    );
  });
}
