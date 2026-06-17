import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { ensureAgentAssistedGatewayRuntime } from "./setup.assisted-gateway.js";

const spawn = vi.hoisted(() => vi.fn());
const waitForGatewayReachable = vi.hoisted(() => vi.fn());
const probeGateway = vi.hoisted(() => vi.fn());
const resolveGatewayProgramArguments = vi.hoisted(() => vi.fn());
const killProcessTree = vi.hoisted(() => vi.fn());
const detach = vi.hoisted(() => vi.fn());
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() => vi.fn(() => [] as number[]));
const defaultGatewayBindMode = vi.hoisted(() => vi.fn(() => "loopback"));
const isLoopbackAddress = vi.hoisted(() => vi.fn((host: string) => host === "127.0.0.1"));
const resolveSetupSecretInputString = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  resolveControlUiLinks: () => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  }),
  waitForGatewayReachable,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("../config/paths.js", () => ({
  DEFAULT_GATEWAY_PORT: 18789,
  resolveConfigPath: () => "/tmp/openclaw.json",
}));

vi.mock("../gateway/net.js", () => ({
  defaultGatewayBindMode,
  isLoopbackAddress,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree,
}));

vi.mock("../process/child-process-bridge.js", () => ({
  attachChildProcessBridge: () => ({ detach }),
}));

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
}));

vi.mock("./setup.secret-input.js", () => ({ resolveSetupSecretInputString }));

type MockChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe("agent-assisted Gateway runtime", () => {
  const settings = {
    port: 18789,
    bind: "loopback" as const,
    authMode: "token" as const,
    gatewayToken: "test-token",
    tailscaleMode: "off" as const,
    tailscaleResetOnExit: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    spawn.mockReset();
    waitForGatewayReachable.mockReset();
    probeGateway.mockReset().mockResolvedValue({ ok: false });
    resolveGatewayProgramArguments.mockReset();
    killProcessTree.mockReset();
    detach.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset().mockReturnValue([]);
    resolveSetupSecretInputString
      .mockReset()
      .mockImplementation(async ({ value }: { value?: unknown }) =>
        typeof value === "string" ? value : undefined,
      );
    resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/app/openclaw.mjs", "gateway", "--port", "18789"],
      workingDirectory: "/app",
    });
  });

  it("does not send active auth to an unverified listener before starting a Gateway", async () => {
    resolveGatewayProgramArguments.mockRejectedValueOnce(new Error("program lookup stopped"));

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("program lookup stopped");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it("reuses a verified existing Gateway that accepts the active security settings", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token" },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(findVerifiedGatewayListenerPidsOnPortSync.mock.invocationCallOrder[0]).toBeLessThan(
      probeGateway.mock.invocationCallOrder[0] ?? 0,
    );
    expect(probeGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        auth: { token: "test-token" },
        detailLevel: "full",
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it("reuses a verified existing Gateway whose omitted settings use runtime defaults", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              auth: { mode: "token" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not consume a non-exempt auth failure budget when verifying an existing Gateway", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: {
        path: "/tmp/openclaw.json",
        config: {
          gateway: {
            auth: {
              mode: "token",
              rateLimit: { maxAttempts: 1, exemptLoopback: false },
            },
          },
        },
      },
    });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {
        gateway: {
          auth: {
            mode: "token",
            rateLimit: { maxAttempts: 1, exemptLoopback: false },
          },
        },
      },
      settings,
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(probeGateway).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway listener that does not accept the active auth", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledOnce();
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(findVerifiedGatewayListenerPidsOnPortSync.mock.invocationCallOrder[0]).toBeLessThan(
      probeGateway.mock.invocationCallOrder[0] ?? 0,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway whose runtime settings do not match", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: {
        path: "/tmp/openclaw.json",
        config: {
          gateway: {
            port: 18789,
            bind: "loopback",
            auth: { mode: "token" },
            tailscale: { mode: "serve" },
          },
        },
      },
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified Gateway whose effective allowTailscale policy does not match", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: { mode: "token", allowTailscale: true },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: { gateway: { auth: { mode: "token", allowTailscale: false } } },
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable existing trusted-proxy Gateway", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a verified trusted-proxy Gateway whose proxy policy does not match", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: {
                mode: "trusted-proxy",
                trustedProxy: {
                  userHeader: "x-forwarded-user",
                  allowLoopback: true,
                },
              },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              password: "fallback-password",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                allowLoopback: false,
              },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a verified existing trusted-proxy Gateway with a password fallback", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: {
                mode: "trusted-proxy",
                trustedProxy: { userHeader: "x-forwarded-user" },
              },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: false });

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            password: "fallback-password",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      settings: {
        ...settings,
        authMode: "trusted-proxy",
        gatewayToken: undefined,
      },
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(false);
    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(probeGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ auth: { password: "fallback-password" } }),
    );
    expect(probeGateway.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        auth: { password: expect.stringMatching(/^openclaw-setup-invalid-/) },
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a trusted-proxy Gateway that accepts an invalid fallback password", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4321]);
    probeGateway
      .mockResolvedValueOnce({
        ok: true,
        configSnapshot: {
          path: "/tmp/openclaw.json",
          config: {
            gateway: {
              port: 18789,
              bind: "loopback",
              auth: {
                mode: "trusted-proxy",
                trustedProxy: { userHeader: "x-forwarded-user" },
              },
              tailscale: { mode: "off" },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              password: "fallback-password",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("cannot verify that it matches the active Gateway security settings");

    expect(probeGateway).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts only the temporary trusted-proxy Gateway listener it started", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    waitForGatewayReachable.mockResolvedValueOnce({ ok: false, detail: "trusted proxy required" });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValueOnce([4321]);

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      settings: {
        ...settings,
        authMode: "trusted-proxy",
        gatewayToken: undefined,
      },
      prompter: createWizardPrompter(),
    });

    expect(result.temporary).toBe(true);
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenLastCalledWith(18789);

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;
  });

  it("rejects a temporary trusted-proxy Gateway that exits after binding", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockImplementationOnce(() => {
      child.exitCode = 1;
      return [4321];
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
            },
          },
        },
        settings: {
          ...settings,
          authMode: "trusted-proxy",
          gatewayToken: undefined,
        },
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup");

    expect(waitForGatewayReachable).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("stops waiting when the temporary Gateway exits before binding", async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChild();
      spawn.mockReturnValueOnce(child);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockImplementation(() => {
        child.exitCode = 1;
        return [];
      });

      let settled = false;
      const result = ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(200);
      const settledAfterExit = settled;
      await vi.runAllTimersAsync();

      expect(settledAfterExit).toBe(true);
      await expect(result).resolves.toEqual(
        expect.objectContaining({
          message: expect.stringContaining("exited before listening"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a temporary Gateway when none is reachable", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    waitForGatewayReachable.mockResolvedValueOnce({ ok: true });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    const prompter = createWizardPrompter();

    const result = await ensureAgentAssistedGatewayRuntime({
      config: {},
      settings,
      prompter,
    });

    expect(result.temporary).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/app/openclaw.mjs", "gateway", "--port", "18789"],
      expect.objectContaining({
        cwd: "/app",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(prompter.note).toHaveBeenCalled();
    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledTimes(2);
    expect(findVerifiedGatewayListenerPidsOnPortSync.mock.invocationCallOrder[1]).toBeLessThan(
      waitForGatewayReachable.mock.invocationCallOrder[0] ?? 0,
    );

    const stop = result.stop();
    child.emit("exit", 0, null);
    await stop;

    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("surfaces child spawn failures before probing Gateway readiness", async () => {
    const child = createMockChild();
    child.pid = undefined;
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter: createWizardPrompter(),
      }),
    ).rejects.toThrow("Unable to start Gateway for assisted setup: spawn ENOENT");

    expect(waitForGatewayReachable).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("stops the temporary Gateway when post-spawn setup fails", async () => {
    const child = createMockChild();
    spawn.mockReturnValueOnce(child);
    waitForGatewayReachable.mockResolvedValueOnce({ ok: true });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValue([4321]);
    killProcessTree.mockImplementationOnce(() => queueMicrotask(() => child.emit("exit", 0, null)));
    const prompter = createWizardPrompter({
      note: vi.fn(async () => {
        throw new Error("note failed");
      }),
    });

    await expect(
      ensureAgentAssistedGatewayRuntime({
        config: {},
        settings,
        prompter,
      }),
    ).rejects.toThrow("note failed");

    expect(killProcessTree).toHaveBeenCalledWith(4321, {
      detached: process.platform !== "win32",
      graceMs: 1500,
    });
    expect(detach).toHaveBeenCalledOnce();
  });
});
