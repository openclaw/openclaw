import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withDoctorConfigPreflightHome } from "../../commands/doctor-config-preflight.test-support.js";
import { prepareWriterContext } from "../../commands/doctor-gateway-services.writer-order.test-support.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { writeOpenClawConfig } from "../../config/test-helpers.js";
import { runWriteConfigHealth } from "../../flows/doctor-health-contribution-runners.config.js";
import { runGatewayServicesHealth } from "../../flows/doctor-health-contribution-runners.gateway.js";
import {
  captureUpdateDoctorConfigWrites,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  successfulPluginUpdate,
} from "./update-command-post-update.test-support.js";

const mocks = vi.hoisted(() => ({
  child: vi.fn<typeof import("../../process/exec.js").runExec>(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  install: vi.fn(),
  stage: vi.fn(),
  directRestart: vi.fn(),
  command: vi.fn(),
  state: vi.fn(),
  plan: vi.fn(),
}));

// Keep the finalizer, convergence, fresh-Doctor result consumer, config planner,
// writer and service-deferral policy real. Only subprocess/native/package effects
// are substituted; this is not delegated-executor or native installation proof.
vi.mock("../../commands/doctor-gateway-services.js", async (original) => ({
  ...(await original<typeof import("../../commands/doctor-gateway-services.js")>()),
  maybeScanExtraGatewayServices: vi.fn(),
  maybeResolveDuelingSystemdGatewayScopes: vi.fn(),
}));
vi.mock("../../commands/doctor-platform-notes.js", () => ({
  noteMacLaunchAgentOverrides: vi.fn(),
  noteMacStaleOpenClawUpdateLaunchdJobs: vi.fn(),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn(),
}));
vi.mock("../../commands/doctor-foreign-launchd-jobs.js", () => ({
  noteMacForeignLaunchdJobs: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.state,
  resolveGatewayService: () => ({
    readCommand: mocks.command,
    install: mocks.install,
    stage: mocks.stage,
    restart: mocks.directRestart,
    readDefinitionMutationCapability: async () => ({ kind: "writable" }),
  }),
}));
vi.mock("../../daemon/service-audit.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service-audit.js")>()),
  auditGatewayServiceConfig: async () => ({
    ok: false,
    issues: [
      {
        code: "gateway-token-embedded",
        message: "Gateway service contains an embedded token.",
        level: "recommended",
      },
    ],
  }),
}));
vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.plan,
}));
vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
vi.mock("../../process/exec.js", async (original) => ({
  ...(await original<typeof import("../../process/exec.js")>()),
  runExec: vi.fn<typeof import("../../process/exec.js").runExec>((command, args, options) => {
    if (args[1] === "doctor") {
      return mocks.child(command, args, options);
    }
    expect(args.slice(1)).toEqual(["config", "validate", "--json"]);
    return Promise.resolve({ stdout: "", stderr: "" });
  }),
}));
vi.mock("./progress.js", () => ({ printResult: vi.fn() }));
vi.mock("../../commands/doctor-completion.js", async (original) => ({
  ...(await original<typeof import("../../commands/doctor-completion.js")>()),
  checkShellCompletionStatus: vi.fn(async () => ({ shell: null })),
  ensureCompletionCacheExists: vi.fn(async () => true),
}));
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
}));
vi.mock("./update-command-config.js", async (original) => ({
  ...(await original<typeof import("./update-command-config.js")>()),
  preparePostCorePluginConfig: async () => ({
    configSnapshot: await readConfigFileSnapshot(),
    configWriteOptions: {},
    configChanged: false,
    restoredAuthoredChannels: [],
  }),
}));
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: async () => ({ ...successfulPluginUpdate, changed: true }),
}));
vi.mock("./update-command-post-core.js", async (original) => ({
  ...(await original<typeof import("./update-command-post-core.js")>()),
  shouldResumePostCoreUpdateInFreshProcess: () => false,
}));
vi.mock("./update-command-post-plugin-readiness.js", () => ({
  applyPostPluginUpdateReadiness: async (params: { pluginUpdate: unknown }) => params.pluginUpdate,
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  revalidateManagedGatewayServiceAfterUpdate: async ({ root }: { root: string }) => ({
    kind: "owned",
    root,
    fingerprint: "writer-order-fixture",
    refreshDefinition: true,
  }),
}));
vi.mock("./update-command-result.js", async (original) => ({
  ...(await original<typeof import("./update-command-result.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: vi.fn(async () => undefined),
  writeControlPlaneUpdateRestartSentinelBestEffort: vi.fn(async () => undefined),
}));

describe("update finalization waits for Doctor's config owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it.each(["success", "validation-refusal", "service-failure"] as const)(
    "preserves actual committed bytes and the finalization barrier (%s)",
    async (outcome) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const identity = createManagedServiceIdentityFixture(home);
        try {
          await withEnvAsync(
            {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_UPDATE_IN_PROGRESS: undefined,
              OPENCLAW_CONFIG_READONLY: undefined,
              OPENCLAW_NIX_MODE: undefined,
              OPENCLAW_GATEWAY_TOKEN: undefined,
              OPENCLAW_GATEWAY_PASSWORD: undefined,
              OPENCLAW_WRAPPER: undefined,
            },
            async () => {
              const root = path.join(home, "candidate");
              await fs.mkdir(root);
              await fs.writeFile(
                path.join(root, "package.json"),
                JSON.stringify({ name: "openclaw", version: VERSION }),
              );
              await fs.mkdir(path.join(root, "dist"));
              await fs.writeFile(
                path.join(root, "dist", "index.js"),
                "// fixture entrypoint; transport is mocked\n",
              );
              const configPath = await writeOpenClawConfig(home, {
                gateway: { mode: "local" },
                plugins: { enabled: false },
              });
              const preUpdate = `${configPath}.pre-update`;
              const original = await fs.readFile(configPath, "utf8");
              await fs.writeFile(preUpdate, original);
              const ctx = await prepareWriterContext(configPath);
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19090 } };
              await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
              const paths = [configPath, `${configPath}.bak`, preUpdate];
              const bytes = () => Promise.all(paths.map((p) => fs.readFile(p, "utf8")));
              const initial = await bytes();
              const priorBaseline = ctx.cfgForPersistence;
              const argv = [process.execPath, path.join(root, "dist", "index.js"), "gateway"];
              mocks.command.mockResolvedValue({
                programArguments: argv,
                environment: { OPENCLAW_GATEWAY_TOKEN: "service-only-token" },
              });
              mocks.plan.mockResolvedValue({ programArguments: argv, environment: {} });
              mocks.state.mockResolvedValue(
                managedServiceState(process.env, {
                  programArguments: argv,
                  environment: Object.fromEntries(
                    Object.entries(process.env).filter(
                      (entry): entry is [string, string] => entry[1] !== undefined,
                    ),
                  ),
                }),
              );
              const entered = createDeferred();
              const release = createDeferred();
              const events: string[] = [];
              let committed: string[] | undefined;
              let childCompleted = false;
              mocks.child.mockImplementation(async (_command, args, options) => {
                if (!options || typeof options === "number") {
                  throw new Error("Doctor must supply its child environment");
                }
                expect(args).toContain("doctor");
                expect(options.env?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
                expect(options.env?.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
                return withEnvAsync(options.env ?? {}, async () => {
                  ctx.prompter.confirmRuntimeRepair = async () => true;
                  await runGatewayServicesHealth(ctx);
                  expect(mocks.install).not.toHaveBeenCalled();
                  expect(mocks.stage).not.toHaveBeenCalled();
                  expect(mocks.directRestart).not.toHaveBeenCalled();
                  expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
                  ctx.cfg = {
                    ...ctx.cfg,
                    gateway: {
                      ...ctx.cfg.gateway,
                      port: outcome === "validation-refusal" ? 0 : 19091,
                      auth: { mode: "token", token: "doctor-owned-token" },
                    },
                  };
                  entered.resolve();
                  await release.promise;
                  const persisted = await captureUpdateDoctorConfigWrites(
                    configPath,
                    async (capture) => {
                      const result = await runWriteConfigHealth(ctx, {
                        runPostWriteRepairs: false,
                      });
                      await writeUpdatePostInstallDoctorResult({
                        resultPath: options.env![UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]!,
                        result: {
                          status: result ? "ok" : "error",
                          configHash: capture.hash,
                          configWriteRefusal: capture.configWriteRefusal,
                        },
                      });
                      return result;
                    },
                  );
                  events.push(persisted ? "doctor-committed" : "doctor-refused");
                  committed = await bytes();
                  childCompleted = true;
                  if (!persisted) {
                    throw Object.assign(new Error("Doctor config write refused"), {
                      failed: true,
                      exitCode: 1,
                      stdout: "",
                      stderr: "Doctor config write refused",
                    });
                  }
                  return { stdout: "", stderr: "" };
                });
              });
              mocks.restart.mockImplementation(async () => {
                expect(childCompleted).toBe(true);
                expect(await bytes()).toEqual(committed);
                expect((await readConfigFileSnapshot()).sourceConfig.gateway?.auth?.token).toBe(
                  "doctor-owned-token",
                );
                events.push("service");
                if (outcome === "service-failure") {
                  throw new Error("fixture finalization service failed");
                }
                return "ok";
              });
              const finishing = finishSuccessfulPackageSwitch(
                { packageRoot: root, restartEnvironment: process.env },
                { configSnapshot: await readConfigFileSnapshot() },
              );
              // Attach rejection handling immediately; release the child even if the barrier assertion fails.
              const settled = finishing.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
              );
              try {
                await Promise.race([
                  entered.promise,
                  settled.then((result) => {
                    throw new Error(`finalizer never reached Doctor: ${JSON.stringify(result)}`);
                  }),
                ]);
                expect(mocks.restart).not.toHaveBeenCalled();
                expect(await bytes()).toEqual(initial);
              } finally {
                release.resolve();
              }
              const result = await settled;
              expect(mocks.child).toHaveBeenCalledOnce();
              if (outcome === "validation-refusal") {
                expect(result.ok).toBe(false);
                expect(events).toEqual(["doctor-refused"]);
                expect(ctx.configWriteRefusal).toBe("validation");
                expect(ctx.cfgForPersistence).toBe(priorBaseline);
                expect(mocks.restart).not.toHaveBeenCalled();
                expect(await bytes()).toEqual(initial);
              } else {
                expect(result.ok).toBe(outcome === "success");
                expect(events).toEqual(["doctor-committed", "service"]);
                expect(mocks.restart).toHaveBeenCalledOnce();
                expect(ctx.cfgForPersistence.gateway?.auth?.token).toBe("doctor-owned-token");
                expect((await bytes())[2]).toBe(original);
              }
              expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(
                outcome !== "validation-refusal",
              );
              expect(await bytes()).toEqual(committed);
            },
          );
        } finally {
          identity.restore();
        }
      });
    },
  );
});
