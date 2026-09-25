import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import {
  commandCalls,
  expectNoSideEffects,
  freshRestartCalls,
  gatewayCommandCall,
  gatewayHealthCall,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  callGateway,
  createPreUpdateConfigSnapshotMock,
  pluginAvailabilityPreflight,
  readPackageVersion,
  serviceLoaded,
  serviceRestart,
  serviceStart,
  serviceStop,
} from "./update-cli-mocks.test-support.js";
import {
  clearRestartSentinelIfRevision,
  defaultRuntime,
  doctorCommand,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  readRestartSentinel,
  replaceConfigFile,
  resolveExtendedStablePackage,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonInstall,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    initializeExistingUpdateProfile,
    mockGatewayHealth,
    mockPackageGatewayLifecycle,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeServiceCommand,
    profileStateDir,
    runControlPlaneUpdate,
    setupNpmUpdatedRootRefresh,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  it("writes the control-plane update sentinel after managed package restart health passes", async () => {
    const sentinel = await runControlPlaneUpdate({
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
        note: "Update requested from the agent.",
        continuationMessage: "Check the running version and finish the update report.",
      },
      options: { yes: true, json: true },
      beforeUpdate: () => {
        setupNpmUpdatedRootRefresh();
        serviceLoaded.mockResolvedValue(true);
        mockGatewayHealth("2026.4.24", "updated-gateway");
      },
    });
    expect(sentinel?.payload.status).toBe("ok");
    expect(sentinel?.payload.message).toBe("Update requested from the agent.");
    expect(sentinel?.payload.continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
    expect(sentinel?.payload.stats?.mode).toBe("npm");
    expect(sentinel?.payload.stats?.after?.version).toBe("2026.4.24");
  });

  it("rejects a managed handoff launched from a different canonical install root", async () => {
    const sentinel = await runControlPlaneUpdate({
      meta: {
        root: path.join(process.cwd(), "other-checkout"),
        handoffId: "wrong-root-handoff",
      },
      options: { yes: true, json: true },
    });

    expect(sentinel).toBeNull();
    expect(updateGitCheckout).not.toHaveBeenCalled();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getErrorOutput()).toContain("Managed update handoff root mismatch");
  });

  it("does not write a control-plane sentinel when a dry-run preflight fails", async () => {
    const sentinel = await runControlPlaneUpdate({
      expectedExitCode: 1,
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-dry-run",
        note: "Preview requested from the agent.",
      },
      options: { channel: "extended-stable", dryRun: true, yes: true, json: true },
      beforeUpdate: async () => {
        await mockPackageInstallAtCaseDir();
        vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });

    expect(sentinel).toBeNull();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reports unavailable plugins without refusing the core update (dryRun=%s)",
    async (dryRun) => {
      const detail =
        'Plugin "example" update availability could not be confirmed before core installation.';
      const sentinel = await runControlPlaneUpdate({
        meta: {
          sessionKey: "agent:main:webchat:dm:user-123",
          handoffId: "plugin-admission",
        },
        options: { dryRun, yes: true, json: true },
        beforeUpdate: async () => {
          await mockPackageInstallAtCaseDir();
          pluginAvailabilityPreflight.mockResolvedValue([
            { pluginId: "example", reason: detail, message: detail, guidance: [] },
          ]);
        },
      });

      if (dryRun) {
        expect(lastWriteJsonCall()).toMatchObject({
          dryRun: true,
          notes: expect.arrayContaining([detail]),
        });
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart, replaceConfigFile);
        expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
        expect(packageInstallCommandCall()?.[0]).toBeUndefined();
        expect(sentinel).toBeNull();
      } else {
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "npm" });
        expect(getErrorOutput()).toContain(detail);
        expect(packageInstallCommandCall()?.[0]).toBeDefined();
        expect(sentinel).toMatchObject({ payload: { status: "ok", stats: { mode: "npm" } } });
      }
    },
  );

  it("writes an extended-stable selector failure to the control-plane sentinel", async () => {
    const sentinel = await runControlPlaneUpdate({
      expectedExitCode: 1,
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-handoff",
        note: "Update requested from the agent.",
      },
      options: { channel: "extended-stable", yes: true, json: true },
      beforeUpdate: async () => {
        await mockPackageInstallAtCaseDir();
        vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });
    expect(sentinel?.payload.status).toBe("error");
    expect(sentinel?.payload.stats?.reason).toBe("selector_missing");
    expect(sentinel?.payload.stats?.handoffId).toBe("extended-stable-handoff");
    expect(sentinel?.payload.continuation).toBeUndefined();
  });

  it.each([false, true])(
    "preserves control-plane update sentinel consumption on restart health failure (consumed=%s)",
    async (consumed) => {
      let sentinelConsumed = false;
      const sentinel = await runControlPlaneUpdate({
        expectedExitCode: 1,
        meta: {
          sessionKey: "agent:main:webchat:dm:user-123",
          continuationMessage: "This should not report a successful update.",
        },
        options: { yes: true, json: true },
        beforeUpdate: async () => {
          setupNpmUpdatedRootRefresh();
          serviceLoaded.mockResolvedValue(true);
          mockGatewayHealth("2026.4.23", "old-gateway");
          if (consumed) {
            const respond = expectDefined(callGateway.getMockImplementation(), "health response");
            callGateway.mockImplementation(async (opts) => {
              const current = await readRestartSentinel();
              if (current) {
                sentinelConsumed =
                  (await clearRestartSentinelIfRevision(current.revision)) || sentinelConsumed;
              }
              return respond(opts);
            });
          }
        },
      });
      if (consumed) {
        expect(sentinelConsumed).toBe(true);
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel?.payload.status).toBe("error");
        expect(sentinel?.payload.stats?.reason).toBe("version-mismatch");
        expect(sentinel?.payload.continuation).toBeUndefined();
      }
      expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "version-mismatch" });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps a core update successful when a plugin cannot load (json=%s)",
    async (json) => {
      const { updatedEntrypoint } = setupNpmUpdatedRootRefresh();
      readPackageVersion.mockResolvedValue("2026.4.24");
      serviceLoaded.mockResolvedValue(true);
      mockGatewayHealth("2026.4.23", "previous-gateway");
      const activateGateway = mockPackageGatewayLifecycle();
      const runFixtureCommand = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "package command fixture",
      );
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        const result = await runFixtureCommand(argv, options);
        if (
          result.code === 0 &&
          argv[2] === "gateway" &&
          ["install", "restart"].includes(argv[3] ?? "")
        ) {
          await activateGateway(argv);
          const activatedHealth = requireValue(
            callGateway.getMockImplementation(),
            "activated package health",
          );
          // Keep the identity read from the installed package and add the plugin failure after activation.
          callGateway.mockImplementation(async (request) => {
            await activatedHealth(request);
            return {
              ok: true,
              plugins: {
                errors: [
                  {
                    id: "telegram",
                    origin: "bundled",
                    activated: true,
                    error: "failed to load plugin dependency: ENOSPC",
                  },
                ],
              },
            };
          });
        }
        return result;
      });

      await updateCommand({ yes: true, json });

      expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
      expect(freshRestartCalls()).toHaveLength(0);
      expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      if (json) {
        expect(lastWriteJsonCall()).toMatchObject({
          status: "ok",
          postUpdate: {
            plugins: {
              status: "warning",
              warnings: expect.arrayContaining([
                expect.objectContaining({
                  pluginId: "telegram",
                  reason: "failed to load plugin dependency: ENOSPC",
                  message: expect.stringContaining("could not be loaded"),
                  guidance: ["openclaw doctor --fix"],
                }),
              ]),
            },
          },
        });
      } else {
        expect(getLogOutput()).toContain("Gateway: restarted and verified.");
        expect(getLogOutput()).toContain('Plugin "telegram" could not be loaded.');
        expect(getLogOutput()).toContain("openclaw doctor --fix");
        expect(getLogOutput()).not.toContain("failed to load plugin dependency: ENOSPC");
      }
    },
  );

  it("merges current auth refs with captured service selectors for updated install refresh", async () => {
    const invocationCwd = process.cwd();
    let setup: ReturnType<typeof setupUpdatedRootRefresh> | undefined;
    initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: profileStateDir("personal"),
    });
    initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: profileStateDir("work"),
    });
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_AUTH_TOKEN: undefined,
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir("personal")),
        OPENCLAW_CONFIG_PATH: path.relative(
          invocationCwd,
          path.join(profileStateDir("personal"), "openclaw.json"),
        ),
        PATH: "/caller/bin",
      },
      async () => {
        setup = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async (root) => {
            process.env.OPENCLAW_GATEWAY_AUTH_TOKEN = "runtime-auth-ref";
            return makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
          },
        });
        primeServiceCommand([process.execPath, setup.entrypoints[0], "gateway", "run"], {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir("work")),
          OPENCLAW_CONFIG_PATH: path.relative(
            invocationCwd,
            path.join(profileStateDir("work"), "openclaw.json"),
          ),
          PATH: "/service/bin",
        });

        await updateCommand({});
      },
    );

    const entryPath = expectDefined(setup?.entrypoints[0], "updated entrypoint");
    const installEnv = gatewayCommandCall(entryPath, "install")?.[1].env as
      | NodeJS.ProcessEnv
      | undefined;
    expect(installEnv?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("runtime-auth-ref");
    expect(installEnv?.OPENCLAW_STATE_DIR).toBe(profileStateDir("work"));
    expect(installEnv?.OPENCLAW_CONFIG_PATH).toBe(
      path.join(profileStateDir("work"), "openclaw.json"),
    );
    expect(installEnv?.PATH).toBe("/service/bin");
  });

  it.each([
    {
      name: "updateCommand refreshes service env from updated install root when available",
      invoke: async () => {
        await updateCommand({});
      },
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        // Install already serves the target version; verify that boot without
        // issuing a redundant second restart.
        expect(freshRestartCalls()).toHaveLength(0);
      },
    },
    {
      name: "updateCommand preserves invocation-relative service env overrides during refresh",
      invoke: async () => {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.relative(process.cwd(), profileStateDir()),
            OPENCLAW_CONFIG_PATH: path.relative(
              process.cwd(),
              path.join(profileStateDir(), "openclaw.json"),
            ),
          },
          async () => {
            await updateCommand({});
          },
        );
      },
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: profileStateDir(),
        OPENCLAW_CONFIG_PATH: path.join(profileStateDir(), "openclaw.json"),
      }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand reuses the captured invocation cwd when process.cwd later fails",
      invoke: async () => {
        const originalCwd = process.cwd();
        let restoreCwd: (() => void) | undefined;
        const { root } = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async () => {
            const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
              throw new Error("ENOENT: current working directory is gone");
            });
            restoreCwd = () => cwdSpy.mockRestore();
            return makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
          },
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: path.relative(originalCwd, profileStateDir()),
              OPENCLAW_WORKSPACE_DIR: path.relative(
                originalCwd,
                path.join(profileStateDir(), "workspace"),
              ),
            },
            async () => {
              await updateCommand({});
            },
          );
        } finally {
          restoreCwd?.();
        }
        return { originalCwd };
      },
      customSetup: true,
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: profileStateDir(),
        OPENCLAW_WORKSPACE_DIR: path.join(profileStateDir(), "workspace"),
      }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
  ])("$name", async (testCase) => {
    const setup = testCase.customSetup ? undefined : setupUpdatedRootRefresh();
    await testCase.invoke();
    const root = setup?.root ?? commandCalls()[0]?.[1]?.cwd;
    const entryPath = setup?.entrypoints?.[0] ?? path.join(String(root), "dist", "entry.js");

    const installCall = gatewayCommandCall(entryPath, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([
      entryPath,
      "gateway",
      "install",
      "--force",
      "--port",
      "18789",
      "--json",
      "--update-executor",
      "run",
    ]);
    expect(installCall?.[1].cwd).toBe(String(root));
    expect(installCall?.[1].timeoutMs).toBe(30 * 60_000);
    const expectedEnv =
      "expectedEnv" in testCase && testCase.expectedEnv ? testCase.expectedEnv() : {};
    for (const [key, value] of Object.entries(expectedEnv)) {
      expect((installCall?.[1].env as NodeJS.ProcessEnv | undefined)?.[key]).toBe(value);
    }
    testCase.assertExtra();
  });

  it.each([
    { previous: undefined, mutatesCore: true },
    { previous: "1", mutatesCore: true },
    { previous: "1", mutatesCore: false },
  ])(
    "restores update flag $previous after restart (core mutation: $mutatesCore)",
    async ({ previous, mutatesCore }) => {
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: previous }, async () => {
        const entrypoint = path.join(process.cwd(), "dist", "index.js");
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
        mockRunningManagedGateway(["node", entrypoint, "gateway"]);
        if (mutatesCore) {
          mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
        } else {
          vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts }) => {
            await opts.inspectGitTarget({});
            return makeOkUpdateResult({ root: process.cwd() });
          });
        }
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        expect(doctorCommand).not.toHaveBeenCalled();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe(previous);
        const restartIndex = vi
          .mocked(runCommandWithTimeout)
          .mock.calls.findIndex(([argv]) => argv[2] === "gateway" && argv[3] === "restart");
        const restartOrder = requireValue(
          vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[restartIndex],
          "installed CLI restart call order",
        );
        const snapshotOrders = createPreUpdateConfigSnapshotMock.mock.invocationCallOrder;
        expect(createPreUpdateConfigSnapshotMock).toHaveBeenCalledTimes(1);
        expect(requireValue(snapshotOrders[0], "restart snapshot call order")).toBeLessThan(
          restartOrder,
        );

        const successIndex = vi
          .mocked(defaultRuntime.log)
          .mock.calls.findIndex((call) => String(call[0]).includes("OpenClaw updated"));
        expect(successIndex).toBeGreaterThanOrEqual(0);
        expect(
          vi.mocked(defaultRuntime.log).mock.invocationCallOrder[successIndex],
        ).toBeGreaterThan(restartOrder);
      });
    },
  );

  it("marks the whole update command as update-in-progress", async () => {
    await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
      let observedUpdateEnv: string | undefined;
      vi.mocked(updateGitCheckout).mockImplementationOnce(async () => {
        observedUpdateEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        return makeOkUpdateResult();
      });

      await updateCommand({ restart: false });

      expect(observedUpdateEnv).toBe("1");
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
    });
  });
});
