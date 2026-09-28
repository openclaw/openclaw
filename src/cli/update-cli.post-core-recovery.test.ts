import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import {
  expectNoSideEffects,
  gatewayCommandCall,
  getErrorOutput,
  getLogOutput,
  getTriageFailures,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  callGateway,
  loadInstalledPluginIndexInstallRecords,
  pathExists,
  readPackageVersion,
  restorePersistedInstalledPluginIndexIfCurrent,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceRestart,
  serviceStop,
  spawn,
  suspendScheduledTaskAutoStartForUpdate,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./update-cli-mocks.test-support.js";
import {
  continuePostCoreUpdateInFreshProcess,
  defaultRuntime,
  ExitError,
  makeOkUpdateResult,
  readConfigFileSnapshot,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonRestart,
  runExec,
  updateCommand,
} from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    configSnapshot,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockPackageInstallAtCaseDir,
    primeServiceCommand,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  it.each([false, true])(
    "keeps the candidate stopped through plugin convergence and only restarts the verified previous version after errors (previous plugin error: %s)",
    async (previousPluginError) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
      const root = await mockPackageInstallAtCaseDir();
      const entryPath = path.join(root, "dist", "index.js");
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(entryPath);
      serviceLoaded.mockResolvedValue(true);
      primeServiceCommand(
        ["node", entryPath, "gateway", "run"],
        undefined,
        resolveGatewayTaskScriptPath(process.env),
      );
      pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
      if (previousPluginError) {
        callGateway.mockImplementation(
          gatewayHealthResponse({
            server: { version: "1.0.0", connId: "previous-gateway", bootId: "previous-boot" },
            health: {
              ok: true,
              plugins: {
                errors: [{ id: "demo", origin: "global", activated: true, error: "load failed" }],
              },
            },
          }),
        );
      }
      const activations: Array<{ version: string; afterPlugin: boolean }> = [];
      const runFixtureCommand = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "staged package commands",
      );
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")) {
          const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
          activations.push({ version: manifest.version, afterPlugin: spawn.mock.calls.length > 0 });
        }
        return runFixtureCommand(argv, options);
      });
      spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
        const resultPath = (options as { env?: NodeJS.ProcessEnv }).env
          ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        if (!resultPath) {
          throw new Error("missing post-core result path");
        }
        queueMicrotask(() => {
          void fs.writeFile(
            resultPath,
            JSON.stringify({
              status: "error",
              changed: false,
              warnings: [
                {
                  pluginId: "demo",
                  reason: "missing-extension-entry: ./dist/index.js",
                  message:
                    'Plugin "demo" failed post-core payload smoke check (missing-extension-entry): ./dist/index.js',
                  guidance: ["Run openclaw update repair to retry post-update plugin repair."],
                },
              ],
              sync: {
                changed: false,
                switchedToBundled: [],
                switchedToNpm: [],
                warnings: [],
                errors: [],
              },
              npm: {
                changed: false,
                outcomes: [
                  {
                    pluginId: "demo",
                    status: "error",
                    message: "Plugin extension entry missing",
                  },
                ],
              },
              integrityDrifts: [],
            }),
            "utf-8",
          );
        });
        const child = new EventEmitter() as EventEmitter & {
          kill: () => boolean;
          once: EventEmitter["once"];
        };
        child.kill = vi.fn(() => {
          queueMicrotask(() => {
            child.emit("exit", null, "SIGTERM");
            child.emit("close", null, "SIGTERM");
          });
          return true;
        });
        return child;
      });

      await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
      platformSpy.mockRestore();

      expect(serviceStop).toHaveBeenCalled();
      expectNoSideEffects(serviceRestart, runDaemonRestart);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(getLogOutput()).not.toContain("Update Result: OK");
      expect(spawn).toHaveBeenCalled();
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
      const pluginStartOrder = requireValue(
        spawn.mock.invocationCallOrder[0],
        "plugin child start",
      );
      const starts = vi
        .mocked(runCommandWithTimeout)
        .mock.calls.flatMap(([argv], index) =>
          argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")
            ? [
                requireValue(
                  vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[index],
                  "gateway activation order",
                ),
              ]
            : [],
        );
      expect(starts.length).toBeGreaterThan(0);
      expect(activations.filter((entry) => !entry.afterPlugin)).toEqual([]);
      expect(activations.filter((entry) => entry.afterPlugin)).toEqual([
        { version: "1.0.0", afterPlugin: true },
      ]);
      expect(gatewayCommandCall(entryPath, "install")).toBeUndefined();
      expect(gatewayCommandCall(entryPath, "restart")?.[0]).toContain("--preserve-definition");
      expect(resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(
        pluginStartOrder,
      );
    },
  );

  it("passes pre-update plugin install records into the post-core update process", async () => {
    setupUpdatedRootRefresh({ admitMutation: true });
    const pluginInstallRecords = {
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath: "/tmp/openclaw-demo-plugin",
      },
    } as const;
    const preUpdateConfig = {
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
      },
    } as OpenClawConfig;
    let capturedRecords: unknown;
    let capturedSourceConfig: unknown;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot(preUpdateConfig, { resolved: baseConfig }),
    );
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(pluginInstallRecords);
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      const recordsPath = env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH;
      const sourceConfigPath = env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH;
      if (!recordsPath) {
        throw new Error("missing post-core install records path");
      }
      if (!sourceConfigPath) {
        throw new Error("missing post-core source config path");
      }
      capturedRecords = JSON.parse(fsSync.readFileSync(recordsPath, "utf-8"));
      capturedSourceConfig = JSON.parse(fsSync.readFileSync(sourceConfigPath, "utf-8"));
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });

    await updateCommand({ yes: true, restart: false });

    expect(capturedRecords).toEqual(pluginInstallRecords);
    expect(capturedSourceConfig).toEqual({
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
    expectNoSideEffects(syncPluginsForUpdateChannel, updateNpmInstalledPlugins);
  });

  it("clears stale npm resolution metadata before post-core downgrade resume", async () => {
    const { root } = setupUpdatedRootRefresh({
      admitMutation: true,
      targetVersion: "2026.4.29",
    });
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "2026.4.29" : "2026.5.28",
    );
    const preUpdateConfig = {
      plugins: {
        entries: {
          msteams: { enabled: false },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(preUpdateConfig));
    const pluginInstallRecords = {
      msteams: {
        source: "npm",
        spec: "@openclaw/msteams",
        installPath: "/tmp/openclaw-msteams-plugin",
        version: "2026.5.28",
        resolvedName: "@openclaw/msteams",
        resolvedVersion: "2026.5.28",
        resolvedSpec: "@openclaw/msteams@2026.5.28",
        integrity: "sha512-newer",
      },
    } as const;
    let capturedRecords: unknown;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(pluginInstallRecords);
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      const recordsPath = env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH;
      if (!recordsPath) {
        throw new Error("missing post-core install records path");
      }
      capturedRecords = JSON.parse(fsSync.readFileSync(recordsPath, "utf-8"));
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });

    await updateCommand({ yes: true, restart: false });

    expect(capturedRecords).toEqual({
      msteams: {
        source: "npm",
        spec: "@openclaw/msteams",
        installPath: "/tmp/openclaw-msteams-plugin",
        version: "2026.5.28",
        resolvedName: "@openclaw/msteams",
        integrity: "sha512-newer",
      },
    });
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledWith(
      capturedRecords,
      {
        config: preUpdateConfig,
        lease: expect.anything(),
      },
    );
    expect(restorePersistedInstalledPluginIndexIfCurrent).not.toHaveBeenCalled();
  });

  it.each(["spawn", "phase"])(
    "restores the exact plugin index revision when post-core %s fails",
    async (failureKind) => {
      const { root } = setupUpdatedRootRefresh({
        admitMutation: true,
        targetVersion: "2026.4.29",
        gatewayUpdateImpl: async (updatedRoot) =>
          makeOkUpdateResult({
            mode: "npm",
            root: updatedRoot,
            before: { version: "2026.5.28" },
            after: { version: "2026.4.29" },
          }),
      });
      readPackageVersion.mockImplementation(async (pkgRoot: string) =>
        pkgRoot === root ? "2026.4.29" : "2026.5.28",
      );
      const previousPersistedIndex = {
        policyHash: "previous-policy",
        installRecords: {
          msteams: {
            source: "npm",
            spec: "@openclaw/msteams",
            resolvedVersion: "2026.5.28",
          },
        } satisfies Record<string, PluginInstallRecord>,
      };
      writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
        previous: previousPersistedIndex as never,
        revision: 17,
      });
      loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(
        previousPersistedIndex.installRecords,
      );
      spawn.mockImplementationOnce((_node, _argv, options) => {
        if (failureKind === "spawn") {
          throw new Error("post-core spawn failed");
        }
        const child = new EventEmitter();
        fsSync.writeFileSync(
          options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH,
          JSON.stringify({
            status: "failed",
            error: "pre-plugin Doctor failed before convergence",
          }),
        );
        queueMicrotask(() => {
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        });
        return child;
      });

      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      expect(getTriageFailures()).toContainEqual(
        expect.objectContaining({
          error:
            failureKind === "spawn"
              ? "post-core spawn failed"
              : "pre-plugin Doctor failed before convergence",
          result: expect.objectContaining({
            status: "error",
            mode: "npm",
            root,
            before: { version: "2026.5.28" },
            after: { version: "2026.4.29" },
          }),
        }),
      );
      expect(defaultRuntime.exit).not.toHaveBeenCalled();

      expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledTimes(1);
      expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
        previousPersistedIndex,
        17,
        { lease: expect.anything() },
      );
    },
  );

  it("joins Windows taskkill after the committed post-core child closes", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    readPackageVersion.mockResolvedValueOnce(null);
    const helperStarted = createDeferred();
    const releaseHelper = createDeferred();
    let helperSettled = false;
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
    spawn.mockImplementationOnce((_node, _args, options) => {
      fsSync.writeFileSync(
        options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH,
        JSON.stringify({ status: "ok" }),
      );
      return child;
    });
    vi.mocked(runExec).mockImplementationOnce(async (command, args) => {
      expect(command).toMatch(/taskkill\.exe$/);
      expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
      helperStarted.resolve();
      await releaseHelper.promise;
      helperSettled = true;
      return { stdout: "", stderr: "" };
    });
    const updating = continuePostCoreUpdateInFreshProcess({
      root: "/tmp/openclaw-updated-root",
      channel: "stable",
      requestedChannel: null,
      opts: {},
      pluginInstallRecords: {},
      updateStartedAtMs: 123,
      timeoutMs: 30_000,
    });
    const settled = vi.fn();
    void updating.then(settled, settled);
    try {
      await Promise.race([
        helperStarted.promise,
        updating.then(() => {
          throw new Error("post-core returned before stopping its child");
        }),
      ]);
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      releaseHelper.resolve();
      const result = await updating;
      expect(result).toEqual({ resumed: true, pluginUpdate: { status: "ok" } });
      expect(helperSettled).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      releaseHelper.resolve();
      await Promise.allSettled([updating]);
      platformSpy.mockRestore();
    }
  });

  it.each(["close-before-read", "termination-error"] as const)(
    "preserves a committed post-core result after writer settlement (%s)",
    async (race) => {
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        FRESH_POST_UPDATE_ENTRYPOINT,
      );
      readPackageVersion.mockResolvedValueOnce(null);
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const reading = createDeferred();
      const releaseRead = createDeferred();
      let resultPath: string | undefined;
      const jsonFiles = await import("../infra/json-files.js");
      const read = jsonFiles.readJsonIfExists;
      const pendingReads: Promise<unknown>[] = [];
      const readSpy = vi
        .spyOn(jsonFiles, "readJsonIfExists")
        .mockImplementation(<T>(...args: Parameters<typeof read>) => {
          const pending = read<T>(...args).then(async (value) => {
            if (race === "close-before-read" && args[0] === resultPath) {
              reading.resolve();
              await releaseRead.promise;
            }
            return value;
          });
          pendingReads.push(pending);
          return pending;
        });
      spawn.mockImplementationOnce((_node, _args, options) => {
        resultPath = options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        fsSync.writeFileSync(
          requireValue(resultPath, "committed child result"),
          JSON.stringify({ status: "ok" }),
        );
        if (race === "termination-error") {
          child.kill.mockImplementation(() => {
            queueMicrotask(() => {
              child.emit("exit", 0, null);
              child.emit("close", 0, null);
            });
            throw new Error("signal delivery failed after result commit");
          });
        }
        return child;
      });
      const updating = continuePostCoreUpdateInFreshProcess({
        root: "/tmp/openclaw-updated-root",
        channel: "stable",
        requestedChannel: null,
        opts: {},
        pluginInstallRecords: {},
        updateStartedAtMs: 123,
        timeoutMs: 30_000,
      });
      // Observe a baseline rejection immediately while the race is held open.
      const outcome = updating.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        if (race === "close-before-read") {
          await reading.promise;
          child.emit("exit", null, "SIGTERM");
          child.emit("close", null, "SIGTERM");
          releaseRead.resolve();
        }
        expect(await outcome).toEqual({
          result: { resumed: true, pluginUpdate: { status: "ok" } },
        });
        if (race === "close-before-read") {
          expect(child.kill).not.toHaveBeenCalled();
        }
      } finally {
        releaseRead.resolve();
        await Promise.allSettled([updating, ...pendingReads]);
        readSpy.mockRestore();
      }
    },
  );

  it("honors a committed post-core result when stopping the child delivers a signal", async () => {
    // The poll owns the settle: it stops the child only after claiming the result. Stopping
    // delivers SIGTERM, so an unclaimed exit handler would reject an update the child already
    // committed and then roll its plugin index back.
    const { root } = setupUpdatedRootRefresh({ targetVersion: "2026.4.29" });
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "2026.4.29" : "2026.5.28",
    );
    spawn.mockImplementationOnce((_command: string, _args: string[], options: unknown) => {
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      const resultPath = expectDefined(
        (options as { env: Record<string, string> }).env["OPENCLAW_UPDATE_POST_CORE_RESULT_PATH"],
        "post-core result path test invariant",
      );
      fsSync.writeFileSync(resultPath, JSON.stringify({ status: "ok" }), "utf8");
      child.kill = () => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      };
      return child;
    });

    await expect(updateCommand({ yes: true, restart: false })).resolves.not.toThrow();
  });

  it("keeps a child-committed plugin index when the post-core handoff is signaled", async () => {
    const { root } = setupUpdatedRootRefresh({
      admitMutation: true,
      targetVersion: "2026.4.29",
    });
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "2026.4.29" : "2026.5.28",
    );
    const previousPersistedIndex = {
      policyHash: "previous-policy",
      installRecords: {
        msteams: {
          source: "npm",
          spec: "@openclaw/msteams",
          resolvedVersion: "2026.5.28",
        },
      } satisfies Record<string, PluginInstallRecord>,
    };
    let currentRevision = 17;
    writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: previousPersistedIndex as never,
      revision: currentRevision,
    });
    restorePersistedInstalledPluginIndexIfCurrent.mockImplementation(
      async (_index, expectedRevision) => {
        if (currentRevision !== expectedRevision) {
          return false;
        }
        currentRevision += 1;
        return true;
      },
    );
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(
      previousPersistedIndex.installRecords,
    );
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      currentRevision = 18;
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return child;
    });

    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getErrorOutput()).toContain("post-update process terminated by signal SIGTERM");

    expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      17,
      { lease: expect.anything() },
    );
    expect(currentRevision).toBe(18);
  });
});
