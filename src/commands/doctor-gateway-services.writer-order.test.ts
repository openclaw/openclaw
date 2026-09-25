import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../config/config.js";
import { readConfigFileSnapshot, type ConfigFileSnapshot } from "../config/config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { prepareWriterContext } from "./doctor-gateway-services.writer-order.test-support.js";

const service = vi.hoisted(() => ({
  readCommand: vi.fn(),
  install: vi.fn(),
  stage: vi.fn(),
  restart: vi.fn(),
  buildPlan: vi.fn(),
}));

// Start at the config-flow output contract. Snapshot validation, the registered
// gateway runner, and atomic config writes remain real; native effects are mocked.
vi.mock("./doctor-gateway-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-gateway-services.js")>()),
  maybeScanExtraGatewayServices: vi.fn(),
  maybeResolveDuelingSystemdGatewayScopes: vi.fn(),
}));
vi.mock("./doctor-foreign-launchd-jobs.js", () => ({ noteMacForeignLaunchdJobs: vi.fn() }));
vi.mock("./doctor-platform-notes.js", () => ({
  noteMacLaunchAgentOverrides: vi.fn(),
  noteMacStaleOpenClawUpdateLaunchdJobs: vi.fn(),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn(),
}));
vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    ...service,
    readDefinitionMutationCapability: async () => ({ kind: "writable" }),
  }),
}));
vi.mock("../daemon/service-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-audit.js")>()),
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
vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: service.buildPlan,
}));

describe("Doctor gateway config writer ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["success", "validation-refusal", "service-failure", "post-commit-failure"])(
    "uses Doctor's persisted baseline through service repair (%s)",
    async (outcome) => {
      await withDoctorConfigPreflightHome(async (home) => {
        vi.spyOn(os, "userInfo").mockReturnValue({
          homedir: home,
          username: "doctor-fixture",
          uid: process.getuid?.() ?? 1000,
          gid: process.getgid?.() ?? 1000,
          shell: "/bin/sh",
        });
        await withEnvAsync(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            BROWSER_BIN: "/opt/example/browser-planning",
            OPENCLAW_PROFILE: undefined,
            OPENCLAW_NIX_MODE: undefined,
            OPENCLAW_CONFIG_READONLY: undefined,
            OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
            OPENCLAW_SUPERVISOR_MODE: undefined,
            OPENCLAW_SERVICE_KIND: undefined,
            OPENCLAW_SYSTEMD_UNIT: undefined,
            OPENCLAW_LAUNCHD_LABEL: undefined,
            OPENCLAW_WINDOWS_TASK_NAME: undefined,
            OPENCLAW_UPDATE_IN_PROGRESS: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_PORT: undefined,
            OPENCLAW_WRAPPER: undefined,
            KUBERNETES_SERVICE_HOST: undefined,
            KUBERNETES_SERVICE_PORT: undefined,
          },
          async () => {
            const configPath = await writeOpenClawConfig(home, {
              browser: { executablePath: "${BROWSER_BIN}" },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            expect(isDefaultInstallIdentity()).toBe(true);
            const ctx = await prepareWriterContext(configPath);
            ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19090 } };
            await withEnvAsync({ BROWSER_BIN: "/opt/example/browser-first" }, async () => {
              expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
            });
            expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
            const initialBytes = await fs.readFile(configPath, "utf8");
            expect(JSON.parse(initialBytes).browser.executablePath).toBe("${BROWSER_BIN}");
            const initialBackup = await fs.readFile(`${configPath}.bak`, "utf8");
            const persistedBeforeService = ctx.cfgForPersistence;

            const programArguments = [process.execPath, path.join(home, "openclaw.mjs"), "gateway"];
            service.readCommand.mockResolvedValue({
              programArguments,
              environment: { OPENCLAW_GATEWAY_TOKEN: "recovered-fixture-token" },
            });
            service.buildPlan.mockResolvedValue({ programArguments, environment: {} });
            let installedSnapshot: ConfigFileSnapshot | undefined;
            let installedBaseline: typeof ctx.cfg | undefined;
            service.install.mockImplementation(async () => {
              installedSnapshot = await readConfigFileSnapshot();
              installedBaseline = structuredClone(ctx.cfgForPersistence);
              if (outcome === "service-failure") {
                throw new Error("fixture service install failed");
              }
            });
            if (outcome === "validation-refusal") {
              // Port zero reaches the real writer's schema refusal, not an earlier service guard.
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 0 } };
            }
            const candidateBeforeService = ctx.cfg;
            ctx.prompter.confirmRuntimeRepair = async () => true;
            if (outcome === "post-commit-failure") {
              const actualTransform = configModule.transformConfigFile;
              const failure = new ConfigWritePostCommitError({
                configPath,
                rollbackStatus: "not-restored",
                cause: new Error("fixture post-write failure"),
              });
              vi.spyOn(configModule, "transformConfigFile").mockImplementationOnce(
                async (...args) => {
                  await actualTransform(...args);
                  throw failure;
                },
              );
              await expect(runGatewayServicesHealth(ctx)).rejects.toBe(failure);
              expect(ctx.configWriteError).toBe(failure);
              expect(service.install).not.toHaveBeenCalled();
              expect(service.stage).not.toHaveBeenCalled();
              expect(service.restart).not.toHaveBeenCalled();
              const committed = await fs.readFile(configPath, "utf8");
              const backup = await fs.readFile(`${configPath}.bak`, "utf8");
              expect(JSON.parse(committed).gateway.auth.token).toBe("recovered-fixture-token");
              // A later contribution must not retry a context whose publication failed.
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19092 } };
              await expect(runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).rejects.toBe(
                failure,
              );
              expect(await fs.readFile(configPath, "utf8")).toBe(committed);
              expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
              return;
            }
            await withEnvAsync({ BROWSER_BIN: "/opt/example/browser-service" }, async () => {
              await runGatewayServicesHealth(ctx);
            });

            if (outcome === "validation-refusal") {
              expect(ctx.configWriteRefusal).toBe("validation");
              expect(ctx.cfg).toBe(candidateBeforeService);
              expect(ctx.cfgForPersistence).toBe(persistedBeforeService);
              expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
              expect(service.install).not.toHaveBeenCalled();
              expect(ctx.runtime.error).toHaveBeenCalledWith(
                expect.stringContaining(
                  "Failed to persist gateway.auth.token before service repair",
                ),
              );
              expect(await fs.readFile(configPath, "utf8")).toBe(initialBytes);
              expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(initialBackup);
            } else {
              expect(service.install).toHaveBeenCalledOnce();
              expect(installedSnapshot?.valid).toBe(true);
              expect(installedSnapshot?.sourceConfig.gateway?.auth?.token).toBe(
                "recovered-fixture-token",
              );
              expect(installedSnapshot?.sourceConfig.browser?.executablePath).toBe(
                "/opt/example/browser-service",
              );
              expect(installedBaseline).toEqual(ctx.cfg);
              expect(ctx.configWriteRefusal).toBeUndefined();
              expect(ctx.cfg.gateway?.auth?.token).toBe("recovered-fixture-token");
              expect(ctx.cfg).toEqual(ctx.cfgForPersistence);
              if (outcome === "service-failure") {
                expect(ctx.runtime.error).toHaveBeenCalledWith(
                  "Gateway service update failed: Error: fixture service install failed",
                );
              }
            }
            expect(service.stage).not.toHaveBeenCalled();
            expect(service.restart).not.toHaveBeenCalled();
            if (outcome !== "validation-refusal") {
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19091 } };
              await withEnvAsync({ BROWSER_BIN: "/opt/example/browser-final" }, async () => {
                expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
                const snapshot = await readConfigFileSnapshot();
                expect(snapshot.sourceConfig.browser?.executablePath).toBe(
                  "/opt/example/browser-final",
                );
                expect(snapshot.sourceConfig.gateway?.auth?.token).toBe("recovered-fixture-token");
                expect(ctx.configResult.confirmedConfigSource?.hash).toBe(snapshot.hash);
              });
            }
            const finalBytes = await fs.readFile(configPath, "utf8");
            expect(JSON.parse(finalBytes).browser.executablePath).toBe("${BROWSER_BIN}");
            const finalBackup = await fs.readFile(`${configPath}.bak`, "utf8");
            expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(
              outcome !== "validation-refusal",
            );
            expect(await fs.readFile(configPath, "utf8")).toBe(finalBytes);
            expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(finalBackup);
          },
        );
      });
    },
  );

  it.each([
    { parent: "legacy writable", defer: undefined, expectedVersion: "2026.5.16-beta.4" },
    { parent: "explicit deferral", defer: "1", expectedVersion: VERSION },
  ])("preserves update recovery bytes for a $parent parent", async ({ defer, expectedVersion }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_NIX_MODE: undefined,
          OPENCLAW_CONFIG_READONLY: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: defer,
        },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            meta: { lastTouchedVersion: "2026.5.16-beta.4" },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const originalBytes = await fs.readFile(configPath, "utf8");
          const preUpdatePath = `${configPath}.pre-update`;
          await fs.writeFile(preUpdatePath, originalBytes);
          const ctx = await prepareWriterContext(configPath);
          expect(ctx.configResult.sourceLastTouchedVersion).toBe("2026.5.16-beta.4");
          const initialBaseline = ctx.cfgForPersistence;
          ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19090 } };

          await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });

          const committedBytes = await fs.readFile(configPath, "utf8");
          expect(JSON.parse(committedBytes)).toMatchObject({
            meta: { lastTouchedVersion: expectedVersion },
            gateway: { port: 19090 },
          });
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          expect(snapshot.sourceConfig.meta?.lastTouchedVersion).toBe(expectedVersion);
          expect(snapshot.sourceConfig.gateway?.port).toBe(19090);
          expect(ctx.cfgForPersistence).not.toBe(initialBaseline);
          expect(ctx.cfgForPersistence).toEqual(ctx.cfg);
          expect(ctx.cfgForPersistence.gateway?.port).toBe(19090);
          expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(originalBytes);
          expect(await fs.readFile(preUpdatePath, "utf8")).toBe(originalBytes);

          await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
          expect(await fs.readFile(configPath, "utf8")).toBe(committedBytes);
          expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(originalBytes);
          expect(await fs.readFile(preUpdatePath, "utf8")).toBe(originalBytes);
        },
      );
    });
  });

  it("refuses mixed include repairs before service changes after an earlier config commit", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      vi.spyOn(os, "userInfo").mockReturnValue({
        homedir: home,
        username: "doctor-fixture",
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
        shell: "/bin/sh",
      });
      await withEnvAsync(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_NIX_MODE: undefined,
          OPENCLAW_CONFIG_READONLY: undefined,
          OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
          OPENCLAW_SUPERVISOR_MODE: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
          OPENCLAW_SYSTEMD_UNIT: undefined,
          OPENCLAW_LAUNCHD_LABEL: undefined,
          OPENCLAW_WINDOWS_TASK_NAME: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_PORT: undefined,
          OPENCLAW_WRAPPER: undefined,
          KUBERNETES_SERVICE_HOST: undefined,
          KUBERNETES_SERVICE_PORT: undefined,
        },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            browser: { $include: "./browser.json" },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const includePath = path.join(path.dirname(configPath), "browser.json");
          await fs.writeFile(includePath, JSON.stringify({ enabled: true }));
          await fs.writeFile(`${includePath}.bak`, JSON.stringify({ enabled: false }));
          const originalBytes = await fs.readFile(configPath, "utf8");
          expect(isDefaultInstallIdentity()).toBe(true);
          const ctx = await prepareWriterContext(configPath);
          ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19090 } };
          await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
          expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(originalBytes);
          const persistedBaseline = ctx.cfgForPersistence;
          const retainedPaths = [
            configPath,
            `${configPath}.bak`,
            includePath,
            `${includePath}.bak`,
          ];
          const retainedBytes = await Promise.all(
            retainedPaths.map((file) => fs.readFile(file, "utf8")),
          );

          ctx.cfg = { ...ctx.cfg, browser: { ...ctx.cfg.browser, enabled: false } };
          const candidateBeforeService = ctx.cfg;
          const programArguments = [process.execPath, path.join(home, "openclaw.mjs"), "gateway"];
          service.readCommand.mockResolvedValue({
            programArguments,
            environment: { OPENCLAW_GATEWAY_TOKEN: "recovered-fixture-token" },
          });
          service.buildPlan.mockResolvedValue({ programArguments, environment: {} });
          ctx.prompter.confirmRuntimeRepair = async () => true;

          await runGatewayServicesHealth(ctx);

          expect(ctx.configWriteRefusal).toBe("include-ownership");
          expect(ctx.cfg).toBe(candidateBeforeService);
          expect(ctx.cfgForPersistence).toBe(persistedBaseline);
          expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
          expect(service.install).not.toHaveBeenCalled();
          expect(service.stage).not.toHaveBeenCalled();
          expect(service.restart).not.toHaveBeenCalled();
          expect(ctx.runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to persist gateway.auth.token before service repair"),
          );
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          expect(snapshot.sourceConfig.gateway?.port).toBe(19090);
          expect(snapshot.sourceConfig.gateway?.auth?.token).toBeUndefined();
          expect(snapshot.sourceConfig.browser?.enabled).toBe(true);
          expect(await Promise.all(retainedPaths.map((file) => fs.readFile(file, "utf8")))).toEqual(
            retainedBytes,
          );
          expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(false);
          expect(await Promise.all(retainedPaths.map((file) => fs.readFile(file, "utf8")))).toEqual(
            retainedBytes,
          );
        },
      );
    });
  });
});
